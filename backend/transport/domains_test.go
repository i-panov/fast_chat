package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/filestage"
	"fast_chat/service"
	"fast_chat/store"
)

// domainTestServer bundles the collaborators a domain test needs.
type domainTestServer struct {
	Handler http.Handler
	Store   *store.Store
	Cfg     *config.Config
	Fed     *federation.Manager
}

// newDomainTestServer builds a full transport (all domains) wired with real
// collaborators.
func newDomainTestServer(t *testing.T) *domainTestServer {
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	cfg := testAPIConfig()
	cfg.Uploads = config.UploadsConfig{Dir: t.TempDir()}

	key, err := federation.LoadOrGenerateKeys(filepath.Join(t.TempDir(), "fed.key"))
	if err != nil {
		t.Fatal(err)
	}

	fm := federation.New(key, cfg.Server.Domain, "http", 5)
	svc := service.New(st, cfg, hub, nil)
	fed := federation.NewClient(fm, cfg.Server.Domain, "http", 5)
	transport := New(&Deps{
		Hub:           hub,
		Store:         st,
		Svc:           svc,
		Cfg:           cfg,
		FedManager:    fm,
		FedClient:     fed,
		PushPublicKey: func() (string, bool) { return "", false },
		Version:       "test-version",
		Commit:        "test-commit",
	})

	return &domainTestServer{Handler: transport.Handler(), Store: st, Cfg: cfg, Fed: fm}
}

// bearerReq builds an authenticated JSON request.
func bearerReq(t *testing.T, method, path, token, body string) *http.Request {
	t.Helper()

	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	req := httptest.NewRequestWithContext(context.Background(), method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	return req
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body not JSON: %v (body=%q)", err, rec.Body.String())
	}

	return resp
}

func TestConfigEndpoint(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/config", "", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeBody(t, rec)
	if resp["version"] != "test-version" {
		t.Errorf("version = %v", resp["version"])
	}

	if _, has := resp["messageEditTTL"]; !has {
		t.Errorf("missing messageEditTTL in %v", resp)
	}
}

func TestSearchUsersShortQuery(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/users/search?q=a", user.Token, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeBody(t, rec)
	users, isSlice := resp["users"].([]any)
	if !isSlice || len(users) != 0 {
		t.Errorf("expected empty users list, got %v", resp["users"])
	}
}

func TestPublicKeyFlow(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	// Invalid key is rejected with the legacy message.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPut, "/api/users/public-key", user.Token, `{"publicKey":"not-base64!!"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "invalid public key" {
		t.Errorf("error = %v", resp["error"])
	}

	// A valid 32-byte base64 key is accepted.
	valid := base64.StdEncoding.EncodeToString(make([]byte, 32))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPut, "/api/users/public-key", user.Token, `{"publicKey":"`+valid+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Fetching it back works.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/users/"+user.ID+"/public-key", user.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeBody(t, rec)
	if resp["publicKey"] == "" {
		t.Errorf("expected publicKey, got %v", resp)
	}
}

func TestKeyBackupFlow(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPut, "/api/users/key-backup", user.Token, `{"backup":"not base64!"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPut, "/api/users/key-backup", user.Token, `{"backup":"QUJDRA=="}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/users/key-backup", user.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["backup"] != "QUJDRA==" {
		t.Errorf("backup = %v", resp["backup"])
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodDelete, "/api/users/key-backup", user.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/users/key-backup", user.Token, ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", rec.Code)
	}
}

func TestPushEndpoints(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	// No push sender configured in tests beyond the legacy nil → 404.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/push/vapid-public-key", "", ""))
	if rec.Code != http.StatusOK && rec.Code != http.StatusNotFound {
		t.Fatalf("unexpected vapid status %d", rec.Code)
	}

	// Missing fields → legacy message.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token, `{"endpoint":"https://fcm.googleapis.com/fcm/send/x","p256dh":"","auth":""}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "endpoint, p256dh, and auth are required" {
		t.Errorf("error = %v", resp["error"])
	}

	// Unknown push service domain → invalid endpoint.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token,
		`{"endpoint":"https://evil.example.com/sub","p256dh":"k","auth":"a"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "invalid push endpoint" {
		t.Errorf("error = %v", resp["error"])
	}

	// Deleting requires the endpoint.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodDelete, "/api/push/subscribe", user.Token, `{}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestCreatePrivateChatAndMessages(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	alice := createTestUser(t, st)

	// Create a second user to chat with.
	bob, err := st.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Create private chat → 201 {"chat":...}.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token, `{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)
	if chatID == "" {
		t.Fatal("expected chat id in response")
	}

	// Empty message is rejected by the service with the legacy message.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, `{"id":"m1","text":""}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	// Send a message → 201 {"message":...}.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, `{"id":"m2","text":"hello"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["message"] == nil {
		t.Errorf("expected message in response, got %v", resp)
	}

	// List messages → {messages, nextCursor}.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/chats/"+chatID+"/messages", alice.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	resp := decodeBody(t, rec)
	messages, isSlice := resp["messages"].([]any)
	if !isSlice || len(messages) != 1 {
		t.Errorf("expected 1 message, got %v", resp["messages"])
	}

	if _, has := resp["nextCursor"]; !has {
		t.Errorf("missing nextCursor in %v", resp)
	}

	// Typing → ok.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/typing", alice.Token, `{"active":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// A user outside the chat is forbidden.
	carol, err := st.CreateUser(context.Background(), "carol@test.local", "carol", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/chats/"+chatID+"/messages", carol.Token, ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-member, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestMarkMessagesReadValidation(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/messages/read", user.Token, `{"messageIDs":[],"chatId":"c1"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "messageIds and chatId are required" {
		t.Errorf("error = %v", resp["error"])
	}

	rec = httptest.NewRecorder()
	tooMany := `{"messageIDs":[` + strings.Repeat(`"x",`, 101) + `"x"],"chatId":"c1"}`
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/messages/read", user.Token, tooMany))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	if resp := decodeBody(t, rec); resp["error"] != "too many message IDs" {
		t.Errorf("error = %v", resp["error"])
	}
}

func TestSyncValidation(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/sync?since=garbage", user.Token, ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "invalid since timestamp" {
		t.Errorf("error = %v", resp["error"])
	}
}

func TestFileExistsValidation(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/exists", user.Token, ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/exists?hash=zzz", user.Token, ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	validHash := strings.Repeat("ab", 32)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/exists?hash="+validHash, user.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	if resp := decodeBody(t, rec); resp["exists"] != false {
		t.Errorf("exists = %v", resp["exists"])
	}
}

func TestFileUploadAndServe(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	user := createTestUser(t, st)

	// Build a multipart upload body.
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	part, err := writer.CreateFormFile("file", "hello.txt")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := part.Write([]byte("hello world")); err != nil {
		t.Fatal(err)
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+user.Token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	fileMap, _ := decodeBody(t, rec)["file"].(map[string]any)
	fileID, _ := fileMap["id"].(string)
	if fileID == "" {
		t.Fatal("expected file id in response")
	}

	// Attach the file to a chat message (access requires chat membership).
	_, err = st.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", user.Token, `{"type":"private","withUserId":"bob:localhost:8080"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for chat, got %d: %s", rec.Code, rec.Body.String())
	}

	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", user.Token,
		`{"id":"fm1","text":"with file","fileIDs":["`+fileID+`"]}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for message, got %d: %s", rec.Code, rec.Body.String())
	}

	// Download the file back.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/"+fileID, user.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	if got := rec.Body.String(); got != "hello world" {
		t.Errorf("file content = %q", got)
	}

	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}

	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing nosniff header")
	}
}

func TestFederatedEndpointRequiresSignature(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/federated/users/search?q=alice", "", ""))

	// No federation headers: the transport middleware rejects with 401 and the
	// legacy error shape.
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "unauthorized" {
		t.Errorf("error = %v", resp["error"])
	}
}

func TestFederatedSignedRequestFlow(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	st := ts.Store
	fm := ts.Fed

	alice := createTestUser(t, st)

	// A correctly signed request must reach the operation.
	timestamp := time.Now().Unix()
	uri := "/api/federated/users/search?q=alice"
	ownDomain := fm.ServerDomain()

	signature, err := fm.Sign(http.MethodGet, uri, nil, timestamp)
	if err != nil {
		t.Fatal(err)
	}

	req := bearerReq(t, http.MethodGet, uri, "", "")
	req.Header.Set("X-Federation-Server", ownDomain)
	req.Header.Set("X-Federation-Signature", signature)
	req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for signed request, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeBody(t, rec)
	users, isSlice := resp["users"].([]any)
	if !isSlice {
		t.Fatalf("expected users list, got %v", resp)
	}

	// alice belongs to this server; she must be visible to remote search.
	found := false

	for _, u := range users {
		if m, _ := u.(map[string]any); m["nick"] == "alice" && m["id"] == alice.ID {
			found = true
		}
	}

	if !found {
		t.Errorf("alice not found in remote search results: %v", users)
	}

	// A bad signature is rejected with the legacy 401 shape.
	req = bearerReq(t, http.MethodGet, uri, "", "")
	req.Header.Set("X-Federation-Server", "remote.example.com")
	req.Header.Set("X-Federation-Signature", "badsig")
	req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for bad signature, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestOversizedUploadRejected(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler

	alice := createTestUser(t, ts.Store)

	// Shrink the upload cap for the test; the upload handler reads it at
	// request time.
	prev := filestage.MaxUploadSize
	filestage.MaxUploadSize = 64 << 10
	t.Cleanup(func() { filestage.MaxUploadSize = prev })

	big := bytes.Repeat([]byte("x"), 128<<10)

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	part, err := writer.CreateFormFile("file", "big.bin")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := part.Write(big); err != nil {
		t.Fatal(err)
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+alice.Token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// Legacy parity: 413 "file too large" (MaxBytesReader trips, ParseMultipartForm fails).
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "file too large" {
		t.Errorf("error = %v", resp["error"])
	}
}

func TestOversizedFederatedBodyRejected(t *testing.T) {
	ts := newDomainTestServer(t)
	h, fm := ts.Handler, ts.Fed

	// A signed federated request whose body exceeds the 10 MiB signature cap
	// must be rejected with 413 (legacy parity), not panic or hang.
	timestamp := time.Now().Unix()
	uri := "/api/federated/chats"
	big := bytes.Repeat([]byte("a"), (10<<20)+1024)

	signature, err := fm.Sign(http.MethodPost, uri, big, timestamp)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, uri, bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", fm.ServerDomain())
	req.Header.Set("X-Federation-Signature", signature)
	req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "request body too large" {
		t.Errorf("error = %v", resp["error"])
	}
}

const (
	tinyPNG = "\x89PNG\r\n\x1a\nfake-png-bytes"
	htmlDoc = "<!doctype html><html><body><script>alert(1)</script></body></html>"
)

// uploadViaAPI uploads body as filename and returns the file ID.
func uploadViaAPI(t *testing.T, h http.Handler, token, filename, body string) string {
	t.Helper()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := part.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("upload %s: expected 201, got %d: %s", filename, rec.Code, rec.Body.String())
	}

	id, _ := decodeBody(t, rec)["file"].(map[string]any)["id"].(string)
	if id == "" {
		t.Fatalf("upload %s: missing file id", filename)
	}

	return id
}

func TestFileServingSecurityPolicy(t *testing.T) {
	ts := newDomainTestServer(t)
	h, st := ts.Handler, ts.Store

	alice := createTestUser(t, st)

	bob, err := st.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token, `{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("chat create: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	attach := func(fileID, messageID string) {
		msg, err := st.AddMessage(context.Background(), chatID, "", alice.ID, alice.Nick, "f", messageID, "", nil, false, "")
		if err != nil {
			t.Fatal(err)
		}

		if err := st.AddMessageFiles(context.Background(), msg.ID, []string{fileID}); err != nil {
			t.Fatal(err)
		}
	}

	// MIME sniffing ignores the client-provided filename/content type: PNG
	// bytes under an .html name are detected as image/png.
	pngID := uploadViaAPI(t, h, alice.Token, "evil.html", tinyPNG)

	fileRecord, err := st.GetFile(context.Background(), pngID)
	if err != nil {
		t.Fatal(err)
	}

	if fileRecord.MimeType != "image/png" {
		t.Errorf("png sniffed mime = %q, want image/png", fileRecord.MimeType)
	}

	// HTML bytes under a .png name are detected as text/html...
	htmlID := uploadViaAPI(t, h, alice.Token, "doc.png", htmlDoc)

	fileRecord, err = st.GetFile(context.Background(), htmlID)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(fileRecord.MimeType, "text/html") {
		t.Errorf("html sniffed mime = %q, want text/html", fileRecord.MimeType)
	}

	// ...and forced to attachment when served (XSS neutralised).
	attach(htmlID, "msg-html")

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/"+htmlID, alice.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("download: expected 200, got %d", rec.Code)
	}

	if disp := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(disp, "attachment") {
		t.Errorf("html disposition = %q, want attachment", disp)
	}

	// Safe image types are served inline.
	attach(pngID, "msg-png")

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/"+pngID, alice.Token, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("download: expected 200, got %d", rec.Code)
	}

	if disp := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(disp, "inline") {
		t.Errorf("png disposition = %q, want inline", disp)
	}

	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/png") {
		t.Errorf("png content type = %q", ct)
	}
}

func TestServeFileRejectsNonMember(t *testing.T) {
	ts := newDomainTestServer(t)
	h, st := ts.Handler, ts.Store

	alice := createTestUser(t, st)
	carol, err := st.CreateUser(context.Background(), "carol@test.local", "carol", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// A file that exists but is not attached to any of carol's chats.
	htmlID := uploadViaAPI(t, h, alice.Token, "secret.png", htmlDoc)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/files/"+htmlID, carol.Token, ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-member, got %d", rec.Code)
	}
}

func TestOpenAPIEndpointsDisabled(t *testing.T) {
	ts := newDomainTestServer(t)

	for _, path := range []string{"/openapi.json", "/openapi.yaml", "/openapi-3.0.json", "/docs", "/schemas"} {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, http.NoBody)
		rec := httptest.NewRecorder()
		ts.Handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (must not be exposed)", path, rec.Code)
		}
	}
}
