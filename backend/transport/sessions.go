package transport

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
	"fast_chat/store"
)

type sessionView struct {
	ID         string `json:"id"`
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	UserAgent  string `json:"userAgent,omitempty"`
	CreatedAt  string `json:"createdAt"`
	LastSeenAt string `json:"lastSeenAt"`
	ExpiresAt  string `json:"expiresAt"`
	Current    bool   `json:"current"`
}

type listSessionsOutput struct {
	Body struct {
		CurrentSessionID string        `json:"currentSessionId"`
		Sessions         []sessionView `json:"sessions"`
	}
}

type revokeSessionInput struct {
	ID string `path:"id"`
}

// RegisterSessions adds the device-session operations. The current session is
// the one whose token authenticated the request, so the client can tell its
// own device from the others.
func RegisterSessions(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-sessions",
		Method:      http.MethodGet,
		Path:        "/api/sessions",
		Summary:     "List the devices of the account",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*listSessionsOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		sessions, err := svc.ListSessions(ctx, user.ID)
		if err != nil {
			return nil, mapServerError(err)
		}

		out := &listSessionsOutput{}
		out.Body.CurrentSessionID = user.SessionID
		out.Body.Sessions = make([]sessionView, 0, len(sessions))

		for idx := range sessions {
			sess := &sessions[idx]
			out.Body.Sessions = append(out.Body.Sessions, sessionView{
				ID:         sess.ID,
				DeviceID:   sess.DeviceID,
				DeviceName: sess.DeviceName,
				UserAgent:  sess.UserAgent,
				CreatedAt:  sess.CreatedAt.Format(time.RFC3339),
				LastSeenAt: sess.LastSeenAt.Format(time.RFC3339),
				ExpiresAt:  sess.ExpiresAt.Format(time.RFC3339),
				Current:    sess.ID == user.SessionID,
			})
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "revoke-session",
		Method:      http.MethodDelete,
		Path:        "/api/sessions/{id}",
		Summary:     "Revoke another device session",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *revokeSessionInput) (*statusOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if err := svc.RevokeSession(ctx, user.ID, input.ID); err != nil {
			if errors.Is(err, store.ErrSessionNotFound) {
				return nil, &statusError{ErrorMessage: "session not found", code: http.StatusNotFound}
			}

			return nil, mapServerError(err)
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}
