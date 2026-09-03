package httputil_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"fast_chat/internal/httputil"
)

func TestGetRequestID(t *testing.T) {
	t.Run("returns empty when no id in context", func(t *testing.T) {
		if got := httputil.GetRequestID(context.Background()); got != "" {
			t.Errorf("expected empty, got %q", got)
		}
	})

	t.Run("returns id from context", func(t *testing.T) {
		ctx := context.WithValue(context.Background(), httputil.RequestIDContextKey, "test-123")
		if got := httputil.GetRequestID(ctx); got != "test-123" {
			t.Errorf("expected test-123, got %q", got)
		}
	})
}

func TestRequestIDMiddleware(t *testing.T) {
	t.Run("generates id when none provided", func(t *testing.T) {
		var captured string
		h := httputil.RequestIDMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			captured = httputil.GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil))

		if captured == "" {
			t.Error("expected generated request id, got empty")
		}

		if got := w.Header().Get(httputil.RequestIDHeader); got == "" || got != "req-"+captured[4:] {
			t.Errorf("response header %s = %q, want %q", httputil.RequestIDHeader, got, "req-"+captured[4:])
		}
	})

	t.Run("propagates incoming id", func(t *testing.T) {
		var captured string
		h := httputil.RequestIDMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			captured = httputil.GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil)
		req.Header.Set(httputil.RequestIDHeader, "incoming-abc")
		h.ServeHTTP(w, req)

		if captured != "incoming-abc" {
			t.Errorf("expected incoming-abc, got %q", captured)
		}

		if got := w.Header().Get(httputil.RequestIDHeader); got != "incoming-abc" {
			t.Errorf("response header %s = %q, want incoming-abc", httputil.RequestIDHeader, got)
		}
	})
}
