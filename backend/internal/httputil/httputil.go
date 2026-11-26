// Package httputil provides shared HTTP utilities for encoding JSON responses.
package httputil

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// WriteRateLimited answers 429 in the same JSON shape as every other API
// error and tells the client when a retry can succeed. The plain-text
// http.Error response left the UI with an empty error and no Retry-After.
func WriteRateLimited(w http.ResponseWriter, retryAfter time.Duration) {
	seconds := max(int(retryAfter/time.Second), 1)
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
}

func WriteJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Warn("WriteJSON failed", "err", err)
	}
}
