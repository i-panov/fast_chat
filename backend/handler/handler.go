package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"fast_chat/config"
	"fast_chat/email"
	"fast_chat/federation"
	"fast_chat/internal/httputil"
	"fast_chat/model"
	"fast_chat/push"
	"fast_chat/sse"
	"fast_chat/store"
)

var logger = slog.Default()

const (
	mapKeyError          = "error"
	errKeyUnauthorized   = "unauthorized"
	errKeyInvalidBody    = "invalid body"
	errKeyChatNotFound   = "chat not found"
	errKeyNotMember      = "not a member"
	errKeyEmptyMessage   = "empty message"
	errKeyFileTooLarge   = "file too large"
	errKeyUserNotFound   = "user not found"
	errKeyMsgNotFound    = "message not found"
	errKeyThreadNotFound = "thread not found"
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
	fedSem      chan struct{}
	fedWG       sync.WaitGroup
	emailSender email.Sender
	pushService *push.Service
}

func New(s *store.Store, cfg *config.Config, fm *federation.Manager, ps *push.Service) *Handler {
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
		fedClient:   federation.NewSafeHTTPClient(time.Duration(cfg.Federation.Timeout) * time.Second),
		fedSem:      make(chan struct{}, 16),
		emailSender: es,
		pushService: ps,
	}
}

func (h *Handler) Close() {
	h.hub.Close()

	// Wait for in-flight federation background requests to finish so
	// they are not silently dropped on shutdown.
	h.fedWG.Wait()
}

func (h *Handler) broadcastUserStatus(ctx context.Context, userID string, online bool) {
	chats := h.store.GetUserChats(ctx, userID)
	notified := make(map[string]bool)

	for _, chat := range chats {
		for _, memberID := range chat.Members {
			if memberID != userID && !notified[memberID] {
				h.hub.Send(memberID, sse.Event{
					Event: "user_status_changed",
					Data: map[string]any{
						"userId": userID,
						"online": online,
					},
				})
				notified[memberID] = true
			}
		}
	}
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
	return slices.Contains(chat.Members, userID)
}

func isOwner(chat *model.Chat, userID string) bool {
	return chat.OwnerID != "" && chat.OwnerID == userID
}

func (h *Handler) requireChatMember(w http.ResponseWriter, r *http.Request, chatID, userID string) *model.Chat {
	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return nil
	}

	if !isMember(chat, userID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)
		return nil
	}

	return chat
}

func (h *Handler) requireGroupOwner(w http.ResponseWriter, r *http.Request, chatID, userID string) *model.Chat {
	chat := h.requireChatMember(w, r, chatID, userID)
	if chat == nil {
		return nil
	}

	if chat.Type != "group" {
		writeError(w, http.StatusBadRequest, "only group chats can be updated")
		return nil
	}

	if !isOwner(chat, userID) {
		writeError(w, http.StatusForbidden, "only owner can perform this action")
		return nil
	}

	return chat
}

func validCoords(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

var (
	errInvalidLocation    = errors.New("invalid location")
	errInvalidCoordinates = errors.New("invalid coordinates")
)

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
		return nil, false, errInvalidLocation
	}

	if !validCoords(loc.Lat, loc.Lng) {
		return nil, false, errInvalidCoordinates
	}

	return &loc, false, nil
}

func (h *Handler) decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	return dec.Decode(v)
}

func WriteJSON(w http.ResponseWriter, status int, data any) {
	httputil.WriteJSON(w, status, data)
}

type errResp struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, errResp{Error: message})
}
