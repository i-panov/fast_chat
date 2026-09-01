package handler

import (
	"net/http"

	"fast_chat/service"
)

func (h *Handler) Sync(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	since, err := service.ParseSince(r.URL.Query().Get("since"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since timestamp")
		return
	}

	resp := h.svc.Sync(r.Context(), user.ID, since)

	WriteJSON(w, http.StatusOK, resp)
}
