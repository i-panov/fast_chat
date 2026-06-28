package handler

import "net/http"

func (h *Handler) GetConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"messageEditTTL":   h.cfg.MessageEditTTL,
		"messageDeleteTTL": h.cfg.MessageDeleteTTL,
		"debugMode":        h.cfg.Email.DebugMode,
	})
}
