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
		if user, ok := s.store.GetUserByID(ctx, id); ok {
			out = append(out, user.Public())
		}
	}
	return out
}

func (s *Service) IsBlockedBetween(ctx context.Context, firstID, secondID string) bool {
	return s.store.IsBlockedBetween(ctx, firstID, secondID)
}
