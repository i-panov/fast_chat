package transport

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

// Push subscription bounds. The p256dh key is a 65-byte uncompressed P-256
// point and the auth secret is 16 bytes (both base64url from the browser);
// the string cap only leaves headroom for padding/variant differences.
const (
	maxPushSubscriptionsPerUser = 20
	maxPushEndpointLen          = 2048
	maxPushKeyLen               = 256
	pushP256DHKeyLen            = 65
	pushAuthSecretLen           = 16
)

// validPushKey reports whether key decodes (any common base64 variant) to
// exactly the expected number of bytes.
func validPushKey(key string, decodedLen int) bool {
	if key == "" || len(key) > maxPushKeyLen {
		return false
	}

	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}

	for _, enc := range encodings {
		if raw, err := enc.DecodeString(key); err == nil && len(raw) == decodedLen {
			return true
		}
	}

	return false
}

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

		if len(input.Body.Endpoint) > maxPushEndpointLen || !service.IsValidPushEndpoint(input.Body.Endpoint) {
			return nil, &statusError{ErrorMessage: "invalid push endpoint", code: http.StatusBadRequest}
		}

		if !validPushKey(input.Body.P256DH, pushP256DHKeyLen) || !validPushKey(input.Body.Auth, pushAuthSecretLen) {
			return nil, &statusError{ErrorMessage: "invalid push subscription keys", code: http.StatusBadRequest}
		}

		// Quota: re-subscribing the same endpoint refreshes it, but new
		// endpoints past the cap are rejected instead of growing the table
		// without bound. A read failure fails closed: skipping the quota on
		// a transient DB error would let the table grow past the cap.
		subs, err := st.GetPushSubscriptionsByUser(ctx, user.ID)
		if err != nil {
			slog.Error("failed to read push subscriptions", "err", err)
			return nil, &statusError{ErrorMessage: "failed to save subscription", code: http.StatusInternalServerError}
		}
		known := false

		for _, sub := range subs {
			if sub.Endpoint == input.Body.Endpoint {
				known = true
				break
			}
		}

		if !known && len(subs) >= maxPushSubscriptionsPerUser {
			return nil, &statusError{ErrorMessage: "too many push subscriptions", code: http.StatusBadRequest}
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
