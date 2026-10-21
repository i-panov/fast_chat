package service

import (
	"context"
	"encoding/json"
	"errors"
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
	ErrRemoteCallee   = errors.New("calls between servers are not supported")
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
	// not know, and an unknown domain is a remote one, not a local one.
	if domain := domainOfUserID(calleeID); domain != s.cfg.Server.Domain {
		return nil, ErrRemoteCallee
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
// close their window.
func (s *Service) AcceptCall(_ context.Context, userID, callID, answer string) (*calls.Call, error) {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		return nil, err
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

// RejectCall declines a ringing call.
func (s *Service) RejectCall(_ context.Context, userID, callID string) error {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		return err
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
// hangup.
func (s *Service) HangupCall(_ context.Context, userID, callID, reason string) error {
	if _, err := s.participantCall(callID, userID); err != nil {
		return err
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

// SendIce forwards an ICE candidate to the other side.
func (s *Service) SendIce(_ context.Context, userID, callID, candidate string) error {
	call, err := s.participantCall(callID, userID)
	if err != nil {
		return err
	}

	s.sendEvent(call.Peer(userID), sse.Event{Event: "call_ice", Data: map[string]any{
		callIDKey:   call.ID,
		"candidate": candidate,
	}})

	return nil
}

// CurrentCall returns the call the user is in, or the last one.
func (s *Service) CurrentCall(_ context.Context, userID string) (*calls.Call, bool) {
	if s.calls == nil {
		return nil, false
	}

	return s.calls.Current(userID)
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

// notifyEnded tells both sides that the call is over.
func (s *Service) notifyEnded(call *calls.Call, reason string) {
	data := map[string]any{callIDKey: call.ID, "reason": reason}

	s.sendEvent(call.CallerID, sse.Event{Event: "call_ended", Data: data})
	s.sendEvent(call.CalleeID, sse.Event{Event: "call_ended", Data: data})
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

	go s.push.SendToUser(payload, subs)
}
