package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/service"
)

func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	query := r.URL.Query().Get("q")

	if before, after, ok := strings.Cut(query, ":"); ok {
		h.searchFederated(w, r, before, after)

		return
	}

	if utf8.RuneCountInString(strings.TrimSpace(query)) < service.MinSearchRunes {
		WriteJSON(w, http.StatusOK, map[string]any{"users": []model.PublicUser{}})
		return
	}

	users := h.store.SearchUsers(r.Context(), query, user.ID)
	if users == nil {
		users = []model.PublicUser{}
	}

	WriteJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (h *Handler) searchFederated(w http.ResponseWriter, r *http.Request, remoteNick, remoteDomain string) {
	if remoteNick == "" || remoteDomain == "" || utf8.RuneCountInString(remoteNick) < service.MinSearchRunes {
		writeError(w, http.StatusBadRequest, "invalid search query")
		return
	}

	if !service.IsValidRemoteDomain(remoteDomain) {
		writeError(w, http.StatusBadRequest, "invalid search query")
		return
	}

	if remoteDomain == h.cfg.Server.Domain {
		users := h.store.SearchUsers(r.Context(), remoteNick, getUser(r).ID)
		if users == nil {
			users = []model.PublicUser{}
		}

		WriteJSON(w, http.StatusOK, map[string]any{"users": users})

		return
	}

	remoteURL := h.federatedURL(remoteDomain, "/api/federated/users/search?q="+url.QueryEscape(remoteNick))

	data, err := h.doFederatedRequest(r.Context(), http.MethodGet, remoteURL, nil)
	if err != nil {
		logger.Warn("remote search failed", "err", err)
		writeError(w, http.StatusBadGateway, "remote search failed")
		return
	}

	var result struct {
		Users []model.PublicUser `json:"users"`
	}

	if err := json.Unmarshal(data, &result); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to parse remote response")
		return
	}

	// Strip trailing ":domain" from ID for display purposes.
	for idx := range result.Users {
		nick := result.Users[idx].ID
		if before, _, ok := strings.Cut(nick, ":"); ok {
			result.Users[idx].Nick = before
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{"users": result.Users})
}
