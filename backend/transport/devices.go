package transport

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

func registerUserDevices(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "update-device-key",
		Method:      http.MethodPut,
		Path:        "/api/users/device-key",
		Summary:     "Register this device's E2EE public key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deviceKeyInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		rawKey, err := service.DecodePublicKey(input.Body.PublicKey)
		if err != nil {
			return nil, &statusError{ErrorMessage: msgInvalidPublicKey, code: http.StatusBadRequest}
		}
		if user.SessionID == "" {
			return nil, &statusError{ErrorMessage: msgSessionRequired, code: http.StatusBadRequest}
		}
		normalized := encodePublicKey(rawKey)
		if err := st.UpsertUserDevice(ctx, user.ID, user.SessionID, normalized); err != nil {
			slog.Error("failed to store device key", "err", err)
			return nil, errInternal
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-device-key",
		Method:      http.MethodDelete,
		Path:        "/api/users/device-key",
		Summary:     "Revoke this device's E2EE key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if user.SessionID == "" {
			return nil, &statusError{ErrorMessage: msgSessionRequired, code: http.StatusBadRequest}
		}
		if err := st.RevokeUserDevice(ctx, user.ID, user.SessionID); err != nil {
			return nil, errInternal
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "revoke-device-key",
		Method:      http.MethodDelete,
		Path:        "/api/users/device-keys/{deviceId}",
		Summary:     "Revoke one of the caller's device keys",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deviceKeyPathInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if err := st.RevokeUserDevice(ctx, user.ID, input.DeviceID); err != nil {
			return nil, errInternal
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-device-keys",
		Method:      http.MethodGet,
		Path:        "/api/users/{userId}/device-keys",
		Summary:     "List the E2EE device keys of a user",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deviceKeysPathInput) (*deviceKeysOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		// Legacy per-device keys are only exposed to their owner; v3 clients
		// use the account master key instead.
		if input.UserID != user.ID {
			return nil, &statusError{ErrorMessage: "forbidden", code: http.StatusForbidden}
		}
		devices, err := st.ListUserDevices(ctx, input.UserID)
		if err != nil {
			return nil, errInternal
		}
		return deviceKeysResponse(devices), nil
	})
}

func deviceKeysResponse(devices []model.UserDevice) *deviceKeysOutput {
	out := make([]deviceKeyDTO, 0, len(devices))
	for idx := range devices {
		device := &devices[idx]
		out = append(out, deviceKeyDTO{
			ID:         device.ID,
			PublicKey:  device.PublicKey,
			CreatedAt:  device.CreatedAt,
			LastSeenAt: device.LastSeenAt,
			HasBackup:  device.KeyBackup != "",
		})
	}
	var result deviceKeysOutput
	result.Body.Devices = out
	return &result
}

func encodePublicKey(raw []byte) string {
	return base64.StdEncoding.EncodeToString(raw)
}

type deviceKeyInput struct {
	Body struct {
		PublicKey string `json:"publicKey"`
	}
}

type deviceKeysPathInput struct {
	UserID string `path:"userId"`
}

type deviceKeyPathInput struct {
	DeviceID string `path:"deviceId"`
}

type deviceKeyDTO struct {
	ID         string    `json:"id"`
	PublicKey  string    `json:"publicKey"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	HasBackup  bool      `json:"hasBackup,omitempty"`
}

type deviceKeysOutput struct {
	Body struct {
		Devices []deviceKeyDTO `json:"devices"`
	}
}
