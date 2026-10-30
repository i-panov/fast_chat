package httputil_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

	t.Run("generated id is crypto random hex", func(t *testing.T) {
		var captured string
		h := httputil.RequestIDMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			captured = httputil.GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil))

		hexPart := captured[len("req-"):]
		if len(hexPart) != 32 {
			t.Fatalf("hex part length = %d, want 32", len(hexPart))
		}

		for _, c := range hexPart {
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				t.Fatalf("hex part %q is not lowercase hex", hexPart)
			}
		}
	})

	t.Run("rejects invalid incoming id", func(t *testing.T) {
		for _, bad := range []string{
			"has space",
			"a;b",
			"with\nnewline",
			"with\ttab",
			"quote\"x",
			"<script>",
		} {
			var captured string
			h := httputil.RequestIDMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				captured = httputil.GetRequestID(r.Context())
			}))

			w := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil)
			req.Header.Set(httputil.RequestIDHeader, bad)
			h.ServeHTTP(w, req)

			if captured == bad {
				t.Errorf("invalid id %q was reused, want generated", bad)
			}

			if got := w.Header().Get(httputil.RequestIDHeader); got != captured {
				t.Errorf("response header = %q, want context id %q", got, captured)
			}
		}
	})

	t.Run("rejects overlong incoming id", func(t *testing.T) {
		var captured string
		h := httputil.RequestIDMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			captured = httputil.GetRequestID(r.Context())
		}))

		w := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", nil)
		req.Header.Set(httputil.RequestIDHeader,
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		h.ServeHTTP(w, req)

		if strings.HasPrefix(captured, "aaaa") {
			t.Errorf("overlong id was reused: %q", captured)
		}
	})

	t.Run("propagates valid incoming id", func(t *testing.T) {
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
