package transport

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
)

func registerMessageReactions(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "add-message-reaction",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/messages/{messageId}/reactions",
		Summary:     "Add an emoji reaction to a message",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *addReactionInput) (*reactionOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}
		reactions, err := svc.AddReaction(ctx, chat, input.MessageID, user.ID, input.Body.Emoji)
		if err != nil {
			return nil, messageOrInternalError(err)
		}
		relayReaction(ctx, svc, chat, input.MessageID, user.ID, input.Body.Emoji, true)
		return reactionResponse(reactions), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "remove-message-reaction",
		Method:      http.MethodDelete,
		Path:        "/api/chats/{id}/messages/{messageId}/reactions/{emoji}",
		Summary:     "Remove an emoji reaction from a message",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *removeReactionInput) (*reactionOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}
		reactions, err := svc.RemoveReaction(ctx, chat, input.MessageID, user.ID, input.Emoji)
		if err != nil {
			return nil, messageOrInternalError(err)
		}
		relayReaction(ctx, svc, chat, input.MessageID, user.ID, input.Emoji, false)
		return reactionResponse(reactions), nil
	})
}

func reactionResponse(reactions []model.ReactionSummary) *reactionOutput {
	var out reactionOutput
	out.Body.Reactions = reactions
	if out.Body.Reactions == nil {
		out.Body.Reactions = []model.ReactionSummary{}
	}
	return &out
}

type addReactionInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
	Body      struct {
		Emoji string `json:"emoji"`
	}
}

type removeReactionInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
	Emoji     string `path:"emoji"`
}

type reactionOutput struct {
	Body struct {
		Reactions []model.ReactionSummary `json:"reactions"`
	}
}

// relayReaction forwards a local reaction change to the peer servers.
func relayReaction(
	ctx context.Context,
	svc *service.Service,
	chat *model.Chat,
	messageID, userID, emoji string,
	add bool,
) {

	svc.RelayReaction(ctx, chat, messageID, userID, emoji, add, time.Now().UTC(), "")
}
