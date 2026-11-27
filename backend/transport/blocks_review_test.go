package transport

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A remote account has no local profile row, but its block still has to show
// up in the settings list: otherwise it cannot be removed again.
func TestBlockedRemoteUserIsVisibleAndCanBeUnblocked(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	alice := createTestUser(t, ts.Store)

	const remote = "nick:remote.test"

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/blocks/"+remote, alice.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("block: status = %d: %s", rec.Code, rec.Body.String())
	}

	users, ok := decodeBody(t, rec)["users"].([]any)
	if !ok || len(users) != 1 {
		t.Fatalf("blocked list = %v, want the remote entry", decodeBody(t, rec)["users"])
	}

	entry, _ := users[0].(map[string]any)
	if entry["id"] != remote {
		t.Fatalf("blocked entry id = %v, want %q", entry["id"], remote)
	}
	if entry["nick"] == "" {
		t.Fatal("the blocked entry has no nick to render")
	}

	// And it can be removed through the same API.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodDelete, "/api/blocks/"+remote, alice.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("unblock: status = %d: %s", rec.Code, rec.Body.String())
	}
	if users, ok := decodeBody(t, rec)["users"].([]any); !ok || len(users) != 0 {
		t.Fatalf("blocked list after unblock = %v, want empty", decodeBody(t, rec)["users"])
	}
}
