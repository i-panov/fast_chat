package transport

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
)

func registerChatPins(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "pin-message",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/pins/{messageId}",
		Summary:     "Pin a message in a chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *pinMessageInput) (*statusOutput, error) {
		chat, user, err := pinChat(ctx, svc, input.ID)
		if err != nil {
			return nil, err
		}
		if err := svc.PinMessage(ctx, chat, input.MessageID, user.ID); err != nil {
			return nil, messageOrInternalError(err)
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "unpin-message",
		Method:      http.MethodDelete,
		Path:        "/api/chats/{id}/pins/{messageId}",
		Summary:     "Unpin a message in a chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *pinMessageInput) (*statusOutput, error) {
		chat, _, err := pinChat(ctx, svc, input.ID)
		if err != nil {
			return nil, err
		}
		if err := svc.UnpinMessage(ctx, chat, input.MessageID); err != nil {
			return nil, messageOrInternalError(err)
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-pinned-messages",
		Method:      http.MethodGet,
		Path:        "/api/chats/{id}/pins",
		Summary:     "List pinned messages of a chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *pinListInput) (*pinnedMessagesOutput, error) {
		chat, user, err := pinChat(ctx, svc, input.ID)
		if err != nil {
			return nil, err
		}
		messages, err := svc.PinnedMessages(ctx, chat, user.ID)
		if err != nil {
			return nil, messageOrInternalError(err)
		}
		var out pinnedMessagesOutput
		out.Body.Messages = messages
		if out.Body.Messages == nil {
			out.Body.Messages = []service.MessageWithStatus{}
		}
		return &out, nil
	})
}

func pinChat(ctx context.Context, svc *service.Service, chatID string) (*model.Chat, *authUser, error) {
	user, ok := userFromContext(ctx)
	if !ok {
		return nil, nil, errUnauthorized
	}
	chat, err := requireChatMember(ctx, svc, chatID, user.ID)
	if err != nil {
		return nil, nil, err
	}
	if chat.Type == chatTypeGroup && !service.IsOwner(chat, user.ID) {
		return nil, nil, &statusError{ErrorMessage: "only owner can perform this action", code: http.StatusForbidden}
	}
	return chat, user, nil
}

type pinMessageInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
}

type pinListInput struct {
	ID string `path:"id"`
}

type pinnedMessagesOutput struct {
	Body struct {
		Messages []service.MessageWithStatus `json:"messages"`
	}
}
