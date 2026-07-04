// Package httputil provides shared HTTP utilities for encoding JSON responses.
package httputil

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func WriteJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Warn("WriteJSON failed", "err", err)
	}
}
