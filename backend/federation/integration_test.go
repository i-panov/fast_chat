package federation_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
	"fast_chat/transport"
)

// The integration harness boots two fully independent Fast Chat servers in
// one process: separate SQLite files, RSA key pairs, hubs, services and HTTP
// transports. Real signed requests flow between them over the loopback
// httptest listeners, so the tests exercise the actual server-to-server
// federation protocol instead of package-level seams.

const (
	fedTestTimeoutSec = 5
	fedTestWait       = 5 * time.Second
	fedTestEventWait  = 2 * time.Second

	fedWellKnownPath = "/.well-known/fast-chat"
)

type fedInstance struct {
	domain        string
	cfg           *config.Config
	sqlDB         *sql.DB
	store         *store.Store
	svc           *service.Service
	hub           *sse.Hub
	manager       *federation.Manager
	client        *federation.Client
	server        *httptest.Server
	wellKnownHits atomic.Int64
}

type fedPair struct {
	a *fedInstance
	b *fedInstance
}

// newFederationPair builds and starts two wired Fast Chat instances whose
// federation clients and well-known fetchers can reach each other's test
// servers. Cleanup stops everything in dependency order.
func newFederationPair(t *testing.T) *fedPair {
	t.Helper()

	srvA := httptest.NewUnstartedServer(nil)
	srvB := httptest.NewUnstartedServer(nil)
	domainA := srvA.Listener.Addr().String()
	domainB := srvB.Listener.Addr().String()

	a := newFedInstance(t, domainA)
	b := newFedInstance(t, domainB)
	a.server = srvA
	b.server = srvB

	srvA.Config.Handler = a.buildHandler()
	srvB.Config.Handler = b.buildHandler()
	srvA.Start()
	srvB.Start()

	// The production safe dialer refuses loopback, so inject the test
	// servers' own HTTP clients into the federation manager (well-known
	// fetches) and client (outbound signed requests). Client() is only
	// non-nil after Start().
	a.manager.SetHTTPClient(srvB.Client())
	b.manager.SetHTTPClient(srvA.Client())
	a.client.SetHTTPClient(srvB.Client())
	b.client.SetHTTPClient(srvA.Client())

	t.Cleanup(func() {
		a.client.CloseWait()
		b.client.CloseWait()
		srvA.Close()
		srvB.Close()
		a.manager.Close()
		b.manager.Close()
		a.hub.Close()
		b.hub.Close()
		_ = a.sqlDB.Close()
		_ = b.sqlDB.Close()
	})

	return &fedPair{a: a, b: b}
}

// newFedInstance assembles one full application stack (DB, hub, service,
// transport) for the given host:port domain.
func newFedInstance(t *testing.T, domain string) *fedInstance {
	t.Helper()

	key, err := federation.LoadOrGenerateKeys(filepath.Join(t.TempDir(), "fed-keys"))
	if err != nil {
		t.Fatalf("load federation keys: %v", err)
	}

	db, err := store.InitDB(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("init sqlite db: %v", err)
	}

	if err := db.AutoMigrate(&model.PushSubscription{}); err != nil {
		t.Fatalf("migrate push subscriptions: %v", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("open sql handle: %v", err)
	}

	st := store.New(db)
	hub := sse.NewHub(time.Minute)
	cfg := fedTestConfig(t, domain)
	mgr := federation.New(key, domain, "http", fedTestTimeoutSec, false)
	cli := federation.NewClient(mgr, domain, "http", fedTestTimeoutSec, false)

	return &fedInstance{
		domain:  domain,
		cfg:     cfg,
		sqlDB:   sqlDB,
		store:   st,
		svc:     service.New(st, cfg, hub, nil),
		hub:     hub,
		manager: mgr,
		client:  cli,
	}
}

func fedTestConfig(t *testing.T, domain string) *config.Config {
	t.Helper()

	host, portStr, err := net.SplitHostPort(domain)
	if err != nil {
		t.Fatalf("split test domain %q: %v", domain, err)
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse test port %q: %v", portStr, err)
	}

	return &config.Config{
		Server:           config.ServerConfig{Host: host, Port: port, Domain: domain},
		CORS:             config.CORSConfig{Origin: "*"},
		Auth:             config.AuthConfig{TokenExpiry: time.Hour, TokenExpiryWarning: 5 * time.Minute},
		Uploads:          config.UploadsConfig{Dir: t.TempDir()},
		Federation:       config.FederationConfig{AllowPrivateAddresses: true},
		MessageEditTTL:   300,
		MessageDeleteTTL: 0,
	}
}

// buildHandler wires the real Huma transport in front of an infra mux that
// serves the well-known endpoint (with a hit counter) and health probes.
func (f *fedInstance) buildHandler() http.Handler {
	infraMux := http.NewServeMux()
	infraMux.HandleFunc("GET "+fedWellKnownPath, f.serveWellKnown)
	infraMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	tr := transport.New(&transport.Deps{
		Hub:           f.hub,
		Store:         f.store,
		Svc:           f.svc,
		Cfg:           f.cfg,
		FedManager:    f.manager,
		FedClient:     f.client,
		PushPublicKey: func() (string, bool) { return "", false },
		Version:       "test",
		Commit:        "test",
	})

	return tr.FallbackHandler(infraMux)
}

func (f *fedInstance) serveWellKnown(w http.ResponseWriter, r *http.Request) {
	f.wellKnownHits.Add(1)
	f.manager.WellKnownHandler(w, r)
}

// createUser registers a local user with a self chat and returns the model
// carrying the plaintext bearer token, exactly as a client would receive it.
func (f *fedInstance) createUser(t *testing.T, nick string) *model.User {
	t.Helper()

	user, err := f.store.CreateUser(context.Background(), nick+"@federated.test", nick, f.domain, time.Hour)
	if err != nil {
		t.Fatalf("create user %s on %s: %v", nick, f.domain, err)
	}

	if _, err := f.store.EnsureSelfChat(context.Background(), user.ID); err != nil {
		t.Fatalf("ensure self chat for %s: %v", nick, err)
	}

	return user
}

// listenSSE registers and authenticates a hub connection for the user so the
// test can assert on realtime fan-out without a raw HTTP event stream.
func (f *fedInstance) listenSSE(t *testing.T, userID string) *sse.Connection {
	t.Helper()

	connID := "it-" + userID
	conn := f.hub.Register(connID)

	if err := f.hub.Authenticate(connID, userID, "integration-test", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("authenticate sse connection: %v", err)
	}

	return conn
}

// doJSON performs an authenticated client-facing request against this
// instance and returns the status code plus the decoded JSON body.
func (f *fedInstance) doJSON(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}

		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(context.Background(), method, f.server.URL+path, reader)
	if err != nil {
		t.Fatalf("build request %s %s: %v", method, path, err)
	}

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatalf("perform request %s %s: %v", method, path, err)
	}

	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode response %s %s (%s): %v", method, path, raw, err)
		}
	}

	return resp.StatusCode, out
}

// createFederatedChat drives the full client-facing flow: alice creates a
// private chat with bob on server A, and the test waits until B mirrors it.
func (p *fedPair) createFederatedChat(t *testing.T, alice, bob *model.User) string {
	t.Helper()

	status, body := p.a.doJSON(t, http.MethodPost, "/api/chats", alice.Token, map[string]any{"withUserId": bob.ID})
	if status != http.StatusCreated {
		t.Fatalf("POST /api/chats: status = %d, body = %v", status, body)
	}

	chat, ok := body["chat"].(map[string]any)
	if !ok {
		t.Fatalf("POST /api/chats: chat missing in response: %v", body)
	}

	chatID, ok := chat["id"].(string)
	if !ok || chatID == "" {
		t.Fatalf("POST /api/chats: chat id missing in response: %v", body)
	}

	eventually(t, "federated chat mirror on remote server", func() bool {
		remote, ok := p.b.store.GetChat(context.Background(), chatID)

		return ok && slices.Contains(remote.Members, bob.ID)
	})

	return chatID
}

// eventually polls the probe until it succeeds or the timeout expires.
func eventually(t *testing.T, description string, probe func() bool) {
	t.Helper()

	deadline := time.Now().Add(fedTestWait)
	for time.Now().Before(deadline) {
		if probe() {
			return
		}

		time.Sleep(25 * time.Millisecond)
	}

	t.Fatalf("timed out waiting for %s", description)
}

// waitForEvent drains the connection channel until the named event arrives,
// failing with a clear message when the stream closes or stalls.
func waitForEvent(t *testing.T, conn *sse.Connection, name string) sse.Event {
	t.Helper()

	deadline := time.After(fedTestEventWait)
	for {
		select {
		case evt, ok := <-conn.Channel:
			if !ok {
				t.Fatal("sse connection closed before the expected event arrived")
			}

			if evt.Event == name {
				return evt
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q sse event", name)
		}
	}
}

// TestFederationPairWellKnownDiscovery proves the cold-start trust flow: B
// signs a request, A has no cached key, A fetches B's public key over
// /.well-known/fast-chat, verifies the request — and serves the second signed
// request from the cache without a new well-known round-trip.
func TestFederationPairWellKnownDiscovery(t *testing.T) {
	t.Parallel()

	pair := newFederationPair(t)
	alice := pair.a.createUser(t, "alice")

	raw, err := pair.b.client.Request(context.Background(), http.MethodGet,
		pair.a.client.URL(pair.a.domain, "/api/federated/users/search?q=alice"), nil)
	if err != nil {
		t.Fatalf("first signed request B->A: %v", err)
	}

	var search struct {
		Users []model.PublicUser `json:"users"`
	}

	if err := json.Unmarshal(raw, &search); err != nil {
		t.Fatalf("decode remote search response: %v", err)
	}

	if len(search.Users) != 1 || search.Users[0].ID != alice.ID || search.Users[0].Nick != "alice" {
		t.Fatalf("unexpected remote users: %+v", search.Users)
	}

	if hits := pair.b.wellKnownHits.Load(); hits != 1 {
		t.Fatalf("well-known hits on B after cold discovery = %d, want 1", hits)
	}

	// A different request must be served from the cached public key.
	if _, err := pair.b.client.Request(context.Background(), http.MethodGet,
		pair.a.client.URL(pair.a.domain, "/api/federated/users/search?q=al"), nil); err != nil {
		t.Fatalf("second signed request B->A: %v", err)
	}

	if hits := pair.b.wellKnownHits.Load(); hits != 1 {
		t.Fatalf("well-known hits on B after cached request = %d, want 1", hits)
	}
}

// TestFederationPairRemoteUserSearch drives the full client-facing proxy
// path: bob searches "alice:<domainA>" on his own server, the server makes a
// signed federated request to A, verifies A's identity, and relays the result.
func TestFederationPairRemoteUserSearch(t *testing.T) {
	t.Parallel()

	pair := newFederationPair(t)
	alice := pair.a.createUser(t, "alice")
	bob := pair.b.createUser(t, "bob")

	query := url.QueryEscape("alice:" + pair.a.domain)
	status, body := pair.b.doJSON(t, http.MethodGet, "/api/users/search?q="+query, bob.Token, nil)
	if status != http.StatusOK {
		t.Fatalf("GET /api/users/search: status = %d, body = %v", status, body)
	}

	users, ok := body["users"].([]any)
	if !ok {
		t.Fatalf("users missing in response: %v", body)
	}

	if len(users) != 1 {
		t.Fatalf("expected exactly 1 remote user, got %v", users)
	}

	user, ok := users[0].(map[string]any)
	if !ok {
		t.Fatalf("unexpected user entry: %v", users[0])
	}

	if user["id"] != alice.ID {
		t.Errorf("user id = %v, want %q", user["id"], alice.ID)
	}

	if user["nick"] != "alice" {
		t.Errorf("user nick = %v, want %q", user["nick"], "alice")
	}
}

// TestFederationPairCreateChat covers chat creation across servers: A stores
// the federated chat, B mirrors it from the signed callback with correct
// members, and a repeated client request reuses the existing chat without
// duplicating anything.
func TestFederationPairCreateChat(t *testing.T) {
	t.Parallel()

	pair := newFederationPair(t)
	alice := pair.a.createUser(t, "alice")
	bob := pair.b.createUser(t, "bob")

	chatID := pair.createFederatedChat(t, alice, bob)

	chatA, ok := pair.a.store.GetChat(context.Background(), chatID)
	if !ok {
		t.Fatal("chat missing on origin server A")
	}

	if chatA.Type != "private" {
		t.Errorf("chat type on A = %q, want %q", chatA.Type, "private")
	}

	if chatA.RemoteServer != pair.b.domain {
		t.Errorf("chat remote server on A = %q, want %q", chatA.RemoteServer, pair.b.domain)
	}

	if !slices.Contains(chatA.Members, alice.ID) || !slices.Contains(chatA.Members, bob.ID) {
		t.Errorf("chat members on A = %v, want alice and bob", chatA.Members)
	}

	chatB, ok := pair.b.store.GetChat(context.Background(), chatID)
	if !ok {
		t.Fatal("chat mirror missing on remote server B")
	}

	if chatB.RemoteServer != pair.a.domain {
		t.Errorf("chat remote server on B = %q, want %q", chatB.RemoteServer, pair.a.domain)
	}

	if !slices.Contains(chatB.Members, bob.ID) || !slices.Contains(chatB.Members, alice.ID) {
		t.Errorf("chat members on B = %v, want alice and bob", chatB.Members)
	}

	// Re-creating the same pair must return the existing chat, not a new one.
	repeatStatus, repeatBody := pair.a.doJSON(t, http.MethodPost, "/api/chats", alice.Token, map[string]any{"withUserId": bob.ID})
	if repeatStatus != http.StatusCreated {
		t.Fatalf("repeated POST /api/chats: status = %d, body = %v", repeatStatus, repeatBody)
	}

	repeatChat, ok := repeatBody["chat"].(map[string]any)
	if !ok || repeatChat["id"] != chatID {
		t.Fatalf("repeated POST /api/chats: expected same chat %q, got %v", chatID, repeatBody)
	}

	pair.a.client.CloseWait()

	var privateChats int
	for _, chat := range pair.a.store.GetUserChats(context.Background(), alice.ID) {
		if chat.Type == "private" {
			privateChats++
		}
	}

	if privateChats != 1 {
		t.Fatalf("alice has %d private chats on A, want 1", privateChats)
	}

	mirror, ok := pair.b.store.GetChat(context.Background(), chatID)
	if !ok || len(mirror.Members) != 2 {
		t.Fatalf("chat mirror on B changed after retry: ok=%v members=%v", ok, mirror.Members)
	}
}

// TestFederationPairSendMessage sends a message through the normal
// client-facing endpoint on A and verifies the full propagation: the message
// is stored on A, mirrored on B by the signed callback with the same ID and
// author, and bob receives the realtime new_message event on B.
func TestFederationPairSendMessage(t *testing.T) {
	t.Parallel()

	pair := newFederationPair(t)
	alice := pair.a.createUser(t, "alice")
	bob := pair.b.createUser(t, "bob")

	chatID := pair.createFederatedChat(t, alice, bob)
	bobConn := pair.b.listenSSE(t, bob.ID)

	const text = "hello federation"

	status, body := pair.a.doJSON(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, map[string]any{"text": text})
	if status != http.StatusCreated {
		t.Fatalf("POST message: status = %d, body = %v", status, body)
	}

	message, ok := body["message"].(map[string]any)
	if !ok {
		t.Fatalf("POST message: message missing in response: %v", body)
	}

	messageID, ok := message["id"].(string)
	if !ok || messageID == "" {
		t.Fatalf("POST message: id missing in response: %v", body)
	}

	storedA, err := pair.a.store.GetMessage(context.Background(), chatID, messageID)
	if err != nil {
		t.Fatalf("message %s missing on A: %v", messageID, err)
	}

	if storedA.Text != text || storedA.FromID != alice.ID {
		t.Errorf("message on A = (%s, %s), want (%s, %s)", storedA.FromID, storedA.Text, alice.ID, text)
	}

	eventually(t, "message mirror on remote server", func() bool {
		_, err := pair.b.store.GetMessage(context.Background(), chatID, messageID)

		return err == nil
	})

	storedB, err := pair.b.store.GetMessage(context.Background(), chatID, messageID)
	if err != nil {
		t.Fatalf("message %s missing on B: %v", messageID, err)
	}

	if storedB.FromID != alice.ID || storedB.Text != text {
		t.Errorf("message on B = (%s, %s), want (%s, %s)", storedB.FromID, storedB.Text, alice.ID, text)
	}

	evt := waitForEvent(t, bobConn, "new_message")

	broadcast, ok := evt.Data.(*model.Message)
	if !ok {
		t.Fatalf("new_message payload has unexpected type %T", evt.Data)
	}

	if broadcast.ID != messageID || broadcast.Text != text {
		t.Errorf("new_message payload = (%s, %s), want (%s, %s)", broadcast.ID, broadcast.Text, messageID, text)
	}
}

// TestFederationPairTamperedSignatureRejected verifies that a signed request
// carrying a body that does not match the signature is rejected with 401 by
// the real federation auth middleware — going through the full wire path.
func TestFederationPairTamperedSignatureRejected(t *testing.T) {
	t.Parallel()

	pair := newFederationPair(t)

	const path = "/api/federated/users/search?q=alice"

	// Sign the request body with B's key for A as the audience.
	timestamp := time.Now().Unix()
	signature, err := pair.b.manager.Sign(pair.a.domain, http.MethodGet, path, nil, timestamp, "test-nonce")
	if err != nil {
		t.Fatalf("sign request: %v", err)
	}

	// Send the request with a non-empty body that does NOT match what was
	// signed (nil). The auth middleware should fail signature verification
	// and return 401.
	req, err := http.NewRequestWithContext(context.Background(),
		http.MethodGet,
		pair.a.server.URL+path,
		bytes.NewReader([]byte(`{"q":"alice"}`)),
	)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}

	req.Header.Set("X-Federation-Server", pair.b.domain)
	req.Header.Set("X-Federation-Signature", signature)
	req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

	resp, err := pair.a.server.Client().Do(req)
	if err != nil {
		t.Fatalf("tampered request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("tampered request: status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}

	// Positive control: valid signed request must still succeed.
	ctrlURL := pair.b.client.URL(pair.a.domain, "/api/federated/users/search?q=bob")
	_, ctrlErr := pair.b.client.Request(context.Background(), http.MethodGet, ctrlURL, nil)
	if ctrlErr != nil {
		t.Fatalf("valid control request: %v", ctrlErr)
	}
}
