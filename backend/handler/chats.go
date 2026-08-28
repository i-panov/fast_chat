package handler

import (
	"net/http"
	"strings"

	"fast_chat/model"
	"fast_chat/sse"
)

const (
	groupNameMaxLen = 60
	maxGroupMembers = 100
)

func (h *Handler) GetChats(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chats := h.store.GetUserChats(r.Context(), user.ID)

	_, memberIDs := collectChatAndMemberIDs(chats)

	nicks := h.store.GetUsersByIDs(r.Context(), memberIDs)

	resp := make([]chatResponse, 0, len(chats))
	for _, c := range chats {
		resp = append(resp, h.enrichChatFromNicks(r.Context(), c, nicks))
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chats": resp})
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
		h.createGroupChat(w, r, user, req.Name, req.MemberIDs)

		return
	}

	if req.WithUserID == "" {
		writeError(w, http.StatusBadRequest, "withUserId required for private chat")
		return
	}

	if req.WithUserID == user.ID {
		writeError(w, http.StatusBadRequest, "cannot chat with yourself")
		return
	}

	remoteServer := remoteServerFromID(req.WithUserID)
	if remoteServer == h.cfg.Server.Domain {
		remoteServer = ""
	}

	if remoteServer == "" {
		if _, ok := h.store.GetUserByID(r.Context(), req.WithUserID); !ok {
			writeError(w, http.StatusNotFound, errKeyUserNotFound)
			return
		}
	}

	chat, err := h.store.CreateChat(r.Context(), user.ID, req.WithUserID, remoteServer)
	if err != nil {
		logger.Error("failed to create chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	enriched := h.enrichChat(r.Context(), chat)
	h.hub.Send(user.ID, sse.Event{Event: "chat_created", Data: enriched})

	h.sendFedPost(r.Context(), remoteServer, "/api/federated/chats", map[string]any{
		"chatId":       chat.ID,
		"members":      chat.Members,
		"remoteServer": h.cfg.Server.Domain,
	})

	if remoteServer == "" {
		h.hub.Send(req.WithUserID, sse.Event{Event: "chat_created", Data: enriched})
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"chat": enriched})
}

func (h *Handler) createGroupChat(w http.ResponseWriter, r *http.Request, user *model.User, name string, memberIDs []string) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > groupNameMaxLen {
		writeError(w, http.StatusBadRequest, "group name must be 1-60 characters")
		return
	}

	if len(memberIDs) > maxGroupMembers {
		writeError(w, http.StatusBadRequest, "too many members")
		return
	}

	seen := make(map[string]struct{}, len(memberIDs)+1)
	cleaned := make([]string, 0, len(memberIDs)+1)

	add := func(id string) {
		if id == "" {
			return
		}

		if _, ok := seen[id]; ok {
			return
		}

		seen[id] = struct{}{}
		cleaned = append(cleaned, id)
	}
	for _, memberID := range memberIDs {
		add(memberID)
	}

	for _, memberID := range cleaned {
		remoteServer := remoteServerFromID(memberID)
		if remoteServer != "" && remoteServer != h.cfg.Server.Domain {
			writeError(w, http.StatusBadRequest, "group chat members must be on the same server")
			return
		}

		if _, ok := h.store.GetUserByID(r.Context(), memberID); !ok {
			writeError(w, http.StatusNotFound, "user not found: "+memberID)
			return
		}
	}

	chat, err := h.store.CreateGroupChat(r.Context(), name, user.ID, cleaned, "")
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to create group chat")
		return
	}

	enriched := h.enrichChat(r.Context(), chat)

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_created", Data: enriched})
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"chat": enriched})
}

func (h *Handler) GetChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": h.enrichChat(r.Context(), chat)})
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

	updated := chat

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > groupNameMaxLen {
			writeError(w, http.StatusBadRequest, "group name must be 1-60 characters")
			return
		}

		updatedChat, err := h.store.UpdateChatName(r.Context(), chatID, name)
		if err != nil {
			logger.Error("failed to update chat", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		updated = updatedChat
	}

	enriched := h.enrichChat(r.Context(), updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_updated", Data: enriched})
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}

func (h *Handler) DeleteChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireGroupOwner(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	if err := h.store.DeleteChat(r.Context(), chatID); err != nil {
		logger.Error("failed to delete chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_deleted", Data: map[string]string{"chatId": chatID}})
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

	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, "userId required")
		return
	}

	remoteServer := remoteServerFromID(req.UserID)
	if remoteServer != "" && remoteServer != h.cfg.Server.Domain {
		writeError(w, http.StatusBadRequest, "members must be on the same server")
		return
	}

	if _, ok := h.store.GetUserByID(r.Context(), req.UserID); !ok {
		writeError(w, http.StatusNotFound, errKeyUserNotFound)
		return
	}

	if err := h.store.AddChatMember(r.Context(), chatID, req.UserID, maxGroupMembers); err != nil {
		writeError(w, http.StatusBadRequest, "failed to add member")
		return
	}

	updated, _ := h.store.GetChat(r.Context(), chatID)

	enriched := h.enrichChat(r.Context(), updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_member_added", Data: map[string]any{
			"chatId": chatID,
			"userId": req.UserID,
			"chat":   enriched,
		}})
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": enriched})
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

	if targetUserID != user.ID && !isOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can remove other members")
		return
	}

	if isOwner(chat, targetUserID) {
		writeError(w, http.StatusBadRequest, "owner cannot leave the group; delete the group instead")

		return
	}

	if err := h.store.RemoveChatMember(r.Context(), chatID, targetUserID); err != nil {
		writeError(w, http.StatusBadRequest, "failed to remove member")
		return
	}

	updated, _ := h.store.GetChat(r.Context(), chatID)

	enriched := h.enrichChat(r.Context(), updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_member_removed", Data: map[string]any{
			"chatId":  chatID,
			"userId":  targetUserID,
			"chat":    enriched,
			"isLeave": targetUserID == user.ID,
		}})
	}

	h.hub.Send(targetUserID, sse.Event{Event: "chat_deleted", Data: map[string]string{"chatId": chatID}})

	WriteJSON(w, http.StatusOK, map[string]any{"chat": enriched})
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

	if req.FileID == "" {
		writeError(w, http.StatusBadRequest, "fileId required")
		return
	}

	if _, err := h.store.GetFile(r.Context(), req.FileID); err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	updated, err := h.store.UpdateChatAvatar(r.Context(), chatID, req.FileID)
	if err != nil {
		logger.Error("failed to update chat avatar", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	enriched := h.enrichChat(r.Context(), updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_updated", Data: enriched})
	}

	WriteJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}
