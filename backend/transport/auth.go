package transport

import (
	"context"
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
		Email string `json:"email,omitempty"`
		Code  string `json:"code,omitempty"`
	}
}

type verifyCodeOutput struct {
	Body struct {
		IsNew      bool              `json:"isNew"`
		SetupToken string            `json:"setupToken,omitempty"`
		User       *model.PublicUser `json:"user,omitempty"`
		Token      string            `json:"token,omitempty"`
		ExpiresAt  string            `json:"expiresAt,omitempty"`
	}
}

type completeRegistrationInput struct {
	Body struct {
		SetupToken string `json:"setupToken,omitempty"`
		Nick       string `json:"nick,omitempty"`
	}
}

type completeRegistrationOutput struct {
	Body struct {
		User      *model.PublicUser `json:"user"`
		Token     string            `json:"token"`
		ExpiresAt string            `json:"expiresAt"`
	}
}

type refreshTokenOutput struct {
	Body struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
}

// --- Registration ---

// RegisterAuth adds auth operations to the given Huma API. Unauthenticated
// endpoints (send-code, verify-code, complete-registration) are open;
// refresh-token requires a valid Bearer token.
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
		res, err := svc.VerifyCode(ctx, input.Body.Email, input.Body.Code)
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
			out.Body.Token = res.User.Token
			out.Body.ExpiresAt = res.User.TokenExpiresAt.Format(time.RFC3339)
		}

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "complete-registration",
		Method:      http.MethodPost,
		Path:        "/api/auth/complete-registration",
		Summary:     "Finish registration with a setup token and nick",
	}, func(ctx context.Context, input *completeRegistrationInput) (*completeRegistrationOutput, error) {
		user, err := svc.CompleteRegistration(ctx, input.Body.SetupToken, input.Body.Nick)
		if err != nil {
			return nil, mapServerError(err)
		}

		pub := user.Public()

		return &completeRegistrationOutput{
			Body: struct {
				User      *model.PublicUser `json:"user"`
				Token     string            `json:"token"`
				ExpiresAt string            `json:"expiresAt"`
			}{
				User:      &pub,
				Token:     user.Token,
				ExpiresAt: user.TokenExpiresAt.Format(time.RFC3339),
			},
		}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "refresh-token",
		Method:      http.MethodPost,
		Path:        "/api/auth/refresh-token",
		Summary:     "Refresh the current session token",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*refreshTokenOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		refreshed, err := svc.RefreshToken(ctx, user.ID)
		if err != nil {
			return nil, mapServerError(err)
		}

		return &refreshTokenOutput{
			Body: struct {
				Token     string `json:"token"`
				ExpiresAt string `json:"expiresAt"`
			}{
				Token:     refreshed.Token,
				ExpiresAt: refreshed.TokenExpiresAt.Format(time.RFC3339),
			},
		}, nil
	})

	registerSSEAuth(api, svc, st, hub)
	registerLogout(api, st)
}

// registerLogout adds the logout operation. It revokes the token on the
// server: without it a token that leaked stays usable until it expires, and
// logging out of the interface would only hide the session locally.
//
// The account has one session: the token belongs to the account, not to the
// device, so the logout ends the session of the account on every device.
// Sessions per device would need their own table and are a separate task.
func registerLogout(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "logout",
		Method:      http.MethodPost,
		Path:        "/api/auth/logout",
		Summary:     "Revoke the session token of the account",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if err := st.RevokeUserToken(ctx, user.ID); err != nil {
			slog.Error("failed to revoke token", "err", err)
			return nil, errInternal
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
		user, ok := st.GetUserByToken(ctx, input.Body.Token)
		if !ok || time.Now().After(user.TokenExpiresAt) {
			return nil, errUnauthorized
		}

		conn := hub.GetConnection(input.Body.ConnectionID)
		if conn == nil {
			return nil, errConnectionNotFound
		}

		if err := hub.Authenticate(input.Body.ConnectionID, user.ID, input.Body.Token, user.TokenExpiresAt); err != nil {
			return nil, errConnectionNotFound
		}

		if st.AddConnection(user.ID) {
			svc.BroadcastUserStatus(ctx, user.ID, true)
		}

		return &sseAuthOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
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

var errConnectionNotFound = &statusError{ErrorMessage: "connection not found", code: http.StatusNotFound}

// APIConfig holds transport-layer configuration needed by Huma operations.
type APIConfig struct {
	DebugEmail bool
	Version    string
	Commit     string
}

// --- Auth context ---

type authContextKey struct{}

type authUser struct {
	ID   string
	Nick string
}

// WithAuthUser stores the authenticated user in the context.
func WithAuthUser(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, authContextKey{}, &authUser{ID: userID})
}

// userFromContext retrieves the authenticated user from the request context.
// Middleware stores the user via huma.WithValue, which propagates to the
// underlying request context that handlers receive.
func userFromContext(ctx context.Context) (*authUser, bool) {
	u, ok := ctx.Value(authContextKey{}).(*authUser)
	return u, ok
}

var errUnauthorized = &statusError{ErrorMessage: "unauthorized", code: http.StatusUnauthorized}

// errInternal is the generic 500 for unmapped service failures, matching the
// pre-migration transport's "internal error".
var errInternal = &statusError{ErrorMessage: "internal error", code: http.StatusInternalServerError}

// Shared error messages (the wire format must stay byte-identical to the pre-migration transport).
const (
	msgChatNotFound = "chat not found"
	msgNotMember    = "not a member"
	msgUnauthorized = "unauthorized"
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

		token := strings.TrimPrefix(ctx.Header("Authorization"), "Bearer ")
		if token == "" {
			// Header must precede SetStatus: the adapter commits headers on
			// SetStatus, and net/http ignores later header writes.
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec // best-effort: auth rejection

			return
		}

		user, ok := st.GetUserByToken(ctx.Context(), token)
		if !ok || time.Now().After(user.TokenExpiresAt) {
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec // best-effort: auth rejection

			return
		}

		next(huma.WithValue(ctx, authContextKey{}, &authUser{ID: user.ID, Nick: user.Nick}))
	}
}
