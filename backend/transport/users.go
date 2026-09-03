package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

// RegisterUsers adds the config, user-search, public-key, and key-backup
// operations. All routes except /api/config require a Bearer token.
func RegisterUsers(api huma.API, st *store.Store, fed *federation.Client, cfg *config.Config, apiCfg *APIConfig) {
	registerClientConfig(api, cfg, apiCfg)
	registerUserSearch(api, st, fed, cfg)
	registerUserKeys(api, st, fed, cfg)
	registerKeyBackup(api, st)
}

// registerClientConfig registers a subset of the operations.
func registerClientConfig(api huma.API, cfg *config.Config, apiCfg *APIConfig) {
	huma.Register(api, huma.Operation{
		OperationID: "get-config",
		Method:      http.MethodGet,
		Path:        "/api/config",
		Summary:     "Public client configuration",
	}, func(_ context.Context, _ *struct{}) (*configOutput, error) {
		var out configOutput
		out.Body.MessageEditTTL = cfg.MessageEditTTL
		out.Body.MessageDeleteTTL = cfg.MessageDeleteTTL
		out.Body.Version = apiCfg.Version
		out.Body.Commit = apiCfg.Commit

		return &out, nil
	})
}

// registerUserSearch registers a subset of the operations.
func registerUserSearch(api huma.API, st *store.Store, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "search-users",
		Method:      http.MethodGet,
		Path:        "/api/users/search",
		Summary:     "Search users by nick (local or federated)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *searchUsersInput) (*searchUsersOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		query := input.Q
		if before, after, has := strings.Cut(query, ":"); has {
			return searchFederated(ctx, st, fed, before, after, user.ID, cfg.Server.Domain)
		}

		if utf8.RuneCountInString(strings.TrimSpace(query)) < service.MinSearchRunes {
			return &searchUsersOutput{Body: struct {
				Users []model.PublicUser `json:"users"`
			}{Users: []model.PublicUser{}}}, nil
		}

		users := st.SearchUsers(ctx, query, user.ID)
		if users == nil {
			users = []model.PublicUser{}
		}

		return &searchUsersOutput{Body: struct {
			Users []model.PublicUser `json:"users"`
		}{Users: users}}, nil
	})
}

// registerUserKeys registers a subset of the operations.
func registerUserKeys(api huma.API, st *store.Store, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "update-public-key",
		Method:      http.MethodPut,
		Path:        "/api/users/public-key",
		Summary:     "Store the caller's E2E public key",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *updatePublicKeyInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		rawKey, err := service.DecodePublicKey(input.Body.PublicKey)
		if err != nil {
			return nil, &statusError{ErrorMessage: "invalid public key", code: http.StatusBadRequest}
		}

		normalized := base64.StdEncoding.EncodeToString(rawKey)

		if err := st.UpdateUserPublicKey(ctx, user.ID, normalized); err != nil {
			slog.Error("failed to update public key", "err", err)
			return nil, errInternal
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-user-public-key",
		Method:      http.MethodGet,
		Path:        "/api/users/{userId}/public-key",
		Summary:     "Fetch a user's E2E public key (proxied for federated users)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *publicKeyPathInput) (*publicKeyOutput, error) {
		remoteDomain := service.RemoteServerFromID(input.UserID)
		if remoteDomain == "" || remoteDomain == cfg.Server.Domain {
			key, exists := st.GetUserPublicKey(ctx, input.UserID)
			if !exists {
				return nil, &statusError{ErrorMessage: "user has no public key", code: http.StatusNotFound}
			}

			return publicKeyResponseBody(key), nil
		}

		remoteURL := fed.URL(remoteDomain, "/api/federated/users/"+url.PathEscape(input.UserID)+"/public-key")

		data, err := fed.Request(ctx, http.MethodGet, remoteURL, nil)
		if err != nil {
			slog.Warn("remote public key fetch failed", "err", err)
			return nil, &statusError{ErrorMessage: "failed to fetch public key", code: http.StatusBadGateway}
		}

		var result struct {
			PublicKey  string `json:"publicKey"`
			KeyVersion string `json:"keyVersion"`
		}

		if err := json.Unmarshal(data, &result); err != nil || result.PublicKey == "" {
			return nil, &statusError{ErrorMessage: "failed to parse remote response", code: http.StatusBadGateway}
		}

		keyVersion := result.KeyVersion
		if keyVersion == "" {
			keyVersion = service.KeyVersionFor(result.PublicKey)
		}

		var out publicKeyOutput
		out.Body.PublicKey = result.PublicKey
		out.Body.KeyVersion = keyVersion

		return &out, nil
	})
}

// registerKeyBackup registers a subset of the operations.
func registerKeyBackup(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "set-key-backup",
		Method:      http.MethodPut,
		Path:        pathKeyBackup,
		Summary:     "Store the caller's encrypted key backup",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *setKeyBackupInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Body.Backup == "" || len(input.Body.Backup) > maxKeyBackupLen {
			return nil, &statusError{ErrorMessage: "invalid backup", code: http.StatusBadRequest}
		}

		if _, err := base64.StdEncoding.DecodeString(input.Body.Backup); err != nil {
			return nil, &statusError{ErrorMessage: "invalid backup", code: http.StatusBadRequest}
		}

		if err := st.SetKeyBackup(ctx, user.ID, input.Body.Backup); err != nil {
			slog.Error("failed to store key backup", "err", err)
			return nil, errInternal
		}

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-key-backup",
		Method:      http.MethodGet,
		Path:        pathKeyBackup,
		Summary:     "Fetch the caller's key backup",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*keyBackupOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		blob, exists := st.GetKeyBackup(ctx, user.ID)
		if !exists {
			return nil, &statusError{ErrorMessage: "no key backup", code: http.StatusNotFound}
		}

		return &keyBackupOutput{Body: struct {
			Backup string `json:"backup"`
		}{Backup: blob}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-key-backup",
		Method:      http.MethodDelete,
		Path:        pathKeyBackup,
		Summary:     "Revoke the caller's key backup",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if err := st.DeleteKeyBackup(ctx, user.ID); err != nil {
			slog.Error("failed to delete key backup", "err", err)
			return nil, errInternal
		}

		slog.Info("key backup deleted", "userId", user.ID)

		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

// maxKeyBackupLen bounds the accepted backup blob size, matching the pre-migration
// transport (a base64 blob holding two 32-byte keys plus salt/nonce).
const maxKeyBackupLen = 4 << 10

type configOutput struct {
	Body struct {
		MessageEditTTL   int    `json:"messageEditTTL"`   //nolint:tagliatelle // wire format fixed by the frontend
		MessageDeleteTTL int    `json:"messageDeleteTTL"` //nolint:tagliatelle // wire format fixed by the frontend
		Version          string `json:"version"`
		Commit           string `json:"commit"`
	}
}

type searchUsersInput struct {
	Q string `doc:"Search query" query:"q"`
}

type searchUsersOutput struct {
	Body struct {
		Users []model.PublicUser `json:"users"`
	}
}

type updatePublicKeyInput struct {
	Body struct {
		PublicKey string `json:"publicKey"`
	}
}

type statusOutput struct {
	Body struct {
		Status string `example:"ok" json:"status"`
	}
}

type publicKeyPathInput struct {
	UserID string `path:"userId"`
}

type publicKeyOutput struct {
	Body struct {
		PublicKey  string `json:"publicKey"`
		KeyVersion string `json:"keyVersion"`
	}
}

func publicKeyResponseBody(key string) *publicKeyOutput {
	var out publicKeyOutput
	out.Body.PublicKey = key
	out.Body.KeyVersion = service.KeyVersionFor(key)

	return &out
}

type setKeyBackupInput struct {
	Body struct {
		Backup string `json:"backup"`
	}
}

type keyBackupOutput struct {
	Body struct {
		Backup string `json:"backup"`
	}
}

// pathKeyBackup is the key-backup route (PUT/GET/DELETE).
const pathKeyBackup = "/api/users/key-backup"

// searchFederated handles "nick:domain" search queries, proxying to the
// remote server when needed (mirrors the pre-migration searchFederated handler).
func searchFederated(
	ctx context.Context,
	st *store.Store,
	fed *federation.Client,
	remoteNick, remoteDomain, callerID, localDomain string,
) (*searchUsersOutput, error) {

	badRequest := &statusError{ErrorMessage: "invalid search query", code: http.StatusBadRequest}

	if remoteNick == "" || remoteDomain == "" || utf8.RuneCountInString(remoteNick) < service.MinSearchRunes {
		return nil, badRequest
	}

	if !service.IsValidRemoteDomain(remoteDomain) {
		return nil, badRequest
	}

	if remoteDomain == localDomain {
		users := st.SearchUsers(ctx, remoteNick, callerID)
		if users == nil {
			users = []model.PublicUser{}
		}

		return &searchUsersOutput{Body: struct {
			Users []model.PublicUser `json:"users"`
		}{Users: users}}, nil
	}

	remoteURL := fed.URL(remoteDomain, "/api/federated/users/search?q="+url.QueryEscape(remoteNick))

	data, err := fed.Request(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		slog.Warn("remote search failed", "err", err)
		return nil, &statusError{ErrorMessage: "remote search failed", code: http.StatusBadGateway}
	}

	var result struct {
		Users []model.PublicUser `json:"users"`
	}

	if err := json.Unmarshal(data, &result); err != nil {
		return nil, &statusError{ErrorMessage: "failed to parse remote response", code: http.StatusInternalServerError}
	}

	// Strip trailing ":domain" from ID for display purposes.
	for idx := range result.Users {
		nick := result.Users[idx].ID
		if before, _, has := strings.Cut(nick, ":"); has {
			result.Users[idx].Nick = before
		}
	}

	return &searchUsersOutput{Body: struct {
		Users []model.PublicUser `json:"users"`
	}{Users: result.Users}}, nil
}
