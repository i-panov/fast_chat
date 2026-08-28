package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"fast_chat/model"
)

type pushPayload struct {
	Title string          `json:"title"`
	Body  string          `json:"body,omitempty"`
	Tag   string          `json:"tag"`
	Data  pushPayloadData `json:"data"`
}

type pushPayloadData struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	ThreadID  string `json:"threadId,omitempty"`
}

func (h *Handler) sendPushForMessage(ctx context.Context, chatID string, msg *model.Message, threadID, recipientID string) {
	if h.pushService == nil || h.store.IsOnline(recipientID) {
		return
	}

	payload := pushPayload{
		Title: msg.FromNick,
		// The server does not know the recipient's language and the
		// message content is E2E-encrypted anyway; keep the body empty
		// so the notification is just the sender's nickname.
		Tag: "chat-" + chatID,
		Data: pushPayloadData{
			ChatID:    chatID,
			MessageID: msg.ID,
			ThreadID:  threadID,
		},
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}

	subs, err := h.store.GetPushSubscriptionsByUser(ctx, recipientID)
	if err != nil || len(subs) == 0 {
		return
	}

	go h.pushService.SendToUser(raw, subs)
}

func (h *Handler) VapidPublicKey(w http.ResponseWriter, r *http.Request) {
	if h.pushService == nil {
		writeError(w, http.StatusNotFound, "push not configured")

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"publicKey": h.pushService.PublicKey()})
}

func (h *Handler) SubscribePush(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Endpoint string `json:"endpoint"`
		P256DH   string `json:"p256dh"` //nolint:tagliatelle // field names fixed by the Web Push protocol
		Auth     string `json:"auth"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")

		return
	}

	if req.Endpoint == "" || req.P256DH == "" || req.Auth == "" {
		writeError(w, http.StatusBadRequest, "endpoint, p256dh, and auth are required")

		return
	}

	if !isValidPushEndpoint(req.Endpoint) {
		writeError(w, http.StatusBadRequest, "invalid push endpoint")

		return
	}

	sub, err := h.store.AddPushSubscription(r.Context(), user.ID, req.Endpoint, req.P256DH, req.Auth)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save subscription")

		return
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"subscription": sub})
}

func isValidPushEndpoint(endpoint string) bool {
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

func (h *Handler) UnsubscribePush(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Endpoint string `json:"endpoint"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")

		return
	}

	if req.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint is required")

		return
	}

	if err := h.store.DeletePushSubscription(r.Context(), user.ID, req.Endpoint); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete subscription")

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
