package transport

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
)

type adminUsersInput struct {
	Query  string `query:"query"`
	Limit  int    `query:"limit"`
	Offset int    `query:"offset"`
}

type adminUsersOutput struct {
	Body service.AdminUserPage
}

type adminChatsInput struct {
	Query  string `query:"query"`
	Limit  int    `query:"limit"`
	Offset int    `query:"offset"`
}

type adminChatsOutput struct {
	Body service.AdminChatPage
}

type adminUserPatchInput struct {
	UserID string `path:"userId"`
	Body   struct {
		IsAdmin *bool `json:"isAdmin,omitempty"`
		Banned  *bool `json:"banned,omitempty"`
	}
}

type adminChatPathInput struct {
	ChatID string `path:"chatId"`
}

type adminMessagesInput struct {
	ChatID string `path:"chatId"`
	Limit  int    `query:"limit"`
	Before string `query:"before"`
}

type adminMessagesOutput struct {
	Body struct {
		Messages   []model.Message `json:"messages"`
		NextCursor string          `json:"nextCursor,omitempty"`
		HasMore    bool            `json:"hasMore"`
	}
}

type adminMessagePathInput struct {
	ChatID    string `path:"chatId"`
	MessageID string `path:"messageId"`
}

type adminBotsOutput struct {
	Body struct {
		Bots []service.AdminBotView `json:"bots"`
	}
}

type adminBotPatchInput struct {
	BotID string `path:"botId"`
	Body  struct {
		IsActive *bool `json:"isActive,omitempty"`
	}
}

type adminPeersOutput struct {
	Body struct {
		Peers []string `json:"peers"`
	}
}

type adminAuditInput struct {
	Limit int `query:"limit"`
}

type adminAuditOutput struct {
	Body struct {
		Entries []model.AdminAuditLog `json:"entries"`
	}
}

// RegisterAdmin adds the moderation endpoints. Every operation declares the
// bearer scheme and re-checks the administrator role in the service.
//
//nolint:funlen,gocognit,gocyclo,cyclop,dupl,maintidx // one function registers the whole moderation surface, mirroring registerBots.
func RegisterAdmin(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-users",
		Method:      http.MethodGet,
		Path:        "/api/admin/users",
		Summary:     "List accounts (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminUsersInput) (*adminUsersOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		page, err := svc.AdminListUsers(ctx, user.ID, input.Query, input.Limit, input.Offset)
		if err != nil {
			return nil, mapAdminError(err)
		}

		return &adminUsersOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-patch-user",
		Method:      http.MethodPatch,
		Path:        "/api/admin/users/{userId}",
		Summary:     "Grant the admin role or ban an account",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminUserPatchInput) (*statusOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		if input.Body.IsAdmin == nil && input.Body.Banned == nil {
			return nil, &statusError{ErrorMessage: "nothing to update", code: http.StatusBadRequest}
		}
		if input.Body.IsAdmin != nil {
			if err := svc.AdminSetUserAdmin(ctx, user.ID, input.UserID, *input.Body.IsAdmin); err != nil {
				return nil, mapAdminError(err)
			}
		}
		if input.Body.Banned != nil {
			if err := svc.AdminSetUserBanned(ctx, user.ID, input.UserID, *input.Body.Banned); err != nil {
				return nil, mapAdminError(err)
			}
		}

		return adminStatusOK(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-chats",
		Method:      http.MethodGet,
		Path:        "/api/admin/chats",
		Summary:     "List chats (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminChatsInput) (*adminChatsOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		page, err := svc.AdminListChats(ctx, user.ID, input.Query, input.Limit, input.Offset)
		if err != nil {
			return nil, mapAdminError(err)
		}

		return &adminChatsOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-delete-chat",
		Method:      http.MethodDelete,
		Path:        "/api/admin/chats/{chatId}",
		Summary:     "Delete a chat (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminChatPathInput) (*statusOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		if err := svc.AdminDeleteChat(ctx, user.ID, input.ChatID); err != nil {
			return nil, mapAdminError(err)
		}

		return adminStatusOK(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-messages",
		Method:      http.MethodGet,
		Path:        "/api/admin/chats/{chatId}/messages",
		Summary:     "List the messages of a chat (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminMessagesInput) (*adminMessagesOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		messages, next, hasMore, err := svc.AdminListMessages(ctx, user.ID, input.ChatID, input.Limit, input.Before)
		if err != nil {
			return nil, mapAdminError(err)
		}
		if messages == nil {
			// An empty page must serialize as []: the client maps the list
			// and null would crash the moderation screen.
			messages = []model.Message{}
		}
		out := &adminMessagesOutput{}
		out.Body.Messages = messages
		out.Body.NextCursor = next
		out.Body.HasMore = hasMore

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-delete-message",
		Method:      http.MethodDelete,
		Path:        "/api/admin/chats/{chatId}/messages/{messageId}",
		Summary:     "Delete a message (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminMessagePathInput) (*statusOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		if err := svc.AdminDeleteMessage(ctx, user.ID, input.ChatID, input.MessageID); err != nil {
			return nil, mapAdminError(err)
		}

		return adminStatusOK(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-bots",
		Method:      http.MethodGet,
		Path:        "/api/admin/bots",
		Summary:     "List bots (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*adminBotsOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		bots, err := svc.AdminListBots(ctx, user.ID)
		if err != nil {
			return nil, mapAdminError(err)
		}
		out := &adminBotsOutput{}
		out.Body.Bots = bots

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-patch-bot",
		Method:      http.MethodPatch,
		Path:        "/api/admin/bots/{botId}",
		Summary:     "Enable or disable a bot (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminBotPatchInput) (*statusOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		if input.Body.IsActive == nil {
			return nil, &statusError{ErrorMessage: "isActive is required", code: http.StatusBadRequest}
		}
		if err := svc.AdminSetBotActive(ctx, user.ID, input.BotID, *input.Body.IsActive); err != nil {
			return nil, mapAdminError(err)
		}

		return adminStatusOK(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-federation-peers",
		Method:      http.MethodGet,
		Path:        "/api/admin/federation/peers",
		Summary:     "List federated peers this server has data from",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*adminPeersOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		peers, err := svc.AdminListFederationPeers(ctx, user.ID)
		if err != nil {
			return nil, mapAdminError(err)
		}
		out := &adminPeersOutput{}
		out.Body.Peers = peers

		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-audit",
		Method:      http.MethodGet,
		Path:        "/api/admin/audit",
		Summary:     "List moderation actions (administrators only)",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *adminAuditInput) (*adminAuditOutput, error) {
		user, ok := adminFromContext(ctx)
		if !ok {
			return nil, errAdminForbidden
		}
		entries, err := svc.AdminListAudit(ctx, user.ID, input.Limit)
		if err != nil {
			return nil, mapAdminError(err)
		}
		out := &adminAuditOutput{}
		out.Body.Entries = entries

		return out, nil
	})
}

func adminStatusOK() *statusOutput {
	out := &statusOutput{}
	out.Body.Status = "ok"

	return out
}

var errAdminForbidden = &statusError{ErrorMessage: "administrator role required", code: http.StatusForbidden}

// mapAdminError keeps the moderation failures distinguishable: the screen
// tells "you cannot ban yourself" from "the account is gone".
func mapAdminError(err error) huma.StatusError { //nolint:ireturn // huma.StatusError is the required interface
	switch {
	case errors.Is(err, service.ErrAdminRequired):
		return errAdminForbidden
	case errors.Is(err, service.ErrAdminSelfAction):
		return &statusError{ErrorMessage: err.Error(), code: http.StatusBadRequest}
	case errors.Is(err, service.ErrAdminLastAdmin):
		return &statusError{ErrorMessage: err.Error(), code: http.StatusConflict}
	case errors.Is(err, service.ErrAdminTargetInvalid):
		return &statusError{ErrorMessage: err.Error(), code: http.StatusBadRequest}
	case errors.Is(err, service.ErrUserNotFound):
		return &statusError{ErrorMessage: msgUserNotFound, code: http.StatusNotFound}
	case errors.Is(err, service.ErrChatNotFound):
		return &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound}
	case errors.Is(err, service.ErrMessageNotFound):
		return &statusError{ErrorMessage: msgMessageNotFound, code: http.StatusNotFound}
	default:
		return errInternal
	}
}
