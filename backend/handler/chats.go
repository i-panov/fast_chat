package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"fast_chat/model"
)

const (
	groupNameMaxLen = 60
)

func (h *Handler) GetChats(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chats := h.store.GetUserChats(user.ID)

	// Collect every member id across every chat, then resolve them in a
	// single query instead of N*M round-trips.
	seen := make(map[string]struct{}, len(chats)*2)

	memberIDs := make([]string, 0, len(chats)*2)
	for _, c := range chats {
		for _, memberID := range c.Members {
			if _, ok := seen[memberID]; ok {
				continue
			}

			seen[memberID] = struct{}{}
			memberIDs = append(memberIDs, memberID)
		}
	}

	nicks := h.store.GetUsersByIDs(memberIDs)

	resp := make([]chatResponse, 0, len(chats))
	for _, c := range chats {
		resp = append(resp, h.enrichChatFromNicks(c, nicks))
	}

	writeJSON(w, http.StatusOK, map[string]any{"chats": resp})
}

func (h *Handler) CreateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)

	var req struct {
		Type       string   `json:"type"`
		WithUserID string   `json:"withUserId"`
		Name       string   `json:"name"`
		MemberIDs  []string `json:"memberIDs"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
		if _, ok := h.store.GetUserByID(req.WithUserID); !ok {
			writeError(w, http.StatusNotFound, "user not found")

			return
		}
	}

	chat, err := h.store.CreateChat(user.ID, req.WithUserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())

		return
	}

	enriched := h.enrichChat(chat)
	h.hub.Send(user.ID, SSEEvent{Event: "chat_created", Data: enriched})

	if remoteServer != "" {
		chat.RemoteServer = remoteServer

		fedURL := h.federatedURL(remoteServer, "/api/federated/chats")

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, map[string]any{
			"chatId":       chat.ID,
			"members":      chat.Members,
			"remoteServer": h.cfg.Server.Domain,
		})
		if fedErr != nil {
			logger.Info("federated create chat failed", "err", fedErr)
		}
	} else {
		h.hub.Send(req.WithUserID, SSEEvent{Event: "chat_created", Data: enriched})
	}

	writeJSON(w, http.StatusCreated, map[string]any{"chat": enriched})
}

func (h *Handler) createGroupChat(w http.ResponseWriter, _ *http.Request, user *model.User, name string, memberIDs []string) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > groupNameMaxLen {
		writeError(w, http.StatusBadRequest, "group name must be 1-60 characters")

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

		if _, ok := h.store.GetUserByID(memberID); !ok {
			writeError(w, http.StatusNotFound, "user not found: "+memberID)

			return
		}
	}

	chat, err := h.store.CreateGroupChat(name, user.ID, cleaned)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())

		return
	}

	enriched := h.enrichChat(chat)

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_created", Data: enriched})
	}

	writeJSON(w, http.StatusCreated, map[string]any{"chat": enriched})
}

func (h *Handler) GetChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)

		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"chat": h.enrichChat(chat)})
}

func (h *Handler) UpdateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats can be updated")

		return
	}

	if !isOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can update")

		return
	}

	var req struct {
		Name *string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

		updatedChat, err := h.store.UpdateChatName(chatID, name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())

			return
		}

		updated = updatedChat
	}

	enriched := h.enrichChat(updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_updated", Data: enriched})
	}

	writeJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}

func (h *Handler) DeleteChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats can be deleted")

		return
	}

	if !isOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can delete")

		return
	}

	if err := h.store.DeleteChat(chatID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())

		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_deleted", Data: map[string]string{"chatId": chatID}})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) AddChatMember(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats can add members")

		return
	}

	if !isOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can add members")

		return
	}

	var req struct {
		UserID string `json:"userId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

	if _, ok := h.store.GetUserByID(req.UserID); !ok {
		writeError(w, http.StatusNotFound, "user not found")

		return
	}

	if err := h.store.AddChatMember(chatID, req.UserID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())

		return
	}

	updated, _ := h.store.GetChat(chatID)

	enriched := h.enrichChat(updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_member_added", Data: map[string]any{
			"chatId": chatID,
			"userId": req.UserID,
			"chat":   enriched,
		}})
	}

	writeJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}

func (h *Handler) RemoveChatMember(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")
	targetUserID := r.PathValue("userId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

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

	if err := h.store.RemoveChatMember(chatID, targetUserID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())

		return
	}

	updated, _ := h.store.GetChat(chatID)

	enriched := h.enrichChat(updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_member_removed", Data: map[string]any{
			"chatId":  chatID,
			"userId":  targetUserID,
			"chat":    enriched,
			"isLeave": targetUserID == user.ID,
		}})
	}

	h.hub.Send(targetUserID, SSEEvent{Event: "chat_deleted", Data: map[string]string{"chatId": chatID}})

	writeJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}

func (h *Handler) UpdateChatAvatar(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats have an avatar")

		return
	}

	if !isOwner(chat, user.ID) {
		writeError(w, http.StatusForbidden, "only owner can set avatar")

		return
	}

	var req struct {
		FileID string `json:"fileId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)

		return
	}

	if req.FileID == "" {
		writeError(w, http.StatusBadRequest, "fileId required")

		return
	}

	if _, err := h.store.GetFile(req.FileID); err != nil {
		writeError(w, http.StatusNotFound, "file not found")

		return
	}

	updated, err := h.store.UpdateChatAvatar(chatID, req.FileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())

		return
	}

	enriched := h.enrichChat(updated)
	for _, memberID := range updated.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_updated", Data: enriched})
	}

	writeJSON(w, http.StatusOK, map[string]any{"chat": enriched})
}
