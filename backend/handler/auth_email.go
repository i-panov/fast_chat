package handler

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/store"
)

func (h *Handler) SendCode(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		Email string `json:"email"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if !isValidEmail(req.Email) {
		writeError(w, http.StatusBadRequest, "invalid email")
		return
	}

	if len(h.cfg.Email.AllowedEmails) > 0 {
		allowed := false

		for _, ae := range h.cfg.Email.AllowedEmails {
			if req.Email == ae {
				allowed = true
				break
			}
		}

		if !allowed {
			writeError(w, http.StatusForbidden, "email not allowed")
			return
		}
	}

	code, err := generateCode()
	if err != nil {
		logger.Error("failed to generate code", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")

		return
	}

	h.store.Codes().StoreCode(req.Email, code, 10*time.Minute)

	if err := h.emailSender.SendCode(req.Email, code); err != nil {
		logger.Error("failed to send email", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to send email")

		return
	}

	resp := map[string]any{"status": "sent"}

	if h.cfg.Email.DebugMode {
		resp["debugCode"] = code
	}

	WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) VerifyCode(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Code = strings.TrimSpace(req.Code)

	if !h.store.Codes().VerifyCode(req.Email, req.Code) {
		writeError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	user, exists := h.store.GetUserByEmail(r.Context(), req.Email)
	if exists {
		user, err := h.store.RefreshUserToken(r.Context(), user.ID, h.cfg.Auth.TokenExpiry)
		if err != nil {
			logger.Error("failed to refresh token", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")

			return
		}

		WriteJSON(w, http.StatusOK, map[string]any{
			"user":      user.Public(),
			"token":     user.Token,
			"expiresAt": user.TokenExpiresAt.Format(time.RFC3339),
			"isNew":     false,
		})

		return
	}

	setupToken := h.store.Codes().CreateSetupToken(req.Email, 10*time.Minute)

	WriteJSON(w, http.StatusOK, map[string]any{
		"isNew":      true,
		"setupToken": setupToken,
	})
}

func (h *Handler) CompleteRegistration(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		SetupToken string `json:"setupToken"`
		Nick       string `json:"nick"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	req.Nick = strings.TrimSpace(req.Nick)
	if req.Nick == "" || utf8.RuneCountInString(req.Nick) > nickMaxRunes {
		writeError(w, http.StatusBadRequest, "nick must be 1-20 characters")
		return
	}

	if strings.Contains(req.Nick, ":") {
		writeError(w, http.StatusBadRequest, "nick must not contain ':'")
		return
	}

	email, ok := h.store.Codes().VerifySetupToken(req.SetupToken)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid setup token")
		return
	}

	user, err := h.store.CreateUser(r.Context(), email, req.Nick, h.cfg.Server.Domain, h.cfg.Auth.TokenExpiry)
	if err != nil {
		if err == store.ErrNicknameTaken {
			writeError(w, http.StatusConflict, "nickname already taken")
			return
		}

		if err == store.ErrEmailTaken {
			writeError(w, http.StatusConflict, "email already registered")
			return
		}

		logger.Error("failed to create user", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")

		return
	}

	if _, err := h.store.EnsureSelfChat(r.Context(), user.ID); err != nil {
		logger.Error("failed to ensure self-chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")

		return
	}

	WriteJSON(w, http.StatusCreated, map[string]any{
		"user":      user.Public(),
		"token":     user.Token,
		"expiresAt": user.TokenExpiresAt.Format(time.RFC3339),
	})
}

func (h *Handler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	user, err := h.store.RefreshUserToken(r.Context(), user.ID, h.cfg.Auth.TokenExpiry)
	if err != nil {
		logger.Error("failed to refresh token", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"token":     user.Token,
		"expiresAt": user.TokenExpiresAt.Format(time.RFC3339),
	})
}

func (h *Handler) SSEAuth(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		ConnectionID string `json:"connectionId"`
		Token        string `json:"token"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	user, ok := h.store.GetUserByToken(r.Context(), req.Token)
	if !ok || time.Now().After(user.TokenExpiresAt) {
		writeError(w, http.StatusUnauthorized, errKeyUnauthorized)
		return
	}

	conn := h.hub.GetConnection(req.ConnectionID)
	if conn == nil {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}

	if err := h.hub.Authenticate(req.ConnectionID, user.ID, req.Token, user.TokenExpiresAt); err != nil {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}

	if h.store.AddConnection(user.ID) {
		h.broadcastUserStatus(r.Context(), user.ID, true)
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func isValidEmail(email string) bool {
	addr, err := mail.ParseAddress(email)
	if err != nil {
		return false
	}

	// mail.ParseAddress accepts "Name <email>" forms; require a bare
	// address so names/whitespace cannot slip into the stored email.
	return addr.Address == email
}

func generateCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}

	return fmt.Sprintf("%06d", n.Int64()), nil
}
