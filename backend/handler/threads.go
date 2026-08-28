package handler

import (
	"log/slog"
	"net/http"
	"strconv"

	"fast_chat/model"
	"fast_chat/sse"
)

func (h *Handler) CreateThread(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	msg, err := h.store.GetMessage(r.Context(), chatID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	if _, exists := h.store.GetThread(r.Context(), chatID); exists {
		writeError(w, http.StatusBadRequest, "cannot create thread on a thread message")
		return
	}

	if _, exists := h.store.GetThreadByParentMessage(r.Context(), chatID, messageID); exists {
		writeError(w, http.StatusConflict, "thread already exists")
		return
	}

	thread, err := h.store.CreateThread(r.Context(), chatID, messageID, msg.Text, msg.FromNick)
	if err != nil {
		slog.Error("failed to create thread", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "thread_created", Data: thread})
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"thread": thread})
}

func (h *Handler) GetThreadMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	threadID := r.PathValue("threadId")

	thread, ok := h.store.GetThread(r.Context(), threadID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyThreadNotFound)
		return
	}

	chat := h.requireChatMember(w, r, thread.ChatID, user.ID)
	if chat == nil {
		return
	}

	limit := defaultMessagesLimit

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= maxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetThreadMessagesPaginated(r.Context(), threadID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	if len(messages) > 0 {
		ids := make([]string, len(messages))
		for i, m := range messages {
			ids[i] = m.ID
		}

		filesByMsg, err := h.store.GetMessageFilesBatch(r.Context(), ids)
		if err == nil {
			for i := range messages {
				messages[i].Files = filesByMsg[messages[i].ID]
			}
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func (h *Handler) GetThreads(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	threads := h.store.GetThreadsForChat(r.Context(), chatID)

	WriteJSON(w, http.StatusOK, map[string]any{"threads": threads})
}
