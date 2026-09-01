package handler

import (
	"encoding/json"
	"net/http"

	"fast_chat/service"
)

// pushSender abstracts the web-push delivery service so the handler can be
// tested without network access.
type pushSender interface {
	PublicKey() string
}

func (h *Handler) VapidPublicKey(w http.ResponseWriter, r *http.Request) {
	if h.pushSender == nil {
		writeError(w, http.StatusNotFound, "push not configured")

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"publicKey": h.pushSender.PublicKey()})
}

func (h *Handler) SubscribePush(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Endpoint string `json:"endpoint"`
		P256DH   string `json:"p256dh"` //nolint:tagliatelle // field names fixed by the Web Push protocol
		Auth     string `json:"auth"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")

		return
	}

	if req.Endpoint == "" || req.P256DH == "" || req.Auth == "" {
		writeError(w, http.StatusBadRequest, "endpoint, p256dh, and auth are required")

		return
	}

	if !service.IsValidPushEndpoint(req.Endpoint) {
		writeError(w, http.StatusBadRequest, "invalid push endpoint")

		return
	}

	sub, err := h.store.AddPushSubscription(r.Context(), user.ID, req.Endpoint, req.P256DH, req.Auth)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save subscription")

		return
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"subscription": sub})
}

func (h *Handler) UnsubscribePush(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Endpoint string `json:"endpoint"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")

		return
	}

	if req.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint is required")

		return
	}

	if err := h.store.DeletePushSubscription(r.Context(), user.ID, req.Endpoint); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete subscription")

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
