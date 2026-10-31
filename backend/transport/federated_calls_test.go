package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/calls"
	"fast_chat/service"
	"fast_chat/store"
)

// newFederatedCallsTestServer builds a huma API with only the federated call
// operations, faking the federation middleware by stashing the verified
// server domain straight into the context.
func newFederatedCallsTestServer(t *testing.T, server string) (huma.API, *store.Store, *service.Service) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	svc.SetCallManager(calls.NewManager(nil))

	api := newTestAPI(newTestMux())
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		next(huma.WithValue(ctx, federatedServerKey{}, server))
	})
	registerFederatedCalls(api, st, svc)

	return api, st, svc
}

// createFederatedCallChat creates the private chat the federated invite names:
// the caller lives on the peer server, the callee locally.
func createFederatedCallChat(t *testing.T, st *store.Store, caller, callee, remote string) string {
	t.Helper()

	chat, err := st.CreateChat(context.Background(), caller, callee, remote)
	if err != nil {
		t.Fatal(err)
	}

	return chat.ID
}

func doFedJSON(t *testing.T, api huma.API, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	return rec
}

func fedInviteBody(remote, callID, chatID, caller, callee string) string {
	return `{"remoteServer":"` + remote + `","callId":"` + callID + `","chatId":"` + chatID +
		`","callerId":"` + caller + `","calleeId":"` + callee + `","offer":"v=0"}`
}

func TestFederatedInviteWrongPeerIs403(t *testing.T) {
	api, st, _ := newFederatedCallsTestServer(t, "peer.test")
	chatID := createFederatedCallChat(t, st, "alice:peer.test", "bob:localhost:8080", "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite",
		fedInviteBody("other.test", "call-1", chatID, "alice:peer.test", "bob:localhost:8080"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFederatedInviteUnknownChatIs403(t *testing.T) {
	api, _, _ := newFederatedCallsTestServer(t, "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite",
		fedInviteBody("peer.test", "call-1", "missing", "alice:peer.test", "bob:localhost:8080"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFederatedInviteForeignChatIs403(t *testing.T) {
	api, st, _ := newFederatedCallsTestServer(t, "peer.test")
	chatID := createFederatedCallChat(t, st, "alice:else.test", "bob:localhost:8080", "else.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite",
		fedInviteBody("peer.test", "call-1", chatID, "alice:else.test", "bob:localhost:8080"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFederatedInviteOkAndIdempotent(t *testing.T) {
	api, st, svc := newFederatedCallsTestServer(t, "peer.test")
	chatID := createFederatedCallChat(t, st, "alice:peer.test", "bob:localhost:8080", "peer.test")
	body := fedInviteBody("peer.test", "call-1", chatID, "alice:peer.test", "bob:localhost:8080")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	if !strings.Contains(rec.Body.String(), `"ok"`) {
		t.Fatalf("expected ok status, got %s", rec.Body.String())
	}

	// The invite reserves the callee: the service handler ran.
	if _, ok := svc.CallManager().GetFederated("call-1"); !ok {
		t.Fatal("the shadow is missing: HandleFederatedInvite did not run")
	}

	// The owner retries until it gets a 200: a repeated invite re-notifies
	// instead of failing.
	rec = doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("repeated invite: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFederatedInviteBusyCalleeIs409(t *testing.T) {
	api, st, _ := newFederatedCallsTestServer(t, "peer.test")
	chatID := createFederatedCallChat(t, st, "alice:peer.test", "bob:localhost:8080", "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite",
		fedInviteBody("peer.test", "call-1", chatID, "alice:peer.test", "bob:localhost:8080"))
	if rec.Code != http.StatusOK {
		t.Fatalf("first invite: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = doFedJSON(t, api, http.MethodPost, "/api/federated/calls/invite",
		fedInviteBody("peer.test", "call-2", chatID, "alice:peer.test", "bob:localhost:8080"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if out.Error != "the callee is already in a call" || out.Code != "busy-callee" {
		t.Fatalf("body = %+v, want the busy-callee refusal", out)
	}
}

func TestFederatedAcceptUnknownCallIs410(t *testing.T) {
	api, _, _ := newFederatedCallsTestServer(t, "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/missing/accept", `{"answer":"v=0"}`)
	if rec.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFederatedIceUnknownCallIs410(t *testing.T) {
	api, _, _ := newFederatedCallsTestServer(t, "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/missing/ice", `{"candidate":{"candidate":"a"}}`)
	if rec.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d: %s", rec.Code, rec.Body.String())
	}
}

// Ended is the owner's retry loop: a report after the shadow is gone still
// answers ok, so the owner stops reporting.
func TestFederatedEndedUnknownCallIsOk(t *testing.T) {
	api, _, _ := newFederatedCallsTestServer(t, "peer.test")

	rec := doFedJSON(t, api, http.MethodPost, "/api/federated/calls/missing/ended", `{"reason":"hangup"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
