// Package handler provides HTTP handlers and SSE infrastructure for the chat API.
package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/store"
)

// logger is the structured logger used by the handler package.
// It defaults to slog.Default() and may be overridden in tests.
var logger = slog.Default()

const (
	mapKeyError        = "error"
	errKeyUnauthorized = "unauthorized"
	errKeyInvalidBody  = "invalid body"
	errKeyChatNotFound = "chat not found"
	errKeyNotMember    = "not a member"
	errKeyEmptyMessage = "empty message"
	errKeyFileTooLarge = "file too large"
)

// maxUploadSize is the maximum file size accepted by UploadFile, in bytes.
// Declared as a var (not const) so tests can shrink the limit.
var maxUploadSize int64 = 50 << 20 // 50 MB

type memberInfo struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Online bool   `json:"online,omitempty"`
}

type chatResponse struct {
	ID        string       `json:"id"`
	Type      string       `json:"type"`
	Name      string       `json:"name"`
	OwnerID   string       `json:"ownerId"`
	AvatarURL string       `json:"avatarUrl,omitempty"`
	Members   []memberInfo `json:"members"`
	CreatedAt time.Time    `json:"createdAt"`
}

type Handler struct {
	store      *store.Store
	hub        *SSEHub
	cfg        *config.Config
	fedManager *federation.Manager
	fedClient  *http.Client
}

func New(s *store.Store, cfg *config.Config, fm *federation.Manager) *Handler {
	return &Handler{
		store:      s,
		hub:        NewSSEHub(),
		cfg:        cfg,
		fedManager: fm,
		fedClient:  &http.Client{Timeout: time.Duration(cfg.FederationTimeout) * time.Second},
	}
}

// Close stops the handler's background goroutines (SSE hub cleanup loop).
func (h *Handler) Close() {
	h.hub.Close()
}

func (h *Handler) enrichChat(c *model.Chat) chatResponse {
	return h.enrichChatFromNicks(c, nil)
}

// enrichChatFromNicks is the same as enrichChat but uses a pre-resolved
// nicks map (from Store.GetUsersByIDs) to avoid N+1 lookups. Pass nil to
// fall back to a per-member query.
func (h *Handler) enrichChatFromNicks(c *model.Chat, nicks map[string]string) chatResponse {
	cr := chatResponse{
		ID:        c.ID,
		Type:      c.Type,
		Name:      c.Name,
		OwnerID:   c.OwnerID,
		CreatedAt: c.CreatedAt,
	}

	if c.AvatarFileID != "" {
		if f, err := h.store.GetFile(c.AvatarFileID); err == nil {
			cr.AvatarURL = f.ToFileInfo().URL
		}
	}

	for _, member := range c.Members {
		nick, ok := nicks[member]
		if !ok {
			if nicks != nil {
				nick = member
			} else if u, found := h.store.GetUserByID(member); found {
				nick = u.Nick
			} else {
				nick = member
			}
		}

		cr.Members = append(cr.Members, memberInfo{ID: member, Nick: nick, Online: h.store.IsOnline(member)})
	}

	return cr
}

func isMember(chat *model.Chat, userID string) bool {
	for _, m := range chat.Members {
		if m == userID {
			return true
		}
	}

	return false
}

func isOwner(chat *model.Chat, userID string) bool {
	return chat.OwnerID != "" && chat.OwnerID == userID
}

// validCoords returns true if the latitude and longitude are within valid ranges.
func validCoords(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// parseLocationPatch decodes a tri-state location patch field.
//
//   - empty (field absent)         → nil, false, nil  (leave unchanged)
//   - JSON null                    → nil, true,  nil  (clear)
//   - JSON object {lat,lng}         → &Location{...}, false, nil
//   - malformed                    → nil, false, error
func parseLocationPatch(raw json.RawMessage) (*model.Location, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return nil, true, nil
	}

	var loc model.Location
	if err := json.Unmarshal(raw, &loc); err != nil {
		return nil, false, errors.New("invalid location")
	}

	if !validCoords(loc.Lat, loc.Lng) {
		return nil, false, errors.New("invalid coordinates")
	}

	return &loc, false, nil
}

func generateID() string {
	buf := make([]byte, 16)

	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		logger.Error("writeJSON: failed to encode response", "err", err)
	}
}

// errResp is the standard error body returned by the API.
type errResp struct {
	Error string `json:"error"`
}

// writeError sends a JSON error response with the given status and message.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errResp{Error: message})
}
