package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// publicKeyLen is the X25519 key size in bytes (libsodium
// crypto_box_PUBLICKEYBYTES).
const publicKeyLen = 32

// decodePublicKey accepts any common base64 variant. The frontend
// encodes keys with libsodium, whose default is URLSAFE_NO_PADDING
// ("-" and "_" instead of "+" and "/", no padding); accept the standard
// variants too for robustness.
func decodePublicKey(s string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}

	for _, enc := range encodings {
		raw, err := enc.DecodeString(s)
		if err == nil && len(raw) == publicKeyLen {
			return raw, nil
		}
	}

	return nil, errors.New("invalid public key")
}

// UpdatePublicKey stores the authenticated user's E2E X25519 public key
// (base64). Private keys never leave the client.
func (h *Handler) UpdatePublicKey(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)

	var req struct {
		PublicKey string `json:"publicKey"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if _, err := decodePublicKey(req.PublicKey); err != nil {
		writeError(w, http.StatusBadRequest, "invalid public key")
		return
	}

	if err := h.store.UpdateUserPublicKey(r.Context(), user.ID, req.PublicKey); err != nil {
		logger.Error("failed to update public key", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GetUserPublicKey returns a user's E2E public key. For federated users
// it proxies the request to the remote server (signed federation call).
func (h *Handler) GetUserPublicKey(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")

	remoteDomain := remoteServerFromID(userID)
	if remoteDomain == "" || remoteDomain == h.cfg.Server.Domain {
		key, ok := h.store.GetUserPublicKey(r.Context(), userID)
		if !ok {
			writeError(w, http.StatusNotFound, "user has no public key")
			return
		}

		WriteJSON(w, http.StatusOK, map[string]string{"publicKey": key})
		return
	}

	remoteURL := h.federatedURL(remoteDomain, "/api/federated/users/"+url.PathEscape(userID)+"/public-key")

	data, err := h.doFederatedRequest(r.Context(), http.MethodGet, remoteURL, nil)
	if err != nil {
		logger.Warn("remote public key fetch failed", "err", err)
		writeError(w, http.StatusBadGateway, "failed to fetch public key")
		return
	}

	var result struct {
		PublicKey string `json:"publicKey"`
	}

	if err := json.Unmarshal(data, &result); err != nil || result.PublicKey == "" {
		writeError(w, http.StatusBadGateway, "failed to parse remote response")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"publicKey": result.PublicKey})
}

// FederatedGetUserPublicKey serves a public key to a remote server.
func (h *Handler) FederatedGetUserPublicKey(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")

	if remoteServerFromID(userID) != h.cfg.Server.Domain {
		writeError(w, http.StatusBadRequest, "user does not belong to this server")
		return
	}

	key, ok := h.store.GetUserPublicKey(r.Context(), userID)
	if !ok {
		writeError(w, http.StatusNotFound, "user has no public key")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"publicKey": key})
}