package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/calls"
	"fast_chat/service"
)

// RegisterCalls adds the endpoints of the call domain.
func RegisterCalls(api huma.API, svc *service.Service) {
	registerStartCall(api, svc)
	registerAcceptCall(api, svc)
	registerCallAction(api, svc)
	registerCurrentCall(api, svc)
}

// registerStartCall adds the operation that starts a call.
func registerStartCall(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "start-call",
		Method:      http.MethodPost,
		Path:        "/api/calls",
		Summary:     "Start a call in a private chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *startCallInput) (*callOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		call, err := svc.StartCall(ctx, user.ID, input.Body.ChatID, input.Body.Offer)
		if err != nil {
			return nil, mapServerError(err)
		}

		out := &callOutput{}
		out.Status = http.StatusCreated
		out.Body.CallID = call.ID
		out.Body.State = string(call.State)

		return out, nil
	})
}

// registerAcceptCall adds the operation that accepts a call.
func registerAcceptCall(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "accept-call",
		Method:      http.MethodPost,
		Path:        "/api/calls/{id}/accept",
		Summary:     "Accept a ringing call",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *acceptCallInput) (*callOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		call, err := svc.AcceptCall(ctx, user.ID, input.ID, input.Body.Answer)
		if err != nil {
			return nil, mapServerError(err)
		}

		out := &callOutput{}
		out.Body.CallID = call.ID
		out.Body.State = string(call.State)

		return out, nil
	})
}

// registerCallAction adds the operations that end a call or pass an ICE
// candidate. They share the same shape, so they share the handler.
func registerCallAction(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "reject-call",
		Method:      http.MethodPost,
		Path:        "/api/calls/{id}/reject",
		Summary:     "Reject a ringing call",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *callIDInput) (*statusOutput, error) {
		return callAction(ctx, func(userID string) error {
			return svc.RejectCall(ctx, userID, input.ID)
		})
	})

	huma.Register(api, huma.Operation{
		OperationID: "hangup-call",
		Method:      http.MethodPost,
		Path:        "/api/calls/{id}/hangup",
		Summary:     "End a call",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *hangupCallInput) (*statusOutput, error) {
		return callAction(ctx, func(userID string) error {
			return svc.HangupCall(ctx, userID, input.ID, input.Body.Reason)
		})
	})

	huma.Register(api, huma.Operation{
		OperationID: "call-ice",
		Method:      http.MethodPost,
		Path:        "/api/calls/{id}/ice",
		Summary:     "Forward an ICE candidate",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *callICEInput) (*statusOutput, error) {
		return callAction(ctx, func(userID string) error {
			return svc.SendIce(ctx, userID, input.ID, input.Body.Candidate)
		})
	})
}

// callAction runs an operation of the call domain for the caller.
func callAction(ctx context.Context, action func(userID string) error) (*statusOutput, error) {
	user, ok := userFromContext(ctx)
	if !ok {
		return nil, errUnauthorized
	}

	if err := action(user.ID); err != nil {
		return nil, mapServerError(err)
	}

	return okStatus(), nil
}

// registerCurrentCall adds the operation that reports the call of the user.
func registerCurrentCall(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "current-call",
		Method:      http.MethodGet,
		Path:        "/api/calls/current",
		Summary:     "The call the user is in, or the last one",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*currentCallOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		call, found := svc.CurrentCall(ctx, user.ID)
		if !found {
			return nil, errCallNotFound
		}

		out := &currentCallOutput{}
		out.Body.CallID = call.ID
		out.Body.Peer = call.Peer(user.ID)
		out.Body.State = string(call.State)
		out.Body.Reason = call.Reason
		out.Body.Offer = call.Offer
		out.Body.Answer = call.Answer
		out.Body.Role = callRole(call, user.ID)

		if !call.EndedAt.IsZero() {
			out.Body.EndedAt = call.EndedAt.Format(time.RFC3339)
		}

		return out, nil
	})
}

// errCallNotFound is the answer when the user is in no call at all.
var errCallNotFound = &statusError{ErrorMessage: "call not found", code: http.StatusNotFound}

type startCallInput struct {
	Body struct {
		ChatID string `json:"chatId"`
		Offer  string `json:"offer"`
	}
}

type acceptCallInput struct {
	ID   string `path:"id"`
	Body struct {
		Answer string `json:"answer"`
	}
}

type callIDInput struct {
	ID string `path:"id"`
}

type hangupCallInput struct {
	ID   string `path:"id"`
	Body struct {
		Reason string `json:"reason,omitempty"`
	}
}

type callICEInput struct {
	ID   string `path:"id"`
	Body struct {
		// Candidate is the raw ICE candidate of the browser. It is passed on
		// unchanged, so the other side can hand it to its own connection.
		Candidate json.RawMessage `json:"candidate"`
	}
}

type callOutput struct {
	Status int
	Body   struct {
		CallID string `json:"callId"`
		State  string `json:"state"`
	}
}

type currentCallOutput struct {
	Body struct {
		CallID  string `json:"callId"`
		Peer    string `json:"peer"`
		State   string `json:"state"`
		Reason  string `json:"reason,omitempty"`
		EndedAt string `json:"endedAt,omitempty"`
		Offer   string `json:"offer,omitempty"`
		Answer  string `json:"answer,omitempty"`
		// Role tells the client which side of the call the user is on. The
		// two sides report the end of a call differently.
		Role string `json:"role"`
	}
}

// callRole returns the side of the call the user is on.
func callRole(call *calls.Call, userID string) string {
	if call.CallerID == userID {
		return "caller"
	}

	return "callee"
}
