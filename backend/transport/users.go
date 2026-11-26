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
	registerUserAvatar(api, st)
	registerUserBlocks(api, st)
	registerUserDevices(api, st, fed, cfg)
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
			return searchFederated(ctx, st, fed, before, after, user.ID, cfg.Server.Domain, cfg.Federation.AllowPrivateAddresses)
		}

		if utf8.RuneCountInString(strings.TrimSpace(query)) < service.MinSearchRunes {
			return &searchUsersOutput{Body: struct {
				Users []model.PublicUser `json:"users"`
			}{Users: []model.PublicUser{}}}, nil
		}

		users := filterBlockedUsers(ctx, st, user.ID, st.SearchUsers(ctx, query, user.ID))

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
			return nil, &statusError{ErrorMessage: msgInvalidPublicKey, code: http.StatusBadRequest}
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
		if _, ok := userFromContext(ctx); !ok {
			return nil, errUnauthorized
		}

		remoteDomain := service.RemoteServerFromIDFor(input.UserID, cfg.Federation.AllowPrivateAddresses)
		if remoteDomain == "" || remoteDomain == cfg.Server.Domain {
			key, exists := st.GetUserPublicKey(ctx, input.UserID)
			if !exists {
				return nil, &statusError{ErrorMessage: "user has no public key", code: http.StatusNotFound}
			}

			return publicKeyResponseBody(key), nil
		}

		if fed == nil {
			return nil, &statusError{ErrorMessage: "failed to fetch public key", code: http.StatusBadGateway}
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
			return nil, &statusError{ErrorMessage: msgFailedParseRemote, code: http.StatusBadGateway}
		}

		// A peer must not plant an arbitrary string as someone's E2E key:
		// it has to decode to a 32-byte public key like a locally stored one.
		if _, err := service.DecodePublicKey(result.PublicKey); err != nil {
			return nil, &statusError{ErrorMessage: "invalid remote public key", code: http.StatusBadGateway}
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
			return nil, &statusError{ErrorMessage: msgInvalidBackup, code: http.StatusBadRequest}
		}

		if _, err := base64.StdEncoding.DecodeString(input.Body.Backup); err != nil {
			return nil, &statusError{ErrorMessage: msgInvalidBackup, code: http.StatusBadRequest}
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
		PublicKey      string `json:"publicKey"`
		KeyVersion     string `json:"keyVersion"`
		EncryptionMode string `json:"encryptionMode,omitempty"`
	}
}

func publicKeyResponseBody(key string) *publicKeyOutput {
	var out publicKeyOutput
	out.Body.PublicKey = key
	out.Body.KeyVersion = service.KeyVersionFor(key)
	out.Body.EncryptionMode = "server"

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

// maxFederatedSearchResults caps how many proxied remote users one search
// answers. The peer may send far more; forwarding all of it would amplify
// one remote reply into our client's response.
const maxFederatedSearchResults = 20

// searchFederated handles "nick:domain" search queries, proxying to the
// remote server when needed (mirrors the pre-migration searchFederated handler).
func searchFederated(
	ctx context.Context,
	st *store.Store,
	fed *federation.Client,
	remoteNick, remoteDomain, callerID, localDomain string,
	allowPrivate bool,
) (*searchUsersOutput, error) {

	badRequest := &statusError{ErrorMessage: "invalid search query", code: http.StatusBadRequest}

	if remoteNick == "" || remoteDomain == "" || utf8.RuneCountInString(remoteNick) < service.MinSearchRunes {
		return nil, badRequest
	}

	if !service.IsValidRemoteDomainFor(remoteDomain, allowPrivate) {
		return nil, badRequest
	}

	if remoteDomain == localDomain {
		users := filterBlockedUsers(ctx, st, callerID, st.SearchUsers(ctx, remoteNick, callerID))

		return &searchUsersOutput{Body: struct {
			Users []model.PublicUser `json:"users"`
		}{Users: users}}, nil
	}

	if fed == nil {
		return nil, &statusError{ErrorMessage: "remote search failed", code: http.StatusBadGateway}
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
		return nil, &statusError{ErrorMessage: msgFailedParseRemote, code: http.StatusInternalServerError}
	}

	if result.Users == nil {
		result.Users = []model.PublicUser{}
	}

	if len(result.Users) > maxFederatedSearchResults {
		result.Users = result.Users[:maxFederatedSearchResults]
	}
	result.Users = filterBlockedUsers(ctx, st, callerID, result.Users)

	// The peer is untrusted: keep only fields that are safe to render. An id
	// from another server would let a peer inject a local-looking account,
	// isAdmin would draw an admin badge, and a foreign avatarUrl would make
	// the browser fetch from an arbitrary host.
	validated := result.Users[:0]
	for idx := range result.Users {
		user := result.Users[idx]
		if service.RemoteServerFromIDFor(user.ID, allowPrivate) != remoteDomain {
			continue
		}
		user.IsAdmin = false
		user.AvatarURL = ""
		user.Online = false
		if user.Nick == "" {
			if before, _, has := strings.Cut(user.ID, ":"); has {
				user.Nick = before
			}
		}
		validated = append(validated, user)
	}
	result.Users = validated

	return &searchUsersOutput{Body: struct {
		Users []model.PublicUser `json:"users"`
	}{Users: result.Users}}, nil
}

// registerUserAvatar lets a user set or clear their profile avatar. The file
// must belong to the user and be an image; the file access rule in the
// service makes it readable to authenticated users.
func registerUserAvatar(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "update-user-avatar",
		Method:      http.MethodPost,
		Path:        "/api/users/avatar",
		Summary:     "Set the profile avatar by file ID",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *userAvatarInput) (*userAvatarOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		fileID := input.Body.FileID
		if fileID != "" {
			file, err := st.GetFile(ctx, fileID)
			if err != nil {
				return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusBadRequest}
			}
			if file.UploadedBy != user.ID {
				return nil, &statusError{ErrorMessage: "invalid avatar file", code: http.StatusBadRequest}
			}
			if !strings.HasPrefix(file.MimeType, "image/") {
				return nil, &statusError{ErrorMessage: "avatar must be an image", code: http.StatusBadRequest}
			}
		}

		updated, err := st.UpdateUserAvatar(ctx, user.ID, fileID)
		if err != nil {
			return nil, &statusError{ErrorMessage: msgUserNotFound, code: http.StatusNotFound}
		}

		var out userAvatarOutput
		out.Body.User = updated.Public()
		return &out, nil
	})
}

type userAvatarInput struct {
	Body struct {
		FileID string `json:"fileId"`
	}
}

type userAvatarOutput struct {
	Body struct {
		User model.PublicUser `json:"user"`
	}
}
