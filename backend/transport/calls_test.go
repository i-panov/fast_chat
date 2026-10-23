package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/calls"
	"fast_chat/sse"
	"fast_chat/store"
)

func newCallsTestServer(t *testing.T) (huma.API, *store.Store, string) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	api, st, _, token := newCallsTestServerWithHub(t)

	return api, st, token
}

// newCallsTestServerWithHub builds the server of the call domain and gives
// the hub away: a test may watch the events the service sends.
func newCallsTestServerWithHub(t *testing.T) (huma.API, *store.Store, *sse.Hub, string) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	svc.SetCallManager(calls.NewManager(nil))

	api := newTestAPI(newTestMux())
	api.UseMiddleware(AuthMiddleware(st))
	RegisterCalls(api, svc)

	user := createTestUser(t, st)

	return api, st, hub, user.Token
}

// createCallChat creates the two users and a private chat in the store.
func createCallChat(t *testing.T, st *store.Store, alice, bob string) string {
	t.Helper()

	ctx := context.Background()

	for _, userID := range []string{alice, bob} {
		if _, ok := st.GetUserByID(ctx, userID); ok {
			continue
		}

		nick, _, _ := strings.Cut(userID, ":")
		if _, err := st.CreateUser(ctx, nick+"@test.local", nick, "localhost:8080", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := st.CreateChat(ctx, alice, bob, "")
	if err != nil {
		t.Fatal(err)
	}

	return chat.ID
}

func TestStartCallRequiresAuthorization(t *testing.T) {
	api, _, _ := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"c1","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartCallInUnknownChatAnswers404(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"missing","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}

	// Only the errors that share a status carry a machine code: the body of
	// the others stays as it was.
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("the body carries a code: %s", rec.Body.String())
	}
}

func TestStartCallWithEmptyOfferAnswers400(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"`+chatID+`","offer":""}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartCallAnswers201(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"`+chatID+`","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		CallID string `json:"callId"`
		State  string `json:"state"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if out.CallID == "" || out.State != "ringing" {
		t.Fatalf("unexpected body: %+v", out)
	}
}

func TestCurrentCallAnswers404WithoutACall(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/calls/current", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

// The client tells the two sides of a call apart by the role: the caller
// waits for an answer, the callee waits for the caller.
func TestCurrentCallAnswersTheRoleOfTheUser(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	rec := doJSON(t, api, token, http.MethodPost, "/api/calls", `{"chatId":"`+chatID+`","offer":"v=0"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start call: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, api, token, http.MethodGet, "/api/calls/current", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("current call: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		State string `json:"state"`
		Peer  string `json:"peer"`
		Role  string `json:"role"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if out.State != "ringing" || out.Role != "caller" {
		t.Fatalf("unexpected body: %+v", out)
	}

	if out.Peer != "bob:localhost:8080" {
		t.Fatalf("peer = %q, want bob", out.Peer)
	}
}

func TestHangupOnUnknownCallAnswers404(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls/missing/hangup", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

// The ICE candidate of the browser is an object. It must reach the peer
// unchanged: the other side hands it to its own connection as it is.
func TestSendIcePassesTheCandidateObjectToThePeer(t *testing.T) {
	api, st, hub, token := newCallsTestServerWithHub(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	conn := hub.Register("conn-bob")
	if err := hub.Authenticate("conn-bob", "bob:localhost:8080", "token", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, api, token, http.MethodPost, "/api/calls", `{"chatId":"`+chatID+`","offer":"v=0"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start call: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var started struct {
		CallID string `json:"callId"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}

	// The peer learns about the call first.
	waitEvent(t, conn)

	body := `{"candidate":{"candidate":"candidate:1 1 udp","sdpMid":"0","sdpMLineIndex":0}}`
	rec = doJSON(t, api, token, http.MethodPost, "/api/calls/"+started.CallID+"/ice", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("send ice: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	event := waitEvent(t, conn)
	if event.Event != "call_ice" {
		t.Fatalf("event = %q, want call_ice", event.Event)
	}

	raw, err := json.Marshal(event.Data)
	if err != nil {
		t.Fatal(err)
	}

	var payload struct {
		Candidate map[string]any `json:"candidate"`
	}

	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}

	if payload.Candidate["candidate"] != "candidate:1 1 udp" {
		t.Fatalf("the candidate did not reach the peer as an object: %s", raw)
	}
}

// doJSON sends a JSON request to the API on behalf of the user.
func doJSON(t *testing.T, api huma.API, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	return rec
}

// waitEvent takes the next event of the connection, or fails the test when
// none arrives.
func waitEvent(t *testing.T, conn *sse.Connection) sse.Event {
	t.Helper()

	select {
	case event := <-conn.Channel:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("no event arrived")
		return sse.Event{}
	}
}

// assertBusy checks the refusal of a call and the side it names: the status
// is the same for both sides, so the code is what the client reads.
func assertBusy(t *testing.T, rec *httptest.ResponseRecorder, message, code string) {
	t.Helper()

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if body.Error != message || body.Code != code {
		t.Fatalf("body = %+v, want %q and %q", body, message, code)
	}
}

// A busy user is told which side of the call is busy: the call of the peer
// and the call of the user themselves are different answers for the client.
func TestStartCallNamesTheBusySide(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	rec := doJSON(t, api, token, http.MethodPost, "/api/calls", `{"chatId":"`+chatID+`","offer":"v=0"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start call: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	self := doJSON(t, api, token, http.MethodPost, "/api/calls", `{"chatId":"`+chatID+`","offer":"v=0"}`)
	assertBusy(t, self, "you are already in a call", "busy-caller")

	// Carol is free, but the callee is on the phone with alice.
	carol, err := st.CreateUser(context.Background(), "carol@test.local", "carol", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	carolChat := createCallChat(t, st, "carol:localhost:8080", "bob:localhost:8080")

	busy := doJSON(t, api, carol.Token, http.MethodPost, "/api/calls", `{"chatId":"`+carolChat+`","offer":"v=0"}`)
	assertBusy(t, busy, "the callee is already in a call", "busy-callee")
}
