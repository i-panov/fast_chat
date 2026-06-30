package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"fast_chat/model"
)

func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	query := r.URL.Query().Get("q")

	if idx := strings.Index(query, ":"); idx != -1 {
		h.searchFederated(w, r, query[:idx], query[idx+1:])

		return
	}

	if utf8.RuneCountInString(strings.TrimSpace(query)) < nickMinSearchRunes {
		writeJSON(w, http.StatusOK, map[string]any{"users": []model.PublicUser{}})
		return
	}

	users := h.store.SearchUsers(r.Context(), query, user.ID)
	if users == nil {
		users = []model.PublicUser{}
	}

	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (h *Handler) searchFederated(w http.ResponseWriter, r *http.Request, remoteNick, remoteDomain string) {
	if remoteNick == "" || remoteDomain == "" || utf8.RuneCountInString(remoteNick) < nickMinSearchRunes {
		writeError(w, http.StatusBadRequest, "invalid search query")
		return
	}

	if remoteDomain == h.cfg.Server.Domain {
		users := h.store.SearchUsers(r.Context(), remoteNick, getUser(r).ID)
		if users == nil {
			users = []model.PublicUser{}
		}

		writeJSON(w, http.StatusOK, map[string]any{"users": users})
		return
	}

	remoteURL := h.federatedURL(remoteDomain, "/api/federated/users/search?q="+url.QueryEscape(remoteNick))

	data, err := h.doFederatedRequest(r.Context(), http.MethodGet, remoteURL, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
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
		if sep := strings.Index(nick, ":"); sep != -1 {
			result.Users[idx].Nick = nick[:sep]
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"users": result.Users})
}
