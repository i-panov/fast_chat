package handler

import "net/http"

var (
	version = "dev"
	commit  = "none"
)

func (h *Handler) GetConfig(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"messageEditTTL":   h.cfg.MessageEditTTL,
		"messageDeleteTTL": h.cfg.MessageDeleteTTL,
		"version":          version,
		"commit":           commit,
	})
}
