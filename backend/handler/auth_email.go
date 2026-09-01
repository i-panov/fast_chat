package handler

import (
	"errors"
	"net/http"
	"time"

	"fast_chat/service"
)

func (h *Handler) SendCode(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	var req struct {
		Email string `json:"email"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	res, err := h.svc.SendCode(req.Email)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	resp := map[string]any{"status": "sent"}

	if h.cfg.Email.DebugMode {
		resp["debugCode"] = res.DebugCode
	}

	WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) VerifyCode(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	res, err := h.svc.VerifyCode(r.Context(), req.Email, req.Code)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if res.IsNew {
		WriteJSON(w, http.StatusOK, map[string]any{
			"isNew":      true,
			"setupToken": res.SetupToken,
		})
		return
	}

	user := res.User
	WriteJSON(w, http.StatusOK, map[string]any{
		"user":      user.Public(),
		"token":     user.Token,
		"expiresAt": user.TokenExpiresAt.Format(time.RFC3339),
		"isNew":     false,
	})
}

func (h *Handler) CompleteRegistration(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	var req struct {
		SetupToken string `json:"setupToken"`
		Nick       string `json:"nick"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	user, err := h.svc.CompleteRegistration(r.Context(), req.SetupToken, req.Nick)
	if err != nil {
		writeAuthError(w, err)
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

	user, err := h.svc.RefreshToken(r.Context(), user.ID)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"token":     user.Token,
		"expiresAt": user.TokenExpiresAt.Format(time.RFC3339),
	})
}

func (h *Handler) SSEAuth(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

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

// writeAuthError maps an auth-domain service error to the same HTTP status
// and message the handler historically produced.
func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidEmail):
		writeError(w, http.StatusBadRequest, "invalid email")
	case errors.Is(err, service.ErrEmailNotAllowed):
		writeError(w, http.StatusForbidden, "email not allowed")
	case errors.Is(err, service.ErrEmailSendFailed):
		writeError(w, http.StatusInternalServerError, "failed to send email")
	case errors.Is(err, service.ErrInvalidCode):
		writeError(w, http.StatusUnauthorized, "invalid code")
	case errors.Is(err, service.ErrInvalidSetupToken):
		writeError(w, http.StatusUnauthorized, "invalid setup token")
	case errors.Is(err, service.ErrNickInvalid):
		writeError(w, http.StatusBadRequest, "nick must be 1-20 characters")
	case errors.Is(err, service.ErrNickColon):
		writeError(w, http.StatusBadRequest, "nick must not contain ':'")
	case errors.Is(err, service.ErrNicknameTaken):
		writeError(w, http.StatusConflict, "nickname already taken")
	case errors.Is(err, service.ErrEmailAlreadyTaken):
		writeError(w, http.StatusConflict, "email already registered")
	default:
		logger.Error("auth operation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
