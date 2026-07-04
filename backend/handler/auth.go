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
	user, _ := r.Context().Value(userKey).(*model.User) //nolint:errcheck // type assertion with ok
	return user
}

func (h *Handler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		token = strings.TrimPrefix(token, "Bearer ")

		user, ok := h.store.GetUserByToken(r.Context(), token)
		if !ok {
			writeError(w, http.StatusUnauthorized, errKeyUnauthorized)
			return
		}

		if time.Now().After(user.TokenExpiresAt) {
			writeError(w, http.StatusUnauthorized, "token expired")
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
			writeError(w, http.StatusUnauthorized, "missing federation headers")
			return
		}

		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid timestamp")
			return
		}

		now := time.Now().Unix()
		if now-timestamp > federationTimestampToleranceSec || timestamp-now > federationTimestampToleranceSec {
			writeError(w, http.StatusUnauthorized, "timestamp out of bounds")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}

		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

		if !h.fedManager.Verify(r.Context(), serverDomain, signature, r.Method, r.URL.RequestURI(), bodyBytes, timestamp) {
			writeError(w, http.StatusUnauthorized, "invalid signature")
			return
		}

		next(w, r)
	}
}
