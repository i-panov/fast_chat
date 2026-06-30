package handler

import (
	"net/http"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
)

const (
	typingThrottleInterval = 2 * time.Second
)

func (h *Handler) HandleTyping(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)
		return
	}

	var req struct {
		Active bool `json:"active"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if !req.Active {
		h.sendTypingEvent(r, chat, chatID, user.ID, user.Nick, "typing_stop", nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	key := chatID + ":" + user.ID
	if last, ok := h.hub.LoadLastTyping(key); ok {
		if time.Since(last.(time.Time)) < typingThrottleInterval { //nolint:errcheck
			writeJSON(w, http.StatusOK, map[string]string{"status": "throttled"})
			return
		}
	}

	h.hub.StoreLastTyping(key, time.Now())

	h.sendTypingEvent(r, chat, chatID, user.ID, user.Nick, "typing", map[string]string{
		"chatId": chatID,
		"userId": user.ID,
		"nick":   user.Nick,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// sendTypingEvent dispatches a typing indicator to all chat members (local and remote).
// extra fields override the default typing_stop payload when supplied.
func (h *Handler) sendTypingEvent(r *http.Request, chat *model.Chat, chatID, userID, nick, eventName string, extra map[string]string) {
	payload := map[string]string{
		"chatId": chatID,
		"userId": userID,
	}

	for k, v := range extra {
		payload[k] = v
	}

	event := sse.Event{Event: eventName, Data: payload}

	for _, memberID := range chat.Members {
		if memberID != userID {
			h.hub.Send(memberID, event)
		}
	}

	h.sendFedPost(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/typing", map[string]any{
		"userId": userID,
		"active": eventName == "typing",
		"nick":   nick,
	})
}
