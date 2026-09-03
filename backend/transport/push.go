package transport

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

// RegisterPush adds the web-push subscription operations.
func RegisterPush(api huma.API, st *store.Store, pushPublicKey func() (string, bool)) {
	huma.Register(api, huma.Operation{
		OperationID: "vapid-public-key",
		Method:      http.MethodGet,
		Path:        "/api/push/vapid-public-key",
		Summary:     "Public VAPID key for web push",
	}, func(_ context.Context, _ *struct{}) (*vapidKeyOutput, error) {
		if pushPublicKey == nil {
			return nil, &statusError{ErrorMessage: "push not configured", code: http.StatusNotFound}
		}

		key, configured := pushPublicKey()
		if !configured {
			return nil, &statusError{ErrorMessage: "push not configured", code: http.StatusNotFound}
		}

		return &vapidKeyOutput{Body: struct {
			PublicKey string `json:"publicKey"`
		}{PublicKey: key}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "subscribe-push",
		Method:      http.MethodPost,
		Path:        "/api/push/subscribe",
		Summary:     "Register a web-push subscription",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *subscribePushInput) (*subscribePushOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Body.Endpoint == "" || input.Body.P256DH == "" || input.Body.Auth == "" {
			return nil, &statusError{ErrorMessage: "endpoint, p256dh, and auth are required", code: http.StatusBadRequest}
		}

		if !service.IsValidPushEndpoint(input.Body.Endpoint) {
			return nil, &statusError{ErrorMessage: "invalid push endpoint", code: http.StatusBadRequest}
		}

		sub, err := st.AddPushSubscription(ctx, user.ID, input.Body.Endpoint, input.Body.P256DH, input.Body.Auth)
		if err != nil {
			slog.Error("failed to save push subscription", "err", err)
			return nil, &statusError{ErrorMessage: "failed to save subscription", code: http.StatusInternalServerError}
		}

		var out subscribePushOutput
		out.Body.Subscription = sub

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "unsubscribe-push",
		Method:      http.MethodDelete,
		Path:        "/api/push/subscribe",
		Summary:     "Remove a web-push subscription",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *unsubscribePushInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Body.Endpoint == "" {
			return nil, &statusError{ErrorMessage: "endpoint is required", code: http.StatusBadRequest}
		}

		if err := st.DeletePushSubscription(ctx, user.ID, input.Body.Endpoint); err != nil {
			slog.Error("failed to delete push subscription", "err", err)
			return nil, &statusError{ErrorMessage: "failed to delete subscription", code: http.StatusInternalServerError}
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

type vapidKeyOutput struct {
	Body struct {
		PublicKey string `json:"publicKey"`
	}
}

type subscribePushInput struct {
	Body struct {
		Endpoint string `json:"endpoint,omitempty"`
		P256DH   string `json:"p256dh,omitempty"` //nolint:tagliatelle // field names fixed by the Web Push protocol
		Auth     string `json:"auth,omitempty"`
	}
}

type subscribePushOutput struct {
	Body struct {
		Subscription *model.PushSubscription `json:"subscription"`
	}
}

type unsubscribePushInput struct {
	Body struct {
		Endpoint string `json:"endpoint,omitempty"`
	}
}
