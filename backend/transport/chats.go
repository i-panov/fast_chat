package transport

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
)

// RegisterChats adds the chat CRUD operations (private and group chats).
func RegisterChats(api huma.API, svc *service.Service, fed *federation.Client, cfg *config.Config) {
	registerChatLifecycle(api, svc, fed, cfg)
	registerChatMembership(api, svc)
}

// registerChatLifecycle registers a subset of the operations.
func registerChatLifecycle(api huma.API, svc *service.Service, fed *federation.Client, cfg *config.Config) {
	registerChatCRUD(api, svc, fed, cfg)
	registerChatUpdateDelete(api, svc)
}

// registerChatCRUD registers list/create/get operations.
func registerChatCRUD(api huma.API, svc *service.Service, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "list-chats",
		Method:      http.MethodGet,
		Path:        "/api/chats",
		Summary:     "List the caller's chats",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*chatsOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		var out chatsOutput
		out.Body.Chats = svc.GetChats(ctx, user.ID)

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "create-chat",
		Method:      http.MethodPost,
		Path:        "/api/chats",
		Summary:     "Create a private or group chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *createChatInput) (*createChatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Body.Type == chatTypeGroup {
			view, err := svc.CreateGroupChat(ctx, user.ID, input.Body.Name, input.Body.MemberIDs)
			if err != nil {
				return nil, chatOrInternalError(err)
			}

			var out createChatOutput
			out.Body.Chat = view
			out.Status = http.StatusCreated

			return &out, nil
		}

		view, err := svc.CreatePrivateChat(ctx, user.ID, input.Body.WithUserID)
		if err != nil {
			return nil, chatOrInternalError(err)
		}

		remoteServer := service.RemoteServerFromID(input.Body.WithUserID)
		if remoteServer == cfg.Server.Domain {
			remoteServer = ""
		}

		memberIDs := make([]string, 0, len(view.Members))
		for _, member := range view.Members {
			memberIDs = append(memberIDs, member.ID)
		}

		fed.Post(ctx, remoteServer, "/api/federated/chats", map[string]any{
			"chatId":       view.ID,
			"members":      memberIDs,
			"remoteServer": cfg.Server.Domain,
		})

		var out createChatOutput
		out.Body.Chat = view
		out.Status = http.StatusCreated

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-chat",
		Method:      http.MethodGet,
		Path:        pathChatByID,
		Summary:     "Fetch one chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *chatPathInput) (*chatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		var out chatOutput
		out.Body.Chat = svc.EnrichChat(ctx, chat)

		return &out, nil
	})
}

// registerChatUpdateDelete registers update/delete operations.
func registerChatUpdateDelete(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "update-chat",
		Method:      http.MethodPatch,
		Path:        pathChatByID,
		Summary:     "Rename a group chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *updateChatInput) (*chatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireGroupOwner(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		// If no updatable field is present, echo the current chat unchanged.
		if input.Body.Name == nil {
			var out chatOutput
			out.Body.Chat = svc.EnrichChat(ctx, chat)

			return &out, nil
		}

		updatedView, err := svc.UpdateChatName(ctx, input.ID, *input.Body.Name)
		if err != nil {
			return nil, chatOrInternalError(err)
		}

		var out chatOutput
		out.Body.Chat = updatedView

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-chat",
		Method:      http.MethodDelete,
		Path:        pathChatByID,
		Summary:     "Delete a group chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *chatPathInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireGroupOwner(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		if err := svc.DeleteChat(ctx, chat); err != nil {
			slog.Error("failed to delete chat", "err", err)
			return nil, errInternal
		}

		return deletedStatus(), nil
	})
}

// registerChatMembership registers a subset of the operations.
func registerChatMembership(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "add-chat-member",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/members",
		Summary:     "Add a member to a group chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *addChatMemberInput) (*chatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if _, err := requireGroupOwner(ctx, svc, input.ID, user.ID); err != nil {
			return nil, err
		}

		updatedView, err := svc.AddChatMember(ctx, input.ID, input.Body.UserID)
		if err != nil {
			return nil, badRequestOrMapped(err, "failed to add member")
		}

		var out chatOutput
		out.Body.Chat = updatedView

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "remove-chat-member",
		Method:      http.MethodDelete,
		Path:        "/api/chats/{id}/members/{userId}",
		Summary:     "Remove a member from a group chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *chatMemberPathInput) (*chatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		if chat.Type != chatTypeGroup {
			return nil, &statusError{ErrorMessage: "only group chats can remove members", code: http.StatusBadRequest}
		}

		if input.UserID != user.ID && !service.IsOwner(chat, user.ID) {
			return nil, &statusError{ErrorMessage: "only owner can remove other members", code: http.StatusForbidden}
		}

		if service.IsOwner(chat, input.UserID) {
			return nil, &statusError{
				ErrorMessage: "owner cannot leave the group; delete the group instead",
				code:         http.StatusBadRequest,
			}
		}

		updatedView, err := svc.RemoveChatMember(ctx, input.ID, input.UserID, user.ID)
		if err != nil {
			return nil, badRequestOrMapped(err, "failed to remove member")
		}

		var out chatOutput
		out.Body.Chat = updatedView

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-chat-avatar",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/avatar",
		Summary:     "Set a group chat avatar by file ID",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *chatAvatarInput) (*chatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if _, err := requireGroupOwner(ctx, svc, input.ID, user.ID); err != nil {
			return nil, err
		}

		updatedView, err := svc.UpdateChatAvatar(ctx, input.ID, input.Body.FileID)
		if err != nil {
			return nil, chatOrInternalError(err)
		}

		var out chatOutput
		out.Body.Chat = updatedView

		return &out, nil
	})
}

// Shared chat-domain constants.
const (
	chatTypeGroup = "group"
	pathChatByID  = "/api/chats/{id}"
)

// chatOrInternalError maps chat-domain errors, logging and converting
// unmapped ones to a 500 (legacy parity).
func chatOrInternalError(err error) error {
	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("chat operation failed", "err", err)

	return errInternal
}

// badRequestOrMapped maps a sentinel error if recognized, otherwise returns
// the legacy fallback message with status 400.
func badRequestOrMapped(err error, fallbackMessage string) error {
	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("chat member operation failed", "err", err)

	return &statusError{ErrorMessage: fallbackMessage, code: http.StatusBadRequest}
}

// requireChatMember loads the chat and verifies membership, mirroring the
// legacy helper's statuses and messages.
func requireChatMember(ctx context.Context, svc *service.Service, chatID, userID string) (*model.Chat, error) {
	chat, err := svc.Chat(ctx, chatID)
	if err != nil {
		return nil, &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound}
	}

	if !service.IsMember(chat, userID) {
		return nil, &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
	}

	return chat, nil
}

// requireGroupOwner loads the chat, verifies membership, group type, and
// ownership — mirroring the legacy helper.
func requireGroupOwner(ctx context.Context, svc *service.Service, chatID, userID string) (*model.Chat, error) {
	chat, err := requireChatMember(ctx, svc, chatID, userID)
	if err != nil {
		return nil, err
	}

	if chat.Type != chatTypeGroup {
		return nil, &statusError{ErrorMessage: "only group chats can be updated", code: http.StatusBadRequest}
	}

	if !service.IsOwner(chat, userID) {
		return nil, &statusError{ErrorMessage: "only owner can perform this action", code: http.StatusForbidden}
	}

	return chat, nil
}

func deletedStatus() *statusOutput {
	var out statusOutput
	out.Body.Status = "deleted"

	return &out
}

type chatPathInput struct {
	ID string `path:"id"`
}

type chatMemberPathInput struct {
	ID     string `path:"id"`
	UserID string `path:"userId"`
}

type chatsOutput struct {
	Body struct {
		Chats []service.ChatView `json:"chats"`
	}
}

type createChatInput struct {
	Body struct {
		Type       string   `json:"type,omitempty"`
		WithUserID string   `json:"withUserId,omitempty"`
		Name       string   `json:"name,omitempty"`
		MemberIDs  []string `json:"memberIDs,omitempty"`
	}
}

type createChatOutput struct {
	Status int
	Body   struct {
		Chat service.ChatView `json:"chat"`
	}
}

func (o *createChatOutput) GetStatus() int {
	return o.Status
}

type chatOutput struct {
	Body struct {
		Chat service.ChatView `json:"chat"`
	}
}

type updateChatInput struct {
	ID   string `path:"id"`
	Body struct {
		Name *string `json:"name,omitempty"`
	}
}

type addChatMemberInput struct {
	ID   string `path:"id"`
	Body struct {
		UserID string `json:"userId,omitempty"`
	}
}

type chatAvatarInput struct {
	ID   string `path:"id"`
	Body struct {
		FileID string `json:"fileId,omitempty"`
	}
}
