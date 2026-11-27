package service

import (
	"context"
	"errors"

	"fast_chat/model"
)

var (
	ErrUserBlocked     = errors.New("user is blocked")
	ErrCannotBlockSelf = errors.New("cannot block yourself")
)

func (s *Service) BlockUser(ctx context.Context, blockerID, blockedID string) error {
	if blockerID == blockedID {
		return ErrCannotBlockSelf
	}
	return s.store.BlockUser(ctx, blockerID, blockedID)
}

func (s *Service) UnblockUser(ctx context.Context, blockerID, blockedID string) error {
	return s.store.UnblockUser(ctx, blockerID, blockedID)
}

// BlockedUsers returns the list shown in the account settings.
func (s *Service) BlockedUsers(ctx context.Context, userID string) []model.PublicUser {
	ids, err := s.store.BlockedIDs(ctx, userID)
	if err != nil || len(ids) == 0 {
		return []model.PublicUser{}
	}
	out := make([]model.PublicUser, 0, len(ids))
	for _, id := range ids {
		out = append(out, s.store.PublicUserByID(ctx, id))
	}
	return out
}

func (s *Service) IsBlockedBetween(ctx context.Context, firstID, secondID string) bool {
	return s.store.IsBlockedBetween(ctx, firstID, secondID)
}

// ensureNotBlocked rejects a chat action that would reach a member who blocked
// the actor (or whom the actor blocked) in a private chat. Blocking has to
// silence every channel, not only new messages: typing indicators, read
// receipts, edits and deletes are all a way to keep contacting the blocker.
func (s *Service) ensureNotBlocked(ctx context.Context, chat *model.Chat, userID string) error {
	if chat == nil || chat.Type != callChatTypePrivate {
		return nil
	}

	for _, memberID := range chat.Members {
		if memberID != userID && s.IsBlockedBetween(ctx, userID, memberID) {
			return ErrUserBlocked
		}
	}

	return nil
}
