package transport

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
	"fast_chat/store"
)

// msgRemoteServerMismatch is the federated peer check: the body or the call
// topology names a server other than the verified sender.
const msgRemoteServerMismatch = "remote server mismatch"

// registerFederatedCalls registers the server-to-server call signaling
// operations. Like the other federated operations they are guarded by the
// federation signature scheme: the sender is the verified remote server,
// never a local user.
func registerFederatedCalls(api huma.API, st *store.Store, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-call-invite",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/invite",
		Summary:     "Receive a call invite from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallInviteInput) (*statusOutput, error) {
		server := federatedServerFromContext(ctx)
		if server == "" || input.Body.RemoteServer != server {
			return nil, &statusError{ErrorMessage: msgRemoteServerMismatch, code: http.StatusForbidden}
		}

		// The chat must exist and belong to the sending server: otherwise the
		// invite names nobody, or a peer this server never federated with. A
		// missing chat is a 403, not a 404, so a signed peer cannot probe
		// which chats exist.
		chat, ok := st.GetChat(ctx, input.Body.ChatID)
		if !ok {
			return nil, &statusError{ErrorMessage: msgChatNotFound, code: http.StatusForbidden}
		}

		if chat.RemoteServer != server {
			return nil, &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
		}

		inviteErr := svc.HandleFederatedInvite(ctx, server, input.Body.CallID, input.Body.ChatID,
			input.Body.CallerID, input.Body.CalleeID, input.Body.Offer, input.Body.IceServers)
		if inviteErr != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(inviteErr))
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-call-accept",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/{id}/accept",
		Summary:     "Receive a call acceptance from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallAcceptInput) (*statusOutput, error) {
		if _, err := federatedCallSender(svc, input.ID, federatedServerFromContext(ctx)); err != nil {
			return nil, err
		}

		if err := svc.HandleFederatedAccept(ctx, input.ID, input.Body.Answer, input.Body.IceServers); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-call-reject",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/{id}/reject",
		Summary:     "Receive a call rejection from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallRejectInput) (*statusOutput, error) {
		if _, err := federatedCallSender(svc, input.ID, federatedServerFromContext(ctx)); err != nil {
			return nil, err
		}

		if err := svc.HandleFederatedReject(ctx, input.ID); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-call-hangup",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/{id}/hangup",
		Summary:     "Receive a call hangup from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallHangupInput) (*statusOutput, error) {
		if _, err := federatedCallSender(svc, input.ID, federatedServerFromContext(ctx)); err != nil {
			return nil, err
		}

		if err := svc.HandleFederatedHangup(ctx, input.ID, input.Body.Reason); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-call-ice",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/{id}/ice",
		Summary:     "Receive an ICE candidate from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallICEInput) (*statusOutput, error) {
		// The wire body carries no sender: the signer is the other side of
		// the call, so the sending user is inferred from the call topology.
		from, err := federatedCallSender(svc, input.ID, federatedServerFromContext(ctx))
		if err != nil {
			return nil, err
		}

		if err := svc.HandleFederatedIce(ctx, input.ID, from, input.Body.Candidate); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-call-ended",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/{id}/ended",
		Summary:     "Receive a call end report from the owning server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCallEndedInput) (*statusOutput, error) {
		if _, err := federatedCallSender(svc, input.ID, federatedServerFromContext(ctx)); err != nil {
			return nil, err
		}

		// Ended is idempotent: a retry after the shadow is gone still answers
		// ok, so the owner stops reporting.
		if err := svc.HandleFederatedEnded(ctx, input.ID, input.Body.Reason); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}

		return okStatus(), nil
	})
}

// federatedCallSender verifies the request comes from the server on the other
// side of the call and reports which user sent it: the caller when this server
// only keeps a shadow (the owner speaks), the callee when this server owns the
// call (the proxy speaks). Unknown calls pass through with an empty sender so
// the service answers 410 Gone instead of the transport guessing.
func federatedCallSender(svc *service.Service, callID, server string) (string, error) {
	if server == "" {
		return "", &statusError{ErrorMessage: msgRemoteServerMismatch, code: http.StatusForbidden}
	}

	mgr := svc.CallManager()
	if mgr == nil {
		return "", nil
	}

	if shadow, ok := mgr.GetFederated(callID); ok {
		if shadow.Owner != server {
			return "", &statusError{ErrorMessage: msgRemoteServerMismatch, code: http.StatusForbidden}
		}

		return shadow.CallerID, nil
	}

	if call, ok := mgr.Get(callID); ok {
		if !service.UserIDBelongsToServer(call.CallerID, server) && !service.UserIDBelongsToServer(call.CalleeID, server) {
			return "", &statusError{ErrorMessage: msgRemoteServerMismatch, code: http.StatusForbidden}
		}

		return call.CalleeID, nil
	}

	return "", nil
}

type federatedCallInviteInput struct {
	Body struct {
		RemoteServer string `json:"remoteServer"`
		CallID       string `json:"callId"`
		ChatID       string `json:"chatId"`
		CallerID     string `json:"callerId"`
		CalleeID     string `json:"calleeId"`
		Offer        string `json:"offer"`
		IceServers   any    `json:"iceServers,omitempty"`
	}
}

type federatedCallAcceptInput struct {
	ID   string `path:"id"`
	Body struct {
		Answer     string `json:"answer"`
		IceServers any    `json:"iceServers,omitempty"`
	}
}

type federatedCallRejectInput struct {
	ID   string `path:"id"`
	Body struct {
		Reason string `json:"reason,omitempty"`
	}
}

type federatedCallHangupInput struct {
	ID   string `path:"id"`
	Body struct {
		Reason string `json:"reason,omitempty"`
	}
}

type federatedCallICEInput struct {
	ID   string `path:"id"`
	Body struct {
		Candidate json.RawMessage `json:"candidate"`
	}
}

type federatedCallEndedInput struct {
	ID   string `path:"id"`
	Body struct {
		Reason string `json:"reason,omitempty"`
	}
}
