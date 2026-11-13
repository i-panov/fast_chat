package transport

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

const bearerScheme = "bearer"

// --- Request/response types ---
//
// Request bodies intentionally carry no format/maxLength constraints: input
// validation lives in the service layer so responses stay byte-identical to
// the pre-migration transport (e.g. whitespace-padded emails normalize to 200, an
// over-long code yields 401 "invalid code"). Fields are optional so missing
// fields reach the service and map to the pre-migration 400/401 statuses instead of
// Huma's 422.

type sendCodeInput struct {
	Body struct {
		Email string `doc:"Email address to send a verification code to" json:"email,omitempty"`
	}
}

type sendCodeOutput struct {
	Body struct {
		Status    string `example:"sent"                            json:"status"`
		DebugCode string `doc:"Verification code (debug mode only)" json:"debugCode,omitempty"`
	}
}

type verifyCodeInput struct {
	Body struct {
		Email      string `json:"email,omitempty"`
		Code       string `json:"code,omitempty"`
		DeviceID   string `json:"deviceId,omitempty"`
		DeviceName string `json:"deviceName,omitempty"`
	}
}

type verifyCodeOutput struct {
	Body struct {
		IsNew      bool              `json:"isNew"`
		SetupToken string            `json:"setupToken,omitempty"`
		User       *model.PublicUser `json:"user,omitempty"`
		Token      string            `json:"token,omitempty"`
		ExpiresAt  string            `json:"expiresAt,omitempty"`
		SessionID  string            `json:"sessionId,omitempty"`
		DeviceID   string            `json:"deviceId,omitempty"`
	}
}

type completeRegistrationInput struct {
	Body struct {
		SetupToken  string `json:"setupToken,omitempty"`
		Username    string `json:"username,omitempty"    required:"false"`
		DisplayName string `json:"displayName,omitempty" required:"false"`
		Nick        string `json:"nick,omitempty"        required:"false"` // legacy alias for username
		DeviceID    string `json:"deviceId,omitempty"`
		DeviceName  string `json:"deviceName,omitempty"`
	}
}

type completeRegistrationOutput struct {
	Body struct {
		User      *model.PublicUser `json:"user"`
		Token     string            `json:"token"`
		ExpiresAt string            `json:"expiresAt"`
		SessionID string            `json:"sessionId"`
		DeviceID  string            `json:"deviceId"`
	}
}

type refreshTokenOutput struct {
	Body struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
		SessionID string `json:"sessionId"`
	}
}

// --- Registration ---

// RegisterAuth adds auth operations to the given Huma API. Unauthenticated
// endpoints (send-code, verify-code, complete-registration) are open;
// refresh-token requires a valid Bearer token.
//
//nolint:funlen // auth endpoints share one registration block.
func RegisterAuth(api huma.API, svc *service.Service, st *store.Store, hub *sse.Hub, cfg *APIConfig) {
	huma.Register(api, huma.Operation{
		OperationID: "send-code",
		Method:      http.MethodPost,
		Path:        "/api/auth/send-code",
		Summary:     "Send a verification code",
	}, func(_ context.Context, input *sendCodeInput) (*sendCodeOutput, error) {
		res, err := svc.SendCode(input.Body.Email)
		if err != nil {
			return nil, mapServerError(err)
		}

		out := &sendCodeOutput{}
		out.Body.Status = "sent"

		if cfg.DebugEmail {
			out.Body.DebugCode = res.DebugCode
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "verify-code",
		Method:      http.MethodPost,
		Path:        "/api/auth/verify-code",
		Summary:     "Verify a code and log in or get a setup token",
	}, func(ctx context.Context, input *verifyCodeInput) (*verifyCodeOutput, error) {
		device := service.DeviceInfo{
			ID:        input.Body.DeviceID,
			Name:      input.Body.DeviceName,
			UserAgent: userAgentFromContext(ctx),
		}

		res, err := svc.VerifyCode(ctx, input.Body.Email, input.Body.Code, device)
		if err != nil {
			return nil, mapServerError(err)
		}

		out := &verifyCodeOutput{}

		if res.IsNew {
			out.Body.IsNew = true
			out.Body.SetupToken = res.SetupToken
		} else {
			out.Body.IsNew = false
			pub := res.User.Public()
			out.Body.User = &pub
			out.Body.Token = res.Token

			if res.Session != nil {
				out.Body.ExpiresAt = res.Session.ExpiresAt.Format(time.RFC3339)
				out.Body.SessionID = res.Session.ID
				out.Body.DeviceID = res.Session.DeviceID
			}
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "complete-registration",
		Method:      http.MethodPost,
		Path:        "/api/auth/complete-registration",
		Summary:     "Finish registration with a setup token and nick",
	}, func(ctx context.Context, input *completeRegistrationInput) (*completeRegistrationOutput, error) {
		device := service.DeviceInfo{
			ID:        input.Body.DeviceID,
			Name:      input.Body.DeviceName,
			UserAgent: userAgentFromContext(ctx),
		}

		username := input.Body.Username
		if username == "" {
			username = input.Body.Nick
		}
		res, err := svc.CompleteRegistration(ctx, input.Body.SetupToken, username, input.Body.DisplayName, device)
		if err != nil {
			return nil, mapServerError(err)
		}

		pub := res.User.Public()

		out := &completeRegistrationOutput{}
		out.Body.User = &pub
		out.Body.Token = res.Token

		if res.Session != nil {
			out.Body.ExpiresAt = res.Session.ExpiresAt.Format(time.RFC3339)
			out.Body.SessionID = res.Session.ID
			out.Body.DeviceID = res.Session.DeviceID
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "refresh-token",
		Method:      http.MethodPost,
		Path:        "/api/auth/refresh-token",
		Summary:     "Refresh the current session token",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*refreshTokenOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		session, token, err := svc.RefreshSession(ctx, user.SessionID)
		if err != nil {
			return nil, mapSessionError(err)
		}

		out := &refreshTokenOutput{}
		out.Body.Token = token
		out.Body.ExpiresAt = session.ExpiresAt.Format(time.RFC3339)
		out.Body.SessionID = session.ID

		return out, nil
	})

	registerSSEAuth(api, svc, st, hub)
	registerLogout(api, svc)
	registerLogoutAll(api, svc)
	RegisterSessions(api, svc)
}

// registerLogout adds the logout operation. It revokes only the current
// session: the other devices of the account keep their tokens, so logging out
// on a laptop does not sign the user out on a phone.
func registerLogout(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "logout",
		Method:      http.MethodPost,
		Path:        "/api/auth/logout",
		Summary:     "Revoke the current session token",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if err := svc.Logout(ctx, user.ID, user.SessionID); err != nil {
			return nil, mapSessionError(err)
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

// registerLogoutAll adds the logout-everywhere operation: every device of the
// account loses its token and its realtime streams.
func registerLogoutAll(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "logout-all",
		Method:      http.MethodPost,
		Path:        "/api/auth/logout-all",
		Summary:     "Revoke every session of the account",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if err := svc.LogoutAll(ctx, user.ID); err != nil {
			return nil, mapServerError(err)
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

// registerSSEAuth adds the SSE connection-authentication operation. It mirrors
// the pre-migration handler.SSEAuth: token → 401, unknown connection → 404.
func registerSSEAuth(api huma.API, svc *service.Service, st *store.Store, hub *sse.Hub) {
	huma.Register(api, huma.Operation{
		OperationID: "sse-auth",
		Method:      http.MethodPost,
		Path:        "/api/auth/sse-auth",
		Summary:     "Authenticate an SSE connection",
	}, func(ctx context.Context, input *sseAuthInput) (*sseAuthOutput, error) {
		session, user, ok := st.GetSessionByToken(ctx, input.Body.Token)
		if !ok {
			return nil, errUnauthorized
		}

		// BindSession is atomic and reports whether this call created the
		// binding. The frontend retries sse-auth on the same connection, and
		// only a genuinely new binding may increment presence.
		newBinding, err := hub.BindSession(input.Body.ConnectionID, user.ID, session.ID, session.ExpiresAt)
		if err != nil {
			if errors.Is(err, sse.ErrConnectionInUse) {
				return nil, errConnectionInUse
			}

			return nil, errConnectionNotFound
		}

		if newBinding && st.AddConnectionForSession(user.ID, session.ID) {
			svc.BroadcastUserStatus(ctx, user.ID, true)
		}

		touchSession(ctx, st, session.ID)

		out := &sseAuthOutput{}
		out.Body.Status = "ok"

		return out, nil
	})
}

type sseAuthInput struct {
	Body struct {
		ConnectionID string `json:"connectionId,omitempty"`
		Token        string `json:"token,omitempty"`
	}
}

type sseAuthOutput struct {
	Body struct {
		Status string `example:"ok" json:"status"`
	}
}

var (
	errConnectionNotFound = &statusError{ErrorMessage: "connection not found", code: http.StatusNotFound}
	errConnectionInUse    = &statusError{ErrorMessage: "connection already authorized", code: http.StatusConflict}
)

// APIConfig holds transport-layer configuration needed by Huma operations.
type APIConfig struct {
	DebugEmail bool
	Version    string
	Commit     string
}

// --- Auth context ---

type authContextKey struct{}

type authUser struct {
	ID        string
	Nick      string
	SessionID string
}

// userFromContext retrieves the authenticated user from the request context.
// Middleware stores the user via huma.WithValue, which propagates to the
// underlying request context that handlers receive.
func userFromContext(ctx context.Context) (*authUser, bool) {
	u, ok := ctx.Value(authContextKey{}).(*authUser)
	return u, ok
}

// sessionFromContext retrieves the authenticated device session. It reports
// false for a context that cannot be tied to a session, so device-scoped
// handlers reject it.
func sessionFromContext(ctx context.Context) (*authUser, bool) {
	u, ok := userFromContext(ctx)
	if !ok || u.SessionID == "" {
		return nil, false
	}

	return u, true
}

// touchSession advances the session's last_seen_at, throttled by the store.
// Presence bookkeeping must never fail a request, so errors are only logged.
func touchSession(ctx context.Context, st *store.Store, sessionID string) {
	if err := st.TouchSession(ctx, sessionID, time.Now().UTC()); err != nil {
		slog.Warn("failed to touch session", "sessionID", sessionID, "err", err)
	}
}

// userAgentFromContext returns the User-Agent of the raw request stashed by
// requestStashMiddleware.
func userAgentFromContext(ctx context.Context) string {
	if r, ok := requestFromContext(ctx); ok {
		return r.UserAgent()
	}

	return ""
}

var errUnauthorized = &statusError{ErrorMessage: "unauthorized", code: http.StatusUnauthorized}

// mapSessionError answers a revoked or unknown session as an authentication
// failure: logout and refresh race a concurrent revoke, which is not a server
// error. Every other error keeps the generic service mapping.
func mapSessionError(err error) huma.StatusError { //nolint:ireturn // huma.StatusError is the required interface
	if errors.Is(err, store.ErrSessionNotFound) {
		return errUnauthorized
	}

	return mapServerError(err)
}

// errInternal is the generic 500 for unmapped service failures, matching the
// pre-migration transport's "internal error".
var errInternal = &statusError{ErrorMessage: "internal error", code: http.StatusInternalServerError}

// Shared error messages (the wire format must stay byte-identical to the pre-migration transport).
const (
	msgChatNotFound      = "chat not found"
	msgNotMember         = "not a member"
	msgUnauthorized      = "unauthorized"
	msgTooManyFiles      = "too many files"
	msgTooManyMessageIDs = "too many message IDs"
)

// AuthMiddleware validates the Bearer token and, on success, stores the user
// in the context for downstream handlers.
func AuthMiddleware(st *store.Store) func(ctx huma.Context, next func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		// Only protect operations that declare bearer security.
		needsAuth := false
		for _, scheme := range ctx.Operation().Security {
			if _, ok := scheme[bearerScheme]; ok {
				needsAuth = true
				break
			}
		}

		if !needsAuth {
			next(ctx)

			return
		}

		// The scheme is part of the credential: a bare token or another
		// scheme ("Basic ...") must not authenticate even when its value
		// happens to match a session.
		raw := ctx.Header("Authorization")
		if !strings.HasPrefix(raw, "Bearer ") {
			// Header must precede SetStatus: the adapter commits headers on
			// SetStatus, and net/http ignores later header writes.
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec // best-effort: auth rejection

			return
		}

		token := strings.TrimSpace(strings.TrimPrefix(raw, "Bearer "))
		if token == "" {
			// Header must precede SetStatus: the adapter commits headers on
			// SetStatus, and net/http ignores later header writes.
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec // best-effort: auth rejection

			return
		}

		session, user, ok := st.GetSessionByToken(ctx.Context(), token)
		if !ok {
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec // best-effort: auth rejection

			return
		}

		touchSession(ctx.Context(), st, session.ID)

		next(huma.WithValue(ctx, authContextKey{}, &authUser{
			ID:        user.ID,
			Nick:      user.Username,
			SessionID: session.ID,
		}))
	}
}
