package httputil

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

const (
	// maxRequestIDLen caps an incoming X-Request-ID so a peer cannot bloat
	// contexts, response headers and logs with an unbounded value.
	maxRequestIDLen = 128
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
		if !isValidRequestID(id) {
			id = "req-" + genRequestID()
		}

		w.Header().Set(RequestIDHeader, id)
		ctx := context.WithValue(r.Context(), RequestIDContextKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// isValidRequestID reports whether an incoming request ID is safe to reuse:
// bounded in length and limited to trace-safe characters, so it cannot bloat
// logs or split headers/traces.
func isValidRequestID(id string) bool {
	if id == "" || len(id) > maxRequestIDLen {
		return false
	}

	for _, c := range id {
		switch {
		case c >= 'A' && c <= 'Z',
			c >= 'a' && c <= 'z',
			c >= '0' && c <= '9',
			c == '-' || c == '_' || c == '.':
			// allowed
		default:
			return false
		}
	}

	return true
}

// genRequestID builds a 128-bit random hex identifier.
func genRequestID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand essentially never fails; the fallback keeps the
		// request traceable without panicking the handler.
		return fallbackRequestID()
	}

	return hex.EncodeToString(buf[:])
}

var requestIDFallback atomic.Uint64

// fallbackRequestID mixes time, pid and a counter when entropy is
// unavailable. It only runs on the crypto/rand error path.
func fallbackRequestID() string {
	c := requestIDFallback.Add(1)

	return fmt.Sprintf("%x%x%x", time.Now().UnixNano(), os.Getpid(), c)
}
