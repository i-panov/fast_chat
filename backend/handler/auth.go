package handler

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fast_chat/model"
)

const (
	federationTimestampToleranceSec = 300
)

type contextKey string

const userKey contextKey = "user"

func getUser(r *http.Request) *model.User {
	user, _ := r.Context().Value(userKey).(*model.User) //nolint:errcheck // expected to be missing in unauthenticated contexts

	return user
}

func (h *Handler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		token = strings.TrimPrefix(token, "Bearer ")

		if token == "" {
			token = r.URL.Query().Get("token")
		}

		user, ok := h.store.GetUserByToken(token)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: errKeyUnauthorized})

			return
		}

		ctx := context.WithValue(r.Context(), userKey, user)
		next(w, r.WithContext(ctx))
	}
}

func (h *Handler) FederatedAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverDomain := r.Header.Get("X-Federation-Server")
		signature := r.Header.Get("X-Federation-Signature")
		timestampStr := r.Header.Get("X-Federation-Timestamp")

		if serverDomain == "" || signature == "" || timestampStr == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "missing federation headers"})

			return
		}

		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "invalid timestamp"})

			return
		}

		now := time.Now().Unix()
		if now-timestamp > federationTimestampToleranceSec || timestamp-now > federationTimestampToleranceSec {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "timestamp out of bounds"})

			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to read body"})

			return
		}

		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

		if !h.fedManager.Verify(r.Context(), serverDomain, signature, r.Method, r.URL.RequestURI(), bodyBytes, timestamp) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "invalid signature"})

			return
		}

		next(w, r)
	}
}
