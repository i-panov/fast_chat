package handler

import (
	"net/http"
)

func (h *Handler) HandleTyping(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	var req struct {
		Active bool `json:"active"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	throttled := h.svc.HandleTyping(r.Context(), chat, chatID, user.ID, user.Nick, req.Active)

	if throttled {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "throttled"})
		return
	}

	// Propagate the typing indicator to the remote federation peer (the local
	// fan-out is handled by the service layer).
	h.sendFedPost(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/typing", map[string]any{
		"userId": user.ID,
		"active": req.Active,
		"nick":   user.Nick,
	})

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
