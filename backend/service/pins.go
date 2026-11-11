package service

import (
	"context"

	"fast_chat/model"
	"fast_chat/sse"
)

// PinMessage pins a message in a chat and notifies all members.
func (s *Service) PinMessage(ctx context.Context, chat *model.Chat, messageID, userID string) error {
	if _, err := s.store.GetMessage(ctx, chat.ID, messageID); err != nil {
		return ErrMessageNotFound
	}
	if err := s.store.PinMessage(ctx, chat.ID, messageID, userID); err != nil {
		return err
	}
	s.broadcastPin(chat, messageID, true)

	return nil
}

func (s *Service) UnpinMessage(ctx context.Context, chat *model.Chat, messageID string) error {
	if err := s.store.UnpinMessage(ctx, chat.ID, messageID); err != nil {
		return err
	}
	s.broadcastPin(chat, messageID, false)

	return nil
}

func (s *Service) broadcastPin(chat *model.Chat, messageID string, pinned bool) {
	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{
			Event: eventChatPinned,
			Data: map[string]any{
				keyChatID:    chat.ID,
				keyMessageID: messageID,
				keyPinned:    pinned,
			},
		})
	}
}

// PinnedMessages returns the pinned messages of a chat with files, reactions
// and the read metadata of the requesting user.
func (s *Service) PinnedMessages(ctx context.Context, chat *model.Chat, userID string) ([]MessageWithStatus, error) {
	messages, err := s.store.GetPinnedMessages(ctx, chat.ID)
	if err != nil {
		return nil, err
	}
	return s.EnrichMessagesWithStatuses(ctx, messages, chat, userID, nil), nil
}
