package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"fast_chat/calls"
	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/turn"
	"fast_chat/sse"
)

// startFederatedCall starts a call whose callee lives on another server. The
// local manager owns the call; the remote server only keeps an ephemeral
// shadow (see calls.TryReserveFederated) and fans the invite out to its
// callee. A failed invite ends the locally created call right away, so the
// caller does not stay busy in a call the peer never heard about.
func (s *Service) startFederatedCall(ctx context.Context, callerID, chatID, offer, calleeID, remote string) (*calls.Call, error) {
	if s.fed == nil {
		return nil, ErrRemoteCallee
	}

	call, err := s.calls.CreateCall(callerID, calleeID, chatID, offer)
	if err != nil {
		return nil, err
	}

	body := map[string]any{
		"callId":      call.ID,
		keyChatID:     chatID,
		"callerId":    callerID,
		"calleeId":    calleeID,
		keyOffer:      offer,
		keyIceServers: s.localICE(callerID),
		// The transport names the sender explicitly and huma requires every
		// field without omitempty: without our domain the invite is a 422.
		// StartCall has already dereferenced the config to pick the federated
		// path, so the domain is always known here.
		"remoteServer": s.cfg.Server.Domain,
	}

	if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(remote, "/api/federated/calls/invite"), body); err != nil {
		// The invite failed: ending the attempted registration is the cleanup,
		// and its own error cannot change the answer of the operation.
		_, _ = s.calls.EndCall(call.ID, calls.ReasonHangup) //nolint:errcheck // best-effort cleanup

		// The peer answers with the same statuses the local transport uses:
		// a busy callee is a conflict, a missing chat means the invite
		// reached nobody.
		statusErr, ok := errors.AsType[*federation.StatusError](err)
		if ok {
			switch statusErr.Status {
			case http.StatusConflict:
				return nil, calls.ErrBusyCallee
			case http.StatusNotFound, http.StatusGone:
				return nil, ErrCallNotFound
			}
		}

		return nil, err
	}

	return call, nil
}

// localICE returns the ICE servers of this server for a federated invite or
// answer. A relay with the secret of the TURN REST API gets short-lived
// credentials minted for the given user (see transport.iceServers), so the
// secret itself never leaves the server. A relay with static credentials is
// handed over as configured. The result serializes as
// ICEConfig{stun,turn[{urls,username,credential}]}: TURNServer.Secret has no
// JSON name.
func (s *Service) localICE(userID string) map[string]any {
	stun := []string{}
	turnServers := []config.TURNServer{}

	if s != nil && s.cfg != nil {
		stun = s.cfg.ICE.STUN
		if stun == nil {
			stun = []string{}
		}

		for _, server := range s.cfg.ICE.TURN {
			if server.Secret == "" {
				turnServers = append(turnServers, config.TURNServer{
					URLs:       server.URLs,
					Username:   server.Username,
					Credential: server.Credential,
				})

				continue
			}

			credentials := turn.Generate(server.Secret, userID, time.Now())
			turnServers = append(turnServers, config.TURNServer{
				URLs:       server.URLs,
				Username:   credentials.Username,
				Credential: credentials.Credential,
			})
		}
	}

	return map[string]any{"stun": stun, "turn": turnServers}
}

// federatedInviteEvent is the payload of a call_incoming event for a call
// owned by another server. The owner field tells whose registry holds the
// call; the local side only keeps a shadow for it.
func (s *Service) federatedInviteEvent(
	ctx context.Context,
	owner, callID, chatID, callerID, offer string,
	iceServers any,
	expiresAt time.Time,
) sse.Event {

	data := map[string]any{
		callIDKey:   callID,
		"from":      map[string]string{"id": callerID, "nick": s.nickOf(ctx, callerID)},
		keyChatID:   chatID,
		keyOffer:    offer,
		"expiresAt": expiresAt.Format(time.RFC3339),
		"federated": true,
		"owner":     owner,
	}

	// A missing ICE config stays missing on the wire: an explicit null
	// would fail the strict client guard and drop the incoming call.
	if iceServers != nil {
		data[keyIceServers] = iceServers
	}

	return sse.Event{Event: eventCallIncoming, Data: data}
}

// HandleFederatedInvite reserves the local callee for an inbound federated
// call and notifies them. A repeated invite for the same call re-sends the
// notification instead of failing: the owner retries until it gets a 200.
// A genuinely conflicting reservation stays a busy-callee rejection.
func (s *Service) HandleFederatedInvite(ctx context.Context, owner, callID, chatID, callerID, calleeID, offer string, iceServers any) error {
	if offer == "" {
		return ErrEmptyOffer
	}

	if err := calls.ValidateOffer(offer); err != nil {
		return err
	}

	// The invite must come from the server it claims to: the caller lives
	// on the owner side, and the callee must be local (a legacy identifier
	// without a domain counts as local). Otherwise a signed peer could
	// ring a user on a third server or spoof the caller.
	if s.cfg != nil {
		if domainOfUserID(callerID) != owner {
			return ErrNotParticipant
		}

		if d := domainOfUserID(calleeID); d != "" && d != s.cfg.Server.Domain {
			return ErrNotParticipant
		}
	}

	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ErrCallNotFound
	}

	if chat.Type != callChatTypePrivate {
		return ErrNotPrivateChat
	}

	if !containsMember(chat.Members, callerID) || !containsMember(chat.Members, calleeID) {
		return ErrNotParticipant
	}

	if existing, ok := s.calls.GetFederated(callID); ok {
		sameCall := existing.Owner == owner && existing.ChatID == chatID &&
			existing.CallerID == callerID && existing.CalleeID == calleeID

		if sameCall {
			s.sendEvent(calleeID, s.federatedInviteEvent(ctx, owner, callID, chatID, callerID, offer, iceServers, existing.ExpiresAt))

			return nil
		}

		return calls.ErrBusyCallee
	}

	if err := s.calls.TryReserveFederated(callID, owner, chatID, callerID, calleeID, offer); err != nil {
		return err
	}

	shadow, ok := s.calls.GetFederated(callID)
	if !ok {
		return ErrCallNotFound
	}

	s.sendEvent(calleeID, s.federatedInviteEvent(ctx, owner, callID, chatID, callerID, offer, iceServers, shadow.ExpiresAt))
	s.sendCallPush(ctx, &calls.Call{ID: callID, CallerID: callerID, CalleeID: calleeID, ChatID: chatID})

	return nil
}

// HandleFederatedAccept accepts the owned call with the answer the peer
// sent, tells the local caller, and reports the acceptance back to the proxy
// so it can close the ringing window on its side. On the proxy side the same
// handler delivers the owner's report to the local callee.
func (s *Service) HandleFederatedAccept(ctx context.Context, callID, answer string, iceServers any) error {
	if call, ok := s.calls.Get(callID); ok {
		accepted, err := s.calls.AcceptCall(callID, answer)
		if err != nil {
			return err
		}

		acceptedData := map[string]any{
			callIDKey: accepted.ID,
			keyAnswer: answer,
		}

		if iceServers != nil {
			acceptedData[keyIceServers] = iceServers
		}

		s.sendEvent(accepted.CallerID, sse.Event{Event: eventCallAccepted, Data: acceptedData})

		s.sendEvent(accepted.CalleeID, sse.Event{Event: eventCallAccepted, Data: map[string]any{
			callIDKey: accepted.ID,
		}})

		if remote := domainOfUserID(call.CalleeID); remote != "" && s.fed != nil {
			body := map[string]any{keyAnswer: answer, keyIceServers: s.localICE(call.CalleeID)}

			if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(remote, "/api/federated/calls/"+callID+"/accept"), body); err != nil {
				log().Warn("federated accepted report failed", "callID", callID, "err", err)
			}
		}

		return nil
	}

	if shadow, ok := s.calls.GetFederated(callID); ok {
		// The call is active now: keep the shadow for the whole active
		// window, or the owner report about its end would find nothing.
		s.calls.ExtendFederated(callID, calls.ActiveTTL)

		acceptedData := map[string]any{callIDKey: callID}

		if iceServers != nil {
			acceptedData[keyIceServers] = iceServers
		}

		s.sendEvent(shadow.CalleeID, sse.Event{Event: eventCallAccepted, Data: acceptedData})

		return nil
	}

	return ErrCallNotFound
}

// HandleFederatedHangup ends the owned call; the registry forwards the end
// report to the proxy through notifyEnded, so both sides get exactly one
// event. The shadow branch is defensive: the transport infers the caller as
// the signer on the proxy side, while a local hangup goes through
// hangupFederatedCall. The branch still forwards to the owner, whose ended
// report notifies the callee, should that inference ever change.
func (s *Service) HandleFederatedHangup(ctx context.Context, callID, reason string) error {
	if reason != calls.ReasonPeerLeft {
		reason = calls.ReasonHangup
	}

	if _, ok := s.calls.Get(callID); ok {
		if _, err := s.calls.EndCall(callID, reason); err != nil {
			return err
		}

		// The registry reports the ending: EndCall triggers onEnded, and
		// notifyEnded forwards it to the proxy, so no explicit report here.

		return nil
	}

	if shadow, ok := s.calls.GetFederated(callID); ok {
		// Defensive: the federated signer of a shadow is its caller, not the
		// local callee, so the current protocol never lands in this branch.
		if s.fed == nil {
			return ErrRemoteCallee
		}

		body := map[string]any{keyReason: reason}

		_, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(shadow.Owner, "/api/federated/calls/"+callID+"/hangup"), body)

		return err
	}

	return ErrCallNotFound
}

// HandleFederatedReject declines the owned call; the registry forwards the
// end report to the proxy through notifyEnded. The shadow branch is
// defensive for the same reason as in HandleFederatedHangup: the local
// callee's rejection goes through rejectFederatedCall.
func (s *Service) HandleFederatedReject(ctx context.Context, callID string) error {
	if _, ok := s.calls.Get(callID); ok {
		if _, err := s.calls.EndCall(callID, calls.ReasonRejected); err != nil {
			return err
		}

		// The registry reports the ending through onEnded like above.

		return nil
	}

	if shadow, ok := s.calls.GetFederated(callID); ok {
		// Defensive: the federated signer of a shadow is its caller, not the
		// local callee, so the current protocol never lands in this branch.
		if s.fed == nil {
			return ErrRemoteCallee
		}

		// The reject input carries no required fields: the call rides in the
		// path, and huma rejects unknown properties.
		_, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(shadow.Owner, "/api/federated/calls/"+callID+"/reject"), map[string]any{})

		return err
	}

	return ErrCallNotFound
}

// HandleFederatedIce delivers an ICE candidate to the other side. On the
// owner side the candidate goes to the local peer and, when that peer is
// remote, on to the proxy. On the proxy side the transport infers the caller
// as the signer, so a candidate from the owner is delivered to the local
// callee. Forwarding a candidate from the callee to the owner is defensive:
// local candidates already go through iceFederatedCall.
func (s *Service) HandleFederatedIce(ctx context.Context, callID, fromID string, candidate json.RawMessage) error {
	if err := calls.ValidateICECandidate(candidate); err != nil {
		return err
	}

	if call, ok := s.calls.Get(callID); ok {
		if !call.Participant(fromID) {
			return ErrNotParticipant
		}

		peer := call.Peer(fromID)

		s.sendEvent(peer, sse.Event{Event: eventCallICE, Data: map[string]any{
			callIDKey:    call.ID,
			keyCandidate: candidate,
		}})

		if remote := domainOfUserID(peer); remote != "" && remote != s.cfg.Server.Domain && s.fed != nil {
			body := map[string]any{keyCandidate: candidate}

			if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(remote, "/api/federated/calls/"+callID+"/ice"), body); err != nil {
				log().Warn("federated ice forward failed", "callID", callID, "err", err)
			}
		}

		return nil
	}

	if shadow, ok := s.calls.GetFederated(callID); ok {
		if fromID == shadow.CalleeID {
			// Defensive: the federated signer of a shadow is its caller, so
			// the current protocol never forwards from here.
			if s.fed == nil {
				return ErrRemoteCallee
			}

			body := map[string]any{keyCandidate: candidate}

			_, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(shadow.Owner, "/api/federated/calls/"+callID+"/ice"), body)

			return err
		}

		s.sendEvent(shadow.CalleeID, sse.Event{Event: eventCallICE, Data: map[string]any{
			callIDKey:    callID,
			keyCandidate: candidate,
		}})

		return nil
	}

	return ErrCallNotFound
}

// HandleFederatedEnded drops the shadow of a call the owner finished and
// tells the local callee. A repeated report is a no-op: the first one
// already removed the shadow.
func (s *Service) HandleFederatedEnded(_ context.Context, callID, reason string) error {
	shadow, ok := s.calls.GetFederated(callID)

	s.calls.RemoveFederated(callID)

	if !ok {
		return nil
	}

	s.sendEvent(shadow.CalleeID, sse.Event{Event: eventCallEnded, Data: map[string]any{
		callIDKey: callID,
		keyReason: reason,
	}})

	return nil
}

// containsMember reports whether the chat members hold the given user.
func containsMember(members []string, userID string) bool {
	return slices.Contains(members, userID)
}

// proxyShadow loads the federated shadow of a call the local registry does
// not own. It reports ErrCallNotFound when there is no shadow and
// ErrNotParticipant when the user is not its callee: on the proxy side only
// the callee is local, the caller lives on the owner server.
func (s *Service) proxyShadow(callID, userID string) (*calls.FederatedInbound, error) {
	if s.calls == nil {
		return nil, ErrCallNotFound
	}

	shadow, ok := s.calls.GetFederated(callID)
	if !ok {
		return nil, ErrCallNotFound
	}

	if shadow.CalleeID != userID {
		return nil, ErrNotParticipant
	}

	return shadow, nil
}

// federatedNotFound reports whether err is a permanent "no such call" answer
// of the owner: a gone call on the owner side means the local shadow is
// stale and must go.
func federatedNotFound(err error) bool {
	var statusErr *federation.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}

	return statusErr.Status == http.StatusNotFound || statusErr.Status == http.StatusGone
}

// proxyOwner refuses the forward when the shadow points back at this server:
// the call would bounce between the federated handlers forever. A shadow
// whose owner is local is stale: the local registry would hold the call.
func (s *Service) proxyOwner(shadow *calls.FederatedInbound) (string, bool) {
	if s.cfg == nil {
		return "", false
	}

	if shadow.Owner == s.cfg.Server.Domain {
		return "", false
	}

	return shadow.Owner, true
}

// acceptFederatedCall accepts a call owned by another server. The answer goes
// to the owner; the local side changes nothing and waits for the owner's
// accepted report (see HandleFederatedAccept), which notifies the callee.
func (s *Service) acceptFederatedCall(ctx context.Context, callID, userID, answer string) (*calls.Call, error) {
	shadow, err := s.proxyShadow(callID, userID)
	if err != nil {
		return nil, err
	}

	if err := calls.ValidateAnswer(answer); err != nil {
		return nil, err
	}

	if s.fed == nil {
		return nil, ErrRemoteCallee
	}

	owner, ok := s.proxyOwner(shadow)
	if !ok {
		return nil, ErrCallNotFound
	}

	body := map[string]any{keyAnswer: answer, keyIceServers: s.localICE(userID)}

	if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(owner, "/api/federated/calls/"+callID+"/accept"), body); err != nil {
		if federatedNotFound(err) {
			s.calls.RemoveFederated(callID)

			return nil, ErrCallNotFound
		}

		log().Warn("federated accept forward failed", "callID", callID, "err", err)

		return nil, err
	}

	return &calls.Call{
		ID:       shadow.CallID,
		CallerID: shadow.CallerID,
		CalleeID: shadow.CalleeID,
		ChatID:   shadow.ChatID,
		State:    calls.StateActive,
		Answer:   answer,
	}, nil
}

// rejectFederatedCall declines a call owned by another server. The rejection
// goes to the owner; the local side changes nothing and waits for the owner's
// ended report (see HandleFederatedEnded), which notifies the callee.
func (s *Service) rejectFederatedCall(ctx context.Context, callID, userID string) error {
	shadow, err := s.proxyShadow(callID, userID)
	if err != nil {
		return err
	}

	if s.fed == nil {
		return ErrRemoteCallee
	}

	owner, ok := s.proxyOwner(shadow)
	if !ok {
		return ErrCallNotFound
	}

	// The reject input carries no required fields: the call rides in the
	// path, and huma rejects unknown properties.
	if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(owner, "/api/federated/calls/"+callID+"/reject"), map[string]any{}); err != nil {
		if federatedNotFound(err) {
			s.calls.RemoveFederated(callID)

			return ErrCallNotFound
		}

		log().Warn("federated reject forward failed", "callID", callID, "err", err)

		return err
	}

	return nil
}

// hangupFederatedCall ends a call owned by another server. The hangup goes to
// the owner; the local side changes nothing and waits for the owner's ended
// report (see HandleFederatedEnded), so both sides get exactly one event.
func (s *Service) hangupFederatedCall(ctx context.Context, callID, userID, reason string) error {
	shadow, err := s.proxyShadow(callID, userID)
	if err != nil {
		return err
	}

	if reason != calls.ReasonPeerLeft {
		reason = calls.ReasonHangup
	}

	if s.fed == nil {
		return ErrRemoteCallee
	}

	owner, ok := s.proxyOwner(shadow)
	if !ok {
		return ErrCallNotFound
	}

	body := map[string]any{keyReason: reason}

	if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(owner, "/api/federated/calls/"+callID+"/hangup"), body); err != nil {
		if federatedNotFound(err) {
			s.calls.RemoveFederated(callID)

			return ErrCallNotFound
		}

		log().Warn("federated hangup forward failed", "callID", callID, "err", err)

		return err
	}

	return nil
}

// iceFederatedCall passes a local ICE candidate to the owner of the call.
// Nothing is delivered locally: the only local participant is the sender.
func (s *Service) iceFederatedCall(ctx context.Context, callID, userID string, candidate json.RawMessage) error {
	shadow, err := s.proxyShadow(callID, userID)
	if err != nil {
		return err
	}

	if err := calls.ValidateICECandidate(candidate); err != nil {
		return err
	}

	if s.fed == nil {
		return ErrRemoteCallee
	}

	owner, ok := s.proxyOwner(shadow)
	if !ok {
		return ErrCallNotFound
	}

	body := map[string]any{keyCandidate: candidate}

	if _, err := s.fed.Request(ctx, http.MethodPost, s.fed.URL(owner, "/api/federated/calls/"+callID+"/ice"), body); err != nil {
		if federatedNotFound(err) {
			s.calls.RemoveFederated(callID)

			return ErrCallNotFound
		}

		log().Warn("federated ice forward failed", "callID", callID, "err", err)

		return err
	}

	return nil
}
