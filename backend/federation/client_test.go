package federation

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"fast_chat/internal/httputil"
)

// errFlakyTransport is returned by flakyRoundTripper to simulate transient
// network failures between federation peers.
var errFlakyTransport = errors.New("flaky transport: connection reset")

// recordedRequest captures one inbound federated request for assertions.
type recordedRequest struct {
	method string
	path   string
	body   []byte
	header http.Header
}

// recordingServer collects every request it receives.
type recordingServer struct {
	t       *testing.T
	mu      sync.Mutex
	got     []recordedRequest
	release chan struct{}
}

func newRecordingServer(t *testing.T) (*httptest.Server, *recordingServer) {
	t.Helper()

	rec := &recordingServer{t: t}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}

		rec.mu.Lock()
		rec.got = append(rec.got, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			body:   body,
			header: r.Header.Clone(),
		})
		rec.mu.Unlock()

		if rec.release != nil {
			<-rec.release
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)

	return srv, rec
}

func (rec *recordingServer) all() []recordedRequest {
	rec.mu.Lock()
	defer rec.mu.Unlock()

	return append([]recordedRequest(nil), rec.got...)
}

func (rec *recordingServer) byMethod(method string) recordedRequest {
	rec.mu.Lock()
	defer rec.mu.Unlock()

	for _, req := range rec.got {
		if req.method == method {
			return req
		}
	}

	rec.t.Fatalf("no %s request recorded (got %d)", method, len(rec.got))

	return recordedRequest{}
}

// flakyRoundTripper fails the first n requests with a transport error and
// delegates the rest to the wrapped RoundTripper.
type flakyRoundTripper struct {
	mu        sync.Mutex
	remaining int
	attempts  atomic.Int64
	next      http.RoundTripper
}

func (f *flakyRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	f.attempts.Add(1)

	f.mu.Lock()
	defer f.mu.Unlock()

	if f.remaining > 0 {
		f.remaining--

		return nil, errFlakyTransport
	}

	return f.next.RoundTrip(req)
}

// peerHost returns the httptest server's host:port for use as the
// federation remoteServer, so background() dials the test server.
func peerHost(t *testing.T, srv *httptest.Server) string {
	t.Helper()

	host := srv.Listener.Addr().String()

	return host
}

func testContextWithRequestID() context.Context {
	return context.WithValue(context.Background(), httputil.RequestIDContextKey, "req-v2-test")
}

func verifyRecorded(t *testing.T, verifier *Manager, req recordedRequest) {
	t.Helper()

	if got := req.header.Get("X-Federation-Server"); got != "local.test" {
		t.Errorf("X-Federation-Server = %q, want %q", got, "local.test")
	}

	if got := req.header.Get(httputil.RequestIDHeader); got != "req-v2-test" {
		t.Errorf("%s = %q, want %q", httputil.RequestIDHeader, got, "req-v2-test")
	}

	sig := req.header.Get("X-Federation-Signature")
	ts, err := strconv.ParseInt(req.header.Get("X-Federation-Timestamp"), 10, 64)
	if err != nil {
		t.Fatalf("parse federation timestamp: %v", err)
	}

	if !verifier.Verify(context.Background(), "local.test", sig, req.method, req.path, req.body, ts) {
		t.Errorf("%s %s: signature does not verify", req.method, req.path)
	}
}

func TestClientPatchAndDelete(t *testing.T) {
	m := newTestManager(t, "local.test")
	verifier := newTestManager(t, "verify.test")
	verifier.cachePublicKey("local.test", m.publicKey, time.Hour)

	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5)
	c.SetHTTPClient(srv.Client())

	peer := peerHost(t, srv)
	ctx := testContextWithRequestID()
	c.Patch(ctx, peer, "/api/federated/chats", map[string]string{"op": "edit"})
	c.Delete(ctx, peer, "/api/federated/messages/m1")
	c.CloseWait()

	if got := len(rec.all()); got != 2 {
		t.Fatalf("recorded %d requests, want 2", got)
	}

	patch := rec.byMethod(http.MethodPatch)
	verifyRecorded(t, verifier, patch)

	var patchBody map[string]string
	if err := json.Unmarshal(patch.body, &patchBody); err != nil {
		t.Fatalf("decode PATCH body: %v", err)
	}

	if patchBody["op"] != "edit" {
		t.Errorf("PATCH body op = %q, want %q", patchBody["op"], "edit")
	}

	del := rec.byMethod(http.MethodDelete)
	verifyRecorded(t, verifier, del)

	if len(del.body) != 0 {
		t.Errorf("DELETE body = %q, want empty", del.body)
	}
}

func TestClientPostEmptyServerIsNoop(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5)
	c.SetHTTPClient(srv.Client())

	c.Post(context.Background(), "", "/api/federated/chats", map[string]string{"op": "create"})
	c.Patch(context.Background(), "", "/api/federated/chats", nil)
	c.Delete(context.Background(), "", "/api/federated/messages/m1")
	c.CloseWait()

	if got := len(rec.all()); got != 0 {
		t.Errorf("recorded %d requests for empty server, want 0", got)
	}
}

func TestClientDropsWhenPoolSaturated(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5)
	c.SetHTTPClient(srv.Client())

	for range maxConcurrentRequests {
		c.sem <- struct{}{}
	}

	c.Post(context.Background(), "peer.test", "/api/federated/chats", nil)
	c.CloseWait()

	if got := len(rec.all()); got != 0 {
		t.Errorf("recorded %d requests under saturation, want 0", got)
	}
}

func TestClientRequestErrors(t *testing.T) {
	m := newTestManager(t, "local.test")
	c := NewClient(m, "local.test", "http", 5)

	if _, err := c.Request(context.Background(), http.MethodPost, "http://peer.test/x", func() {}); err == nil {
		t.Error("unmarshalable body: expected error, got nil")
	}

	if _, err := c.Request(context.Background(), http.MethodPost, "://bad-url", nil); err == nil {
		t.Error("malformed URL: expected error, got nil")
	}

	if _, err := c.Request(context.Background(), "BAD\tMETHOD", "http://peer.test/x", nil); err == nil {
		t.Error("invalid method: expected error, got nil")
	}
}

func TestClientRetriesTransportError(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5)
	flaky := &flakyRoundTripper{remaining: 1, next: srv.Client().Transport}
	c.SetHTTPClient(&http.Client{Transport: flaky})

	body, err := c.Request(context.Background(), http.MethodPost, srv.URL+"/retry", map[string]string{"a": "b"})
	if err != nil {
		t.Fatalf("request after one transient failure: %v", err)
	}

	if string(body) != "{}" {
		t.Errorf("response body = %q, want %q", body, "{}")
	}

	// The failed attempt never reaches the server: only the retry does.
	if got := flaky.attempts.Load(); got != 2 {
		t.Errorf("transport attempts = %d, want 2", got)
	}

	if got := len(rec.all()); got != 1 {
		t.Errorf("recorded %d server hits, want 1", got)
	}
}

func TestClientRetryExhaustion(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, _ := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 30)
	c.SetHTTPClient(&http.Client{
		Transport: &flakyRoundTripper{remaining: 100, next: srv.Client().Transport},
	})

	_, err := c.Request(context.Background(), http.MethodPost, srv.URL+"/down", nil)
	if err == nil {
		t.Fatal("persistent transport failure: expected error, got nil")
	}

	if !errors.Is(err, errFlakyTransport) {
		t.Errorf("error = %v, want it to wrap the transport error", err)
	}
}

func TestClientCloseWaitContext(t *testing.T) {
	m := newTestManager(t, "local.test")

	t.Run("idle returns nil", func(t *testing.T) {
		c := NewClient(m, "local.test", "http", 5)

		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()

		if err := c.CloseWaitContext(ctx); err != nil {
			t.Errorf("idle CloseWaitContext = %v, want nil", err)
		}
	})

	t.Run("blocked request times out then drains", func(t *testing.T) {
		release := make(chan struct{})
		var arrived atomic.Int64

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			arrived.Add(1)
			<-release
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		c := NewClient(m, "local.test", "http", 30)
		c.SetHTTPClient(srv.Client())
		c.Post(context.Background(), peerHost(t, srv), "/block", nil)

		deadline := time.Now().Add(2 * time.Second)
		for arrived.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}

		if arrived.Load() == 0 {
			t.Fatal("background request never arrived")
		}

		timeoutCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()

		if err := c.CloseWaitContext(timeoutCtx); !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("blocked CloseWaitContext = %v, want DeadlineExceeded", err)
		}

		close(release)
		c.CloseWait()
	})
}

func TestGetPublicKeyReturnsOwnKey(t *testing.T) {
	m := newTestManager(t, "local.test")

	if got := m.getPublicKey(context.Background(), "local.test"); got != m.publicKey {
		t.Error("getPublicKey(own domain) did not return the local key")
	}
}

func TestFetchWellKnownRejectsBadURL(t *testing.T) {
	m := newTestManager(t, "local.test")

	if _, err := m.fetchWellKnown(context.Background(), "not a domain"); err == nil {
		t.Error("domain with a space: expected error, got nil")
	}
}

func TestParsePublicKeyPEMRejectsNonRSA(t *testing.T) {
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	der, err := x509.MarshalPKIXPublicKey(&ecKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}

	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))

	if _, err := parsePublicKeyPEM(pemStr); !errors.Is(err, ErrNotRSAPublicKey) {
		t.Errorf("ECDSA key: error = %v, want ErrNotRSAPublicKey", err)
	}
}

func TestParsePublicKeyPEMMalformedDER(t *testing.T) {
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte{0x01, 0x02, 0x03}}))

	if _, err := parsePublicKeyPEM(pemStr); err == nil {
		t.Error("malformed DER: expected error, got nil")
	}
}

func TestLoadPrivateKeyErrors(t *testing.T) {
	if _, err := loadPrivateKey(filepath.Join(t.TempDir(), "missing.priv")); err == nil {
		t.Error("missing file: expected error, got nil")
	}

	dir := t.TempDir()

	garbage := filepath.Join(dir, "garbage.priv")
	if err := os.WriteFile(garbage, []byte("not a pem file"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadPrivateKey(garbage); !errors.Is(err, ErrPrivateKeyPEMDecode) {
		t.Errorf("garbage file: error = %v, want ErrPrivateKeyPEMDecode", err)
	}

	badDER := filepath.Join(dir, "bad.priv")
	badPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte{0x01, 0x02}})

	if err := os.WriteFile(badDER, badPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadPrivateKey(badDER); err == nil {
		t.Error("malformed DER: expected error, got nil")
	}

	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	ecDER, err := x509.MarshalPKCS8PrivateKey(ecKey)
	if err != nil {
		t.Fatal(err)
	}

	ecPath := filepath.Join(dir, "ec.priv")
	ecPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER})

	if err := os.WriteFile(ecPath, ecPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadPrivateKey(ecPath); !errors.Is(err, ErrKeyNotRSA) {
		t.Errorf("ECDSA key: error = %v, want ErrKeyNotRSA", err)
	}
}

func TestLoadOrGenerateKeysBadDir(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadOrGenerateKeys(filepath.Join(blocker, "sub")); err == nil {
		t.Error("key dir under a file: expected error, got nil")
	}
}

func TestSafeDialerMalformedAddress(t *testing.T) {
	client := NewSafeHTTPClient(time.Second)

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport is %T, want *http.Transport", client.Transport)
	}

	if _, err := transport.DialContext(context.Background(), "tcp", "no-colon-port"); err == nil {
		t.Error("address without port: expected error, got nil")
	}
}

func TestSafeDialerRefusesLoopbackByName(t *testing.T) {
	client := NewSafeHTTPClient(2 * time.Second)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://localhost:80/", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}

	if !errors.Is(err, ErrNoSafeAddress) {
		t.Errorf("localhost: error = %v, want ErrNoSafeAddress", err)
	}
}

func TestSafeDialerDialsSafeLiteral(t *testing.T) {
	client := NewSafeHTTPClient(time.Second)

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport is %T, want *http.Transport", client.Transport)
	}

	// 192.0.2.1 is TEST-NET-1: not in any unsafe range, so the dial is
	// always attempted. Whether it succeeds depends on the environment
	// (sandboxes may intercept outbound TCP); either outcome proves the
	// address passed the SSRF check.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	conn, err := transport.DialContext(ctx, "tcp", "192.0.2.1:80")
	if conn != nil {
		_ = conn.Close()
	}

	if errors.Is(err, ErrUnsafeAddress) || errors.Is(err, ErrNoSafeAddress) {
		t.Errorf("safe literal rejected as unsafe: %v", err)
	}
}
