package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestDocsSelfHosted guards the no-CDN guarantee: the /docs page must be
// rendered from vendored assets served by this binary, never from a
// third-party origin.
func TestDocsSelfHosted(t *testing.T) {
	ts := newDomainTestServer(t)

	do := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, http.NoBody)
		ts.Handler.ServeHTTP(rec, req)

		return rec
	}

	rec := do("/docs")
	if rec.Code != http.StatusOK {
		t.Fatalf("/docs = %d", rec.Code)
	}

	body := rec.Body.String()
	if strings.Contains(body, "unpkg.com") || strings.Contains(body, "jsdelivr") {
		t.Errorf("/docs references a third-party CDN: %s", body)
	}

	if !strings.Contains(body, "/docs/assets/web-components.min.js") || !strings.Contains(body, `apiDescriptionUrl="/openapi.json"`) {
		t.Errorf("unexpected /docs HTML: %s", body)
	}

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "unpkg") {
		t.Errorf("CSP = %q, want same-origin scripts only", csp)
	}

	// Stoplight Elements fetches /openapi.json from the page: without
	// connect-src the browser blocks it and the UI shows a fetch error.
	if !strings.Contains(csp, "connect-src 'self'") {
		t.Errorf("CSP = %q, missing connect-src 'self' (spec fetch would be blocked)", csp)
	}

	for _, asset := range []string{"/docs/assets/web-components.min.js", "/docs/assets/styles.min.css"} {
		rec = do(asset)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d", asset, rec.Code)
		}

		if rec.Body.Len() < 10000 {
			t.Errorf("%s suspiciously small: %d bytes", asset, rec.Body.Len())
		}
	}

	// Only the two known asset files are served.
	if rec := do("/docs/assets/evil.js"); rec.Code != http.StatusNotFound {
		t.Errorf("/docs/assets/evil.js = %d, want 404", rec.Code)
	}
}
