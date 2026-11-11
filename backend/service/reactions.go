package service

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
)

var ErrInvalidReaction = errors.New("invalid reaction")

const maxReactionRunes = 16

// AddReaction stores the user's emoji on a message and broadcasts the new
// aggregate to every chat member, each with their own "me" flag.
func (s *Service) AddReaction(
	ctx context.Context,
	chat *model.Chat,
	messageID, userID, emoji string,
) ([]model.ReactionSummary, error) {

	return s.toggleReaction(ctx, chat, messageID, userID, emoji, true)
}

func (s *Service) RemoveReaction(
	ctx context.Context,
	chat *model.Chat,
	messageID, userID, emoji string,
) ([]model.ReactionSummary, error) {

	return s.toggleReaction(ctx, chat, messageID, userID, emoji, false)
}

func (s *Service) toggleReaction(
	ctx context.Context,
	chat *model.Chat,
	messageID, userID, emoji string,
	add bool,
) ([]model.ReactionSummary, error) {

	emoji = strings.TrimSpace(emoji)
	if emoji == "" || utf8.RuneCountInString(emoji) > maxReactionRunes {
		return nil, ErrInvalidReaction
	}
	if _, err := s.store.GetMessage(ctx, chat.ID, messageID); err != nil {
		return nil, ErrMessageNotFound
	}

	var err error
	if add {
		err = s.store.AddMessageReaction(ctx, messageID, userID, emoji)
	} else {
		err = s.store.RemoveMessageReaction(ctx, messageID, userID, emoji)
	}
	if err != nil {
		return nil, err
	}

	rows, err := s.store.GetMessageReactionRows(ctx, messageID)
	if err != nil {
		return nil, err
	}
	s.broadcastReactions(chat, messageID, rows)

	return reactionSummaries(rows, userID), nil
}

func (s *Service) broadcastReactions(chat *model.Chat, messageID string, rows []model.MessageReaction) {
	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{
			Event: eventMessageReactions,
			Data: map[string]any{
				keyChatID:    chat.ID,
				keyMessageID: messageID,
				keyReactions: reactionSummaries(rows, memberID),
			},
		})
	}
}

func reactionSummaries(rows []model.MessageReaction, viewerID string) []model.ReactionSummary {
	out := make([]model.ReactionSummary, 0, len(rows))
	for _, row := range rows {
		found := false
		for idx := range out {
			if out[idx].Emoji != row.Emoji {
				continue
			}
			out[idx].Count++
			if row.UserID == viewerID {
				out[idx].Me = true
			}
			found = true
			break
		}
		if !found {
			out = append(out, model.ReactionSummary{
				Emoji: row.Emoji,
				Count: 1,
				Me:    row.UserID == viewerID,
			})
		}
	}
	return out
}

// attachReactions fills the reaction aggregates of a message page in one
// batched query.
func (s *Service) attachReactions(ctx context.Context, messages []model.Message, viewerID string) {
	if len(messages) == 0 {
		return
	}
	ids := make([]string, len(messages))
	for i := range messages {
		ids[i] = messages[i].ID
	}
	reactions, err := s.store.GetReactionsForMessages(ctx, ids, viewerID)
	if err != nil {
		return
	}
	for i := range messages {
		messages[i].Reactions = reactions[messages[i].ID]
	}
}
