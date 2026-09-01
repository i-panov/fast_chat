package handler

import (
	"net/http"

	"fast_chat/service"
)

func (h *Handler) FederatedSync(w http.ResponseWriter, r *http.Request) {
	since, err := service.ParseSince(r.URL.Query().Get("since"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since timestamp")
		return
	}

	serverDomain := r.Header.Get("X-Federation-Server")
	if serverDomain == "" {
		writeError(w, http.StatusForbidden, "missing federation server")
		return
	}

	resp := h.svc.SyncFederated(r.Context(), serverDomain, since)

	WriteJSON(w, http.StatusOK, resp)
}
