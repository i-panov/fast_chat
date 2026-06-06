package handler

import "net/http"

func (h *Handler) GetConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messageEditTTL":   h.cfg.MessageEditTTL,
		"messageDeleteTTL": h.cfg.MessageDeleteTTL,
	})
}
