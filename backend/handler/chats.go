package handler

import (
	"errors"
	"net/http"

	"fast_chat/service"
)

// chatError maps a service chat error to an HTTP error response and reports
// whether the response was written. Non-sentinel errors are transport errors
// left to the caller for logging/status.
func chatError(w http.ResponseWriter, err error) bool {
	var mnf *service.GroupMemberNotFoundError
	switch {
	case errors.As(err, &mnf):
		writeError(w, http.StatusNotFound, mnf.Error())
	case errors.Is(err, service.ErrChatNotFound):
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
	case errors.Is(err, service.ErrUserNotFound):
		writeError(w, http.StatusNotFound, errKeyUserNotFound)
	case errors.Is(err, service.ErrWithUserRequired):
		writeError(w, http.StatusBadRequest, "withUserId required for private chat")
	case errors.Is(err, service.ErrChatWithSelf):
		writeError(w, http.StatusBadRequest, "cannot chat with yourself")
	case errors.Is(err, service.ErrGroupNameInvalid):
		writeError(w, http.StatusBadRequest, "group name must be 1-60 characters")
	case errors.Is(err, service.ErrTooManyMembers):
		writeError(w, http.StatusBadRequest, "too many members")
	case errors.Is(err, service.ErrGroupRemoteMemb):
		writeError(w, http.StatusBadRequest, "group chat members must be on the same server")
	case errors.Is(err, service.ErrUserIDRequired):
		writeError(w, http.StatusBadRequest, "userId required")
	case errors.Is(err, service.ErrRemoteMember):
		writeError(w, http.StatusBadRequest, "members must be on the same server")
	case errors.Is(err, service.ErrFileIDRequired):
		writeError(w, http.StatusBadRequest, "fileId required")
	case errors.Is(err, service.ErrFileNotFound):
		writeError(w, http.StatusNotFound, "file not found")
	default:
		return false
	}

	return true
}

func (h *Handler) GetChats(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	WriteJSON(w, http.StatusOK, map[string]any{"chats": h.svc.GetChats(r.Context(), user.ID)})
}

func (h *Handler) CreateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Type       string   `json:"type"`
		WithUserID string   `json:"withUserId"`
		Name       string   `json:"name"`
		MemberIDs  []string `json:"memberIDs"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if req.Type == "group" {
		chatView, err := h.svc.CreateGroupChat(r.Context(), user.ID, req.Name, req.MemberIDs)
		if err != nil {
			if !chatError(w, err) {
				writeError(w, http.StatusBadRequest, "failed to create group chat")
			}

			return
		}

		WriteJSON(w, http.StatusCreated, map[string]any{"chat": chatView})

		return
	}

	chatView, err := h.svc.CreatePrivateChat(r.Context(), user.ID, req.WithUserID)
	if err != nil {
		if !chatError(w, err) {
			logger.Error("failed to create chat", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	remoteServer := service.RemoteServerFromID(req.WithUserID)
	if remoteServer == h.cfg.Server.Domain {
		remoteServer = ""
	}

	memberIDs := make([]string, 0, len(chatView.Members))
	for _, m := range chatView.Members {
		memberIDs = append(memberIDs, m.ID)
	}

	h.sendFedPost(r.Context(), remoteServer, "/api/federated/chats", map[string]any{
		"chatId":       chatView.ID,
		"members":      memberIDs,
		"remoteServer": h.cfg.Server.Domain,
	})

	WriteJSON(w, http.StatusCreated, map[string]any{"chat": chatView})
}

func (h *Handler) GetChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": h.svc.EnrichChat(r.Context(), chat)})
}

func (h *Handler) UpdateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireGroupOwner(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	var req struct {
		Name *string `json:"name"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	// If no updatable field is present, echo the current chat unchanged.
	if req.Name == nil {
		WriteJSON(w, http.StatusOK, map[string]any{"chat": h.svc.EnrichChat(r.Context(), chat)})

		return
	}

	updatedView, err := h.svc.UpdateChatName(r.Context(), chatID, *req.Name)
	if err != nil {
		if !chatError(w, err) {
			logger.Error("failed to update chat", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": updatedView})
}

func (h *Handler) DeleteChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireGroupOwner(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	if err := h.svc.DeleteChat(r.Context(), chat); err != nil {
		logger.Error("failed to delete chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) AddChatMember(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireGroupOwner(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	var req struct {
		UserID string `json:"userId"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	updatedView, err := h.svc.AddChatMember(r.Context(), chatID, req.UserID)
	if err != nil {
		if !chatError(w, err) {
			writeError(w, http.StatusBadRequest, "failed to add member")
		}

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": updatedView})
}

func (h *Handler) RemoveChatMember(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")
	targetUserID := r.PathValue("userId")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats can remove members")
		return
	}

	if targetUserID != user.ID && !service.IsOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can remove other members")
		return
	}

	if service.IsOwner(chat, targetUserID) {
		writeError(w, http.StatusBadRequest, "owner cannot leave the group; delete the group instead")

		return
	}

	updatedView, err := h.svc.RemoveChatMember(r.Context(), chatID, targetUserID, user.ID)
	if err != nil {
		if !chatError(w, err) {
			writeError(w, http.StatusBadRequest, "failed to remove member")
		}

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": updatedView})
}

func (h *Handler) UpdateChatAvatar(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireGroupOwner(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	var req struct {
		FileID string `json:"fileId"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	updatedView, err := h.svc.UpdateChatAvatar(r.Context(), chatID, req.FileID)
	if err != nil {
		if !chatError(w, err) {
			logger.Error("failed to update chat avatar", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": updatedView})
}
