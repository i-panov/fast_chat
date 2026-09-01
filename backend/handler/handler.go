package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/httputil"
	"fast_chat/model"
	"fast_chat/push"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

var logger = slog.Default()

// RequestIDHeader is the HTTP header used to propagate a unique request
// identifier across service boundaries (client -> server -> federated upstream).
const RequestIDHeader = "X-Request-ID"

// requestIDKey is the context key under which the request ID is stored.
type requestIDKey struct{}

// RequestIDContextKey is the singleton value used as context key.
var RequestIDContextKey = requestIDKey{}

// GetRequestID returns the request ID associated with the context, if any.
func GetRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(RequestIDContextKey).(string); ok {
		return id
	}

	return ""
}

// RequestIDMiddleware generates or accepts a request ID and injects it into the
// request context and response headers. Upstream calls reuse the incoming ID so
// a single logical request can be traced across services.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if id == "" {
			id = "req-" + genRequestID()
		}

		w.Header().Set(RequestIDHeader, id)
		ctx := context.WithValue(r.Context(), RequestIDContextKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// genRequestID builds a compact, sortable-ish unique identifier.
func genRequestID() string {
	return fmt.Sprintf("%x%x", time.Now().UnixNano(), os.Getpid())
}

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

// memberInfo is a transport alias for the shared service DTO. It keeps the
// JSON shape stable while sync.go still resolves in package handler and will
// be dropped once the sync domain is ported to the service layer.
type memberInfo = service.MemberView

// Handler is the HTTP transport layer. During the service-layer migration
// (A2-A6) it still holds store/hub/cfg directly for handlers not yet ported;
// as each domain migrates, the duplicate access is funneled through svc and
// these fields can be dropped. The pointers are the same instances svc holds,
// so a mutation via either view stays visible to the other.
type Handler struct {
	store      *store.Store
	hub        *sse.Hub
	cfg        *config.Config
	svc        *service.Service
	fedManager *federation.Manager
	fedClient  *http.Client
	fedSem     chan struct{}
	fedWG      sync.WaitGroup
	pushSender pushSender
}

func New(s *store.Store, cfg *config.Config, fm *federation.Manager, ps *push.Service) *Handler {
	hub := sse.NewHub(typingThrottleInterval * 5)

	h := &Handler{
		store:      s,
		hub:        hub,
		cfg:        cfg,
		svc:        service.New(s, cfg, hub, ps),
		fedManager: fm,
		fedClient:  federation.NewSafeHTTPClient(time.Duration(cfg.Federation.Timeout) * time.Second),
		fedSem:     make(chan struct{}, 16),
	}
	if ps != nil {
		h.pushSender = ps
	}

	return h
}

func (h *Handler) Close() {
	h.hub.Close()

	// Wait for in-flight federation background requests to finish so
	// they are not silently dropped on shutdown.
	h.fedWG.Wait()
}

func (h *Handler) requireChatMember(w http.ResponseWriter, r *http.Request, chatID, userID string) *model.Chat {
	chat, err := h.svc.Chat(r.Context(), chatID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return nil
	}

	if !service.IsMember(chat, userID) {
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

	if !service.IsOwner(chat, userID) {
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
