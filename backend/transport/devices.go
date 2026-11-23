package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

//nolint:gocognit,gocyclo,cyclop,dupl,funlen // the six small operations share the same auth preamble.
func registerUserDevices(api huma.API, st *store.Store, fed *federation.Client, cfg *config.Config) {
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
		OperationID: "set-device-key-backup",
		Method:      http.MethodPut,
		Path:        "/api/users/device-key/backup",
		Summary:     "Store the encrypted backup of this device key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deviceBackupInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if user.SessionID == "" {
			return nil, &statusError{ErrorMessage: msgSessionRequired, code: http.StatusBadRequest}
		}
		if input.Body.Backup == "" || len(input.Body.Backup) > maxKeyBackupLen {
			return nil, &statusError{ErrorMessage: msgInvalidBackup, code: http.StatusBadRequest}
		}
		if _, err := base64.StdEncoding.DecodeString(input.Body.Backup); err != nil {
			return nil, &statusError{ErrorMessage: msgInvalidBackup, code: http.StatusBadRequest}
		}
		if err := st.SetUserDeviceBackup(ctx, user.ID, user.SessionID, input.Body.Backup); err != nil {
			return nil, errInternal
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-device-key-backup",
		Method:      http.MethodGet,
		Path:        "/api/users/device-keys/{deviceId}/backup",
		Summary:     "Fetch the encrypted backup of one device key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deviceKeyPathInput) (*deviceBackupOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		blob, found := st.GetUserDeviceBackup(ctx, user.ID, input.DeviceID)
		if !found {
			return nil, &statusError{ErrorMessage: "backup not found", code: http.StatusNotFound}
		}
		var out deviceBackupOutput
		out.Body.Backup = blob
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-device-key-backup",
		Method:      http.MethodDelete,
		Path:        "/api/users/device-key/backup",
		Summary:     "Delete the encrypted backup of this device key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if user.SessionID == "" {
			return nil, &statusError{ErrorMessage: msgSessionRequired, code: http.StatusBadRequest}
		}
		if err := st.DeleteUserDeviceBackup(ctx, user.ID, user.SessionID); err != nil {
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
		if _, ok := userFromContext(ctx); !ok {
			return nil, errUnauthorized
		}
		remoteDomain := service.RemoteServerFromIDFor(input.UserID, cfg.Federation.AllowPrivateAddresses)
		if remoteDomain == "" || remoteDomain == cfg.Server.Domain {
			devices, err := st.ListUserDevices(ctx, input.UserID)
			if err != nil {
				return nil, errInternal
			}
			return deviceKeysResponse(devices), nil
		}
		if fed == nil {
			return nil, &statusError{ErrorMessage: "failed to fetch device keys", code: http.StatusBadGateway}
		}
		remoteURL := fed.URL(remoteDomain, "/api/federated/users/"+url.PathEscape(input.UserID)+"/device-keys")
		data, err := fed.Request(ctx, http.MethodGet, remoteURL, nil)
		if err != nil {
			slog.Warn("remote device keys failed", "err", err)
			return nil, &statusError{ErrorMessage: "failed to fetch device keys", code: http.StatusBadGateway}
		}
		var result struct {
			Devices []deviceKeyDTO `json:"devices"`
		}
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, &statusError{ErrorMessage: msgFailedParseRemote, code: http.StatusBadGateway}
		}
		var out deviceKeysOutput
		out.Body.Devices = result.Devices
		return &out, nil
	})
}

func registerFederatedDeviceKeys(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-user-device-keys",
		Method:      http.MethodGet,
		Path:        "/api/federated/users/{userId}/device-keys",
		Summary:     "Serve a user's E2EE device keys to a peer server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *deviceKeysPathInput) (*deviceKeysOutput, error) {
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

type deviceBackupInput struct {
	Body struct {
		Backup string `json:"backup"`
	}
}

type deviceBackupOutput struct {
	Body struct {
		Backup string `json:"backup"`
	}
}
