package handler

import (
	"net/http"
	"time"

	"fast_chat/model"
)

type federatedSyncResponse struct {
	ServerNow       time.Time              `json:"serverNow"`
	Messages        []model.Message        `json:"messages"`
	DeletedMessages []model.DeletedMessage `json:"deletedMessages"`
}

func (h *Handler) FederatedSync(w http.ResponseWriter, r *http.Request) {
	since, err := parseSince(r.URL.Query().Get("since"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since timestamp")
		return
	}

	serverDomain := r.Header.Get("X-Federation-Server")
	if serverDomain == "" {
		writeError(w, http.StatusForbidden, "missing federation server")
		return
	}

	fedChatIDs := h.store.GetFederatedChatIDs(r.Context(), serverDomain)

	resp := federatedSyncResponse{
		ServerNow:       time.Now().UTC(),
		Messages:        h.store.MessagesChangedSince(r.Context(), fedChatIDs, since),
		DeletedMessages: h.store.DeletedMessagesSince(r.Context(), fedChatIDs, since),
	}
	if resp.Messages == nil {
		resp.Messages = []model.Message{}
	}

	if resp.DeletedMessages == nil {
		resp.DeletedMessages = []model.DeletedMessage{}
	}

	writeJSON(w, http.StatusOK, resp)
}
