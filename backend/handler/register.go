package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"
)

const (
	nickMaxRunes       = 20
	nickMinSearchRunes = 2
)

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		Nick string `json:"nick"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

	fullID := req.Nick + ":" + h.cfg.ServerDomain

	user, err := h.store.CreateUser(fullID, req.Nick)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())

		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"user":  user.Public(),
		"token": user.Token,
	})
}
