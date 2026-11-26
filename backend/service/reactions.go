package service

import (
	"context"
	"errors"
	"strings"
	"time"
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

// ApplyFederatedReaction stores a reaction change relayed by a peer at the
// instant the source server recorded it. The timestamp lets a delayed retry
// lose against a newer opposite action instead of resurrecting old state.
func (s *Service) ApplyFederatedReaction(
	ctx context.Context,
	chat *model.Chat,
	messageID, userID, emoji string,
	add bool,
	at time.Time,
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
		err = s.store.AddMessageReactionAt(ctx, messageID, userID, emoji, at)
	} else {
		err = s.store.RemoveMessageReactionAt(ctx, messageID, userID, emoji, at)
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

// RelayReaction forwards a reaction change to the other servers that hold the
// chat. exceptPeer skips the server the change came from, so an inbound relay
// is not echoed back.
func (s *Service) RelayReaction(
	ctx context.Context,
	chat *model.Chat,
	messageID, userID, emoji string,
	add bool,
	at time.Time,
	exceptPeer string,
) {

	if s == nil || s.cfg == nil || s.fed == nil || chat == nil {
		return
	}

	body := map[string]any{
		"userId": userID,
		"emoji":  emoji,
		"add":    add,
		"at":     at,
	}
	path := "/api/federated/chats/" + chat.ID + "/messages/" + messageID + "/reactions"

	targets := make(map[string]struct{})
	if chat.RemoteServer != "" {
		targets[chat.RemoteServer] = struct{}{}
	} else if chat.Type == chatTypeGroup {
		for _, memberID := range chat.Members {
			domain := s.remoteServerFromID(memberID)
			if domain != "" {
				targets[domain] = struct{}{}
			}
		}
	}

	for domain := range targets {
		if domain == s.cfg.Server.Domain || domain == exceptPeer {
			continue
		}
		s.queueFederation(ctx, domain, "POST", path, body)
	}
}
