package handler

import (
	"log/slog"
	"net/http"
	"strconv"

	"fast_chat/model"
	"fast_chat/service"
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

	thread, err := h.svc.CreateThread(r.Context(), chat, chatID, messageID)
	if err != nil {
		if messageError(w, err) {
			return
		}

		slog.Error("failed to create thread", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
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

	limit := service.DefaultMessagesLimit

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= service.MaxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor := h.svc.GetThreadMessages(r.Context(), threadID, limit, before)
	if messages == nil {
		messages = []model.Message{}
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

	threads := h.svc.GetThreads(r.Context(), chatID)

	WriteJSON(w, http.StatusOK, map[string]any{"threads": threads})
}
