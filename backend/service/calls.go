package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"fast_chat/calls"
	"fast_chat/sse"
)

const (
	// callChatTypePrivate is the type of a chat with exactly two
	// participants. A call is only possible in such a chat.
	callChatTypePrivate = "private"
	// callIDKey is the name of the call identifier in the event payloads.
	callIDKey = "callId"
)

var (
	ErrCallNotFound   = errors.New("call not found")
	ErrNotParticipant = errors.New("not a participant of the call")
	ErrNotPrivateChat = errors.New("calls are only possible in a private chat")
	ErrRemoteCallee   = errors.New("federated calls are unavailable")
	ErrEmptyOffer     = errors.New("the offer of a call is empty")
	ErrCallWithSelf   = errors.New("cannot call yourself")
)

// SetCallManager attaches the call registry to the service.
func (s *Service) SetCallManager(manager *calls.Manager) {
	s.calls = manager

	if manager == nil {
		return
	}

	// The registry alone owns the ending of a call and reports it through
	// this callback. The service only delivers the report to the
	// participants: it must not end a call itself, or the participants would
	// receive two reports about the same ending.
	manager.SetOnEnded(func(call calls.Call, reason string) {
		s.notifyEnded(&call, reason)
	})
}

// CallManager returns the call registry.
func (s *Service) CallManager() *calls.Manager {
	return s.calls
}

// StartCall registers a call in a private chat and notifies the callee.
func (s *Service) StartCall(ctx context.Context, callerID, chatID, offer string) (*calls.Call, error) {
	if s.calls == nil {
		return nil, ErrCallNotFound
	}

	if offer == "" {
		return nil, ErrEmptyOffer
	}

	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return nil, ErrCallNotFound
	}

	if chat.Type != callChatTypePrivate || len(chat.Members) != 2 {
		return nil, ErrNotPrivateChat
	}

	callerIsMember := false
	calleeID := ""

	for _, member := range chat.Members {
		if member == callerID {
			callerIsMember = true

			continue
		}

		if calleeID == "" {
			calleeID = member
		}
	}

	if !callerIsMember {
		return nil, ErrNotParticipant
	}

	if calleeID == "" {
		return nil, ErrCallWithSelf
	}

	// A callee from another server cannot be reached: the signaling has no
	// route to that server. The domain is taken from the identifier itself:
	// RemoteServerFromID returns an empty string for a domain the server does
	// not know, and an unknown domain is a remote one, not a local one. A
	// legacy identifier without a domain is local, like in CreatePrivateChat.
	if domain := domainOfUserID(calleeID); domain != "" && domain != s.cfg.Server.Domain {
		return s.startFederatedCall(ctx, callerID, chatID, offer, calleeID, domain)
	}

	call, err := s.calls.CreateCall(callerID, calleeID, chatID, offer)
	if err != nil {
		return nil, err
	}

	s.sendEvent(calleeID, sse.Event{Event: "call_incoming", Data: map[string]any{
		callIDKey:   call.ID,
		"from":      map[string]string{"id": callerID, "nick": s.nickOf(ctx, callerID)},
		"chatId":    chatID,
		"offer":     offer,
		"expiresAt": call.ExpiresAt.Format(time.RFC3339),
	}})

	s.sendCallPush(ctx, call)

	return call, nil
}

// AcceptCall accepts a ringing call. The caller receives the answer, the
// callee receives the identifier only, so the other tabs of the callee can
// close their window. A call owned by another server is forwarded to its
// owner instead: the local side only holds a shadow for it.
func (s *Service) AcceptCall(ctx context.Context, userID, callID, answer string) (*calls.Call, error) {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		if !errors.Is(err, ErrCallNotFound) {
			return nil, err
		}

		return s.acceptFederatedCall(ctx, callID, userID, answer)
	}

	if call.CalleeID != userID {
		return nil, ErrNotParticipant
	}

	accepted, err := s.calls.AcceptCall(callID, answer)
	if err != nil {
		return nil, err
	}

	s.sendEvent(accepted.CallerID, sse.Event{Event: "call_accepted", Data: map[string]any{
		callIDKey: accepted.ID,
		"answer":  answer,
	}})

	s.sendEvent(accepted.CalleeID, sse.Event{Event: "call_accepted", Data: map[string]any{
		callIDKey: accepted.ID,
	}})

	return accepted, nil
}

// RejectCall declines a ringing call. A call owned by another server is
// forwarded to its owner instead.
func (s *Service) RejectCall(ctx context.Context, userID, callID string) error {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		if !errors.Is(err, ErrCallNotFound) {
			return err
		}

		return s.rejectFederatedCall(ctx, callID, userID)
	}

	// The callee rejects: the caller ends the call on its own.
	if call.CalleeID != userID {
		return ErrNotParticipant
	}

	// The registry reports the ending: a call ends with exactly one event.
	if _, err := s.calls.EndCall(callID, calls.ReasonRejected); err != nil {
		return err
	}

	return nil
}

// HangupCall ends a call. The reason may refine the outcome, but the client
// cannot choose it: only peer-left is accepted, everything else is a plain
// hangup. A call owned by another server is forwarded to its owner instead.
func (s *Service) HangupCall(ctx context.Context, userID, callID, reason string) error {
	if _, err := s.participantCall(callID, userID); err != nil {
		if !errors.Is(err, ErrCallNotFound) {
			return err
		}

		return s.hangupFederatedCall(ctx, callID, userID, reason)
	}

	if reason != calls.ReasonPeerLeft {
		reason = calls.ReasonHangup
	}

	// The registry reports the ending: a call ends with exactly one event.
	if _, err := s.calls.EndCall(callID, reason); err != nil {
		return err
	}

	return nil
}

// SendIce forwards an ICE candidate to the other side. The candidate is
// passed on unchanged: the browser of the other side adds it to its own
// connection. Candidates for an ended (or unknown) call are rejected: the
// peer's connection is closed and would choke on them. A candidate for a call
// owned by another server is forwarded to its owner instead.
func (s *Service) SendIce(ctx context.Context, userID, callID string, candidate json.RawMessage) error {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		if !errors.Is(err, ErrCallNotFound) {
			return err
		}

		return s.iceFederatedCall(ctx, callID, userID, candidate)
	}

	if call.State == calls.StateEnded {
		return ErrCallNotFound
	}

	peer := call.Peer(userID)

	s.sendEvent(peer, sse.Event{Event: "call_ice", Data: map[string]any{
		callIDKey:   call.ID,
		"candidate": candidate,
	}})

	// A peer on another server is not on the local hub: forward the
	// candidate to the owning side best-effort, like HandleFederatedIce
	// does for federated candidates.
	if remote := domainOfUserID(peer); remote != "" && s.cfg != nil && remote != s.cfg.Server.Domain && s.fed != nil {
		body := map[string]any{"callId": call.ID, "candidate": candidate}

		if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(remote, "/api/federated/calls/"+call.ID+"/ice"), body); err != nil {
			log().Warn("federated ice forward failed", "callID", call.ID, "err", err)
		}
	}

	return nil
}

// CurrentCall returns the call the user is in, or the last one. A federated
// call owned by another server is reported as a ringing shadow with the
// offer, so a reloaded client can reconcile it like a local ringing call.
func (s *Service) CurrentCall(_ context.Context, userID string) (*calls.Call, bool) {
	if s.calls == nil {
		return nil, false
	}

	if call, ok := s.calls.Current(userID); ok {
		return call, true
	}

	shadow, ok := s.calls.CurrentFederated(userID)
	if !ok {
		return nil, false
	}

	return &calls.Call{
		ID:        shadow.CallID,
		CallerID:  shadow.CallerID,
		CalleeID:  shadow.CalleeID,
		ChatID:    shadow.ChatID,
		State:     calls.StateRinging,
		Offer:     shadow.Offer,
		ExpiresAt: shadow.ExpiresAt,
	}, true
}

// participantCall loads a call and checks that the user takes part in it.
func (s *Service) participantCall(callID, userID string) (*calls.Call, error) {
	if s.calls == nil {
		return nil, ErrCallNotFound
	}

	call, ok := s.calls.Get(callID)
	if !ok {
		return nil, ErrCallNotFound
	}

	if !call.Participant(userID) {
		return nil, ErrNotParticipant
	}

	return call, nil
}

// notifyEnded tells both sides that the call is over. When one side lives on
// another server, the report is also forwarded there best-effort: a call that
// ends by timeout or ActiveTTL has no client hangup to forward, so without
// this the proxy side would ring until its own expiry.
func (s *Service) notifyEnded(call *calls.Call, reason string) {
	data := map[string]any{callIDKey: call.ID, "reason": reason}

	s.sendEvent(call.CallerID, sse.Event{Event: "call_ended", Data: data})
	s.sendEvent(call.CalleeID, sse.Event{Event: "call_ended", Data: data})

	s.forwardEndedToRemote(call, reason)
}

// forwardEndedToRemote reports a locally ended call to the remote side, if
// any. Failures only warn: the local events above are already delivered, and
// the proxy expires the shadow on its own.
func (s *Service) forwardEndedToRemote(call *calls.Call, reason string) {
	if s == nil || s.cfg == nil || s.fed == nil {
		return
	}

	seen := make(map[string]struct{}, 1)

	for _, id := range []string{call.CallerID, call.CalleeID} {
		d := domainOfUserID(id)
		if d == "" || d == s.cfg.Server.Domain {
			continue
		}

		if _, dup := seen[d]; dup {
			continue
		}

		seen[d] = struct{}{}

		body := map[string]any{"callId": call.ID, "reason": reason}

		if _, err := s.fed.Request(context.Background(), http.MethodPost, s.fed.URL(d, "/api/federated/calls/"+call.ID+"/ended"), body); err != nil {
			log().Warn("federated ended report failed", "callID", call.ID, "err", err)
		}
	}
}

// domainOfUserID returns the server part of a user identifier ("nick:domain").
func domainOfUserID(userID string) string {
	_, domain, found := strings.Cut(userID, ":")
	if !found {
		return ""
	}

	return domain
}

// nickOf returns the display name of a user, or the identifier when the user
// is unknown.
func (s *Service) nickOf(ctx context.Context, userID string) string {
	user, ok := s.store.GetUserByID(ctx, userID)
	if !ok {
		return userID
	}

	return user.Nick
}

// callPushPayload is the notification body for an incoming call.
type callPushPayload struct {
	Title string       `json:"title"`
	Tag   string       `json:"tag"`
	Data  callPushData `json:"data"`
}

type callPushData struct {
	CallID   string `json:"callId"`
	ChatID   string `json:"chatId"`
	FromID   string `json:"fromId"`
	FromNick string `json:"fromNick"`
}

// sendCallPush notifies an offline callee. Every call gets its own tag, so
// two calls in a row do not collapse into one notification.
func (s *Service) sendCallPush(ctx context.Context, call *calls.Call) {
	if s.push == nil || s.store.IsOnline(call.CalleeID) {
		return
	}

	subs, err := s.store.GetPushSubscriptionsByUser(ctx, call.CalleeID)
	if err != nil || len(subs) == 0 {
		return
	}

	fromNick := s.nickOf(ctx, call.CallerID)

	payload, err := json.Marshal(callPushPayload{
		Title: fromNick,
		Tag:   "call-" + call.ID,
		Data: callPushData{
			CallID:   call.ID,
			ChatID:   call.ChatID,
			FromID:   call.CallerID,
			FromNick: fromNick,
		},
	})
	if err != nil {
		return
	}

	sendPushBounded(s.push, payload, subs)
}
