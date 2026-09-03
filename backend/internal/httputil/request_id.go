package httputil

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"
)

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
