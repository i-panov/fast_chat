package service

import (
	"context"
	"encoding/json"
	"strings"

	"fast_chat/model"
)

// PushPayload is the WebPush notification payload sent to clients.
type PushPayload struct {
	Title string          `json:"title"`
	Body  string          `json:"body,omitempty"`
	Tag   string          `json:"tag"`
	Data  PushPayloadData `json:"data"`
}

// PushPayloadData carries the deep-link target of a push notification.
type PushPayloadData struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	ThreadID  string `json:"threadId,omitempty"`
}

// IsValidPushEndpoint reports whether the endpoint belongs to a trusted push
// service. The allowlist blocks an attacker from pointing push subscriptions
// at an arbitrary URL.
func IsValidPushEndpoint(endpoint string) bool {
	prefixes := []string{
		"https://fcm.googleapis.com/",
		"https://updates.push.services.mozilla.com/",
		"https://push.apple.com/",
	}

	for _, prefix := range prefixes {
		if strings.HasPrefix(endpoint, prefix) {
			return true
		}
	}

	return false
}

// SendPushForMessage sends a push notification for a message to an offline
// recipient. It is a no-op when push is disabled or the recipient is online.
func (s *Service) SendPushForMessage(
	ctx context.Context,
	chatID string,
	msg *model.Message,
	threadID,
	recipientID string,
) {

	if s.push == nil || s.store.IsOnline(recipientID) {
		return
	}

	payload := PushPayload{
		Title: msg.FromNick,
		// The server does not know the recipient's language and the
		// message content is E2E-encrypted anyway; keep the body empty
		// so the notification is just the sender's nickname.
		Tag: "chat-" + chatID,
		Data: PushPayloadData{
			ChatID:    chatID,
			MessageID: msg.ID,
			ThreadID:  threadID,
		},
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}

	subs, err := s.store.GetPushSubscriptionsByUser(ctx, recipientID)
	if err != nil || len(subs) == 0 {
		return
	}

	go s.push.SendToUser(raw, subs)
}
