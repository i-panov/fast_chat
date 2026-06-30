package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"fast_chat/config"
	"fast_chat/email"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

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

var maxUploadSize int64 = 50 << 20

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
	store       *store.Store
	hub         *sse.Hub
	cfg         *config.Config
	fedManager  *federation.Manager
	fedClient   *http.Client
	emailSender email.Sender
}

func New(s *store.Store, cfg *config.Config, fm *federation.Manager) *Handler {
	var es email.Sender
	if cfg.Email.DebugMode {
		es = email.NewDebugSender()
	} else if cfg.Email.SMTP.Host != "" {
		es = email.NewSMTPSender(
			cfg.Email.SMTP.Host,
			cfg.Email.SMTP.Port,
			cfg.Email.SMTP.Username,
			cfg.Email.SMTP.Password,
			cfg.Email.SMTP.From,
		)
	} else {
		es = email.NewDebugSender()
	}

	return &Handler{
		store:       s,
		hub:         sse.NewHub(typingThrottleInterval * 5),
		cfg:         cfg,
		fedManager:  fm,
		fedClient:   &http.Client{Timeout: time.Duration(cfg.Federation.Timeout) * time.Second},
		emailSender: es,
	}
}

func (h *Handler) Close() {
	h.hub.Close()
}

func (h *Handler) enrichChat(ctx context.Context, c *model.Chat) chatResponse {
	return h.enrichChatFromNicks(ctx, c, nil)
}

func (h *Handler) enrichChatFromNicks(ctx context.Context, c *model.Chat, nicks map[string]string) chatResponse {
	cr := chatResponse{
		ID:        c.ID,
		Type:      c.Type,
		Name:      c.Name,
		OwnerID:   c.OwnerID,
		CreatedAt: c.CreatedAt,
	}

	if c.AvatarFileID != "" {
		if f, err := h.store.GetFile(ctx, c.AvatarFileID); err == nil {
			cr.AvatarURL = f.ToFileInfo().URL
		}
	}

	for _, member := range c.Members {
		nick, ok := nicks[member]
		if !ok {
			if nicks != nil {
				nick = member
			} else if u, found := h.store.GetUserByID(ctx, member); found {
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

func validCoords(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

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

func (h *Handler) decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		logger.Error("writeJSON: failed to encode response", "err", err)
	}
}

type errResp struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errResp{Error: message})
}
