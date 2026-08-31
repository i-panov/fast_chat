package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetRequestID(t *testing.T) {
	t.Run("returns empty when no id in context", func(t *testing.T) {
		if got := GetRequestID(context.Background()); got != "" {
			t.Errorf("expected empty, got %q", got)
		}
	})

	t.Run("returns id from context", func(t *testing.T) {
		ctx := context.WithValue(context.Background(), RequestIDContextKey, "test-123")
		if got := GetRequestID(ctx); got != "test-123" {
			t.Errorf("expected test-123, got %q", got)
		}
	})
}

func TestRequestIDMiddleware(t *testing.T) {
	t.Run("generates id when none provided", func(t *testing.T) {
		var captured string
		h := RequestIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			captured = GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil))

		if captured == "" {
			t.Error("expected generated request id, got empty")
		}

		if got := w.Header().Get(RequestIDHeader); got == "" || got != "req-"+captured[4:] {
			t.Errorf("response header %s = %q, want %q", RequestIDHeader, got, "req-"+captured[4:])
		}
	})

	t.Run("propagates incoming id", func(t *testing.T) {
		var captured string
		h := RequestIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			captured = GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil)
		req.Header.Set(RequestIDHeader, "incoming-abc")
		h.ServeHTTP(w, req)

		if captured != "incoming-abc" {
			t.Errorf("expected incoming-abc, got %q", captured)
		}

		if got := w.Header().Get(RequestIDHeader); got != "incoming-abc" {
			t.Errorf("response header %s = %q, want incoming-abc", RequestIDHeader, got)
		}
	})
}
