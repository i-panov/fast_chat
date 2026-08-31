package handler

import (
	"log/slog"
	"net/http"
)

// HealthzHandler responds to liveness probes. It always returns 200 OK as long
// as the process is running — no dependency checks.
func HealthzHandler(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ReadinessHandler responds to readiness probes. It reports 200 OK only when
// the database connection is reachable, 503 otherwise.
func (h *Handler) ReadinessHandler(w http.ResponseWriter, _ *http.Request) {
	if err := h.store.Ping(); err != nil {
		slog.Error("readiness check failed", "err", err)

		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status":  "error",
			"message": "database unavailable",
		})

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
