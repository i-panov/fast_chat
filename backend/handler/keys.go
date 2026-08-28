package handler

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// publicKeyLen is the X25519 key size in bytes (libsodium
// crypto_box_PUBLICKEYBYTES).
const publicKeyLen = 32

var errInvalidPublicKey = errors.New("invalid public key")

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

	return nil, errInvalidPublicKey
}

// keyVersionFor derives a short fingerprint from the public key so
// clients can detect a changed key and refresh their cache.
func keyVersionFor(publicKey string) string {
	sum := sha256.Sum256([]byte(publicKey))
	return hex.EncodeToString(sum[:6])
}

// UpdatePublicKey stores the authenticated user's E2E X25519 public key
// (base64). Private keys never leave the client.
func (h *Handler) UpdatePublicKey(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		PublicKey string `json:"publicKey"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	rawKey, err := decodePublicKey(req.PublicKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid public key")
		return
	}
	normalized := base64.StdEncoding.EncodeToString(rawKey)

	if err := h.store.UpdateUserPublicKey(r.Context(), user.ID, normalized); err != nil {
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

		WriteJSON(w, http.StatusOK, map[string]string{
			"publicKey":  key,
			"keyVersion": keyVersionFor(key),
		})
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
		PublicKey  string `json:"publicKey"`
		KeyVersion string `json:"keyVersion"`
	}

	if err := json.Unmarshal(data, &result); err != nil || result.PublicKey == "" {
		writeError(w, http.StatusBadGateway, "failed to parse remote response")
		return
	}

	if result.KeyVersion == "" {
		result.KeyVersion = keyVersionFor(result.PublicKey)
	}

	WriteJSON(w, http.StatusOK, map[string]string{
		"publicKey":  result.PublicKey,
		"keyVersion": result.KeyVersion,
	})
}

// maxKeyBackupLen bounds the accepted backup blob size. The blob is a
// base64-encoded JSON document holding a small encrypted secret (two
// 32-byte keys plus salt/nonce), so 4 KiB is ample while capping abuse.
const maxKeyBackupLen = 4 << 10

// SetKeyBackup stores the authenticated user's client-encrypted private
// key backup. The server treats it as opaque data; it cannot decrypt it.
func (h *Handler) SetKeyBackup(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		Backup string `json:"backup"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if req.Backup == "" || len(req.Backup) > maxKeyBackupLen {
		writeError(w, http.StatusBadRequest, "invalid backup")
		return
	}

	if _, err := base64.StdEncoding.DecodeString(req.Backup); err != nil {
		writeError(w, http.StatusBadRequest, "invalid backup")
		return
	}

	if err := h.store.SetKeyBackup(r.Context(), user.ID, req.Backup); err != nil {
		logger.Error("failed to store key backup", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GetKeyBackup returns the authenticated user's backup blob. It returns
// the caller's own backup only; there is no cross-user access.
func (h *Handler) GetKeyBackup(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	blob, ok := h.store.GetKeyBackup(r.Context(), user.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "no key backup")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"backup": blob})
}

// DeleteKeyBackup revokes the authenticated user's backup blob.
func (h *Handler) DeleteKeyBackup(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	if err := h.store.DeleteKeyBackup(r.Context(), user.ID); err != nil {
		logger.Error("failed to delete key backup", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Audit the destructive operation (revocation of the recovery material).
	logger.Info("key backup deleted", "userId", user.ID)
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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

	WriteJSON(w, http.StatusOK, map[string]string{
		"publicKey":  key,
		"keyVersion": keyVersionFor(key),
	})
}
