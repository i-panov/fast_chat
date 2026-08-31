package federation

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsUnsafeIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"127.8.8.8", true},
		{"::1", true},
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.1.1", true},
		{"169.254.0.1", true},     // link-local unicast
		{"169.254.169.254", true}, // cloud metadata service
		{"fe80::1", true},         // IPv6 link-local
		{"0.0.0.0", true},         // unspecified
		{"::", true},
		{"224.0.0.1", true}, // multicast
		{"239.255.255.250", true},
		{"ff02::1", true},
		{"fc00::1", true}, // IPv6 ULA (private)
		{"fd12:3456::1", true},
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"203.0.113.7", false},
		{"198.51.100.2", false},
		{"2606:4700:4700::1111", false},
	}

	for _, tc := range cases {
		ip := net.ParseIP(tc.ip)
		if ip == nil {
			t.Fatalf("test IP %q failed to parse", tc.ip)
		}

		if got := isUnsafeIP(ip); got != tc.want {
			t.Errorf("isUnsafeIP(%q) = %v, want %v", tc.ip, got, tc.want)
		}
	}
}

func TestSafeClientRefusesUnsafeHosts(t *testing.T) {
	client := NewSafeHTTPClient(2 * time.Second)

	cases := []string{
		"http://127.0.0.1:1/",
		"http://[::1]:1/",
		"http://0.0.0.0:1/",
		"http://169.254.169.254/",
		"http://10.0.0.1:1/",
		"http://192.168.1.1:1/",
		"http://224.0.0.1:1/",
	}

	for _, url := range cases {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, http.NoBody)
		if err != nil {
			t.Fatalf("build request %q: %v", url, err)
		}

		resp, err := client.Do(req)
		if resp != nil {
			resp.Body.Close()
		}

		if !errors.Is(err, ErrUnsafeAddress) {
			t.Errorf("%s: expected ErrUnsafeAddress, got %v", url, err)
		}
	}
}

func TestSafeClientRefusesLoopbackListener(t *testing.T) {
	listenCfg := net.ListenConfig{}
	ln, err := listenCfg.Listen(context.Background(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
	go func() {
		_ = srv.Serve(ln)
	}()
	defer srv.Close()

	client := NewSafeHTTPClient(time.Second)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+ln.Addr().String()+"/", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Do(req)
	if resp != nil {
		resp.Body.Close()
	}

	if !errors.Is(err, ErrUnsafeAddress) {
		t.Fatalf("expected ErrUnsafeAddress dialing loopback listener, got %v", err)
	}
}

func TestLoadOrGenerateKeys(t *testing.T) {
	t.Run("generates and reloads the same key", func(t *testing.T) {
		dir := t.TempDir()

		first, err := LoadOrGenerateKeys(dir)
		if err != nil {
			t.Fatalf("first load: %v", err)
		}

		second, err := LoadOrGenerateKeys(dir)
		if err != nil {
			t.Fatalf("second load: %v", err)
		}

		if first.D.Cmp(second.D) != 0 || first.N.Cmp(second.N) != 0 {
			t.Error("reload produced a different private key")
		}
	})

	t.Run("private key is not world-readable", func(t *testing.T) {
		dir := t.TempDir()

		if _, err := LoadOrGenerateKeys(dir); err != nil {
			t.Fatalf("load: %v", err)
		}

		info, err := os.Stat(filepath.Join(dir, privFileName))
		if err != nil {
			t.Fatalf("stat private key: %v", err)
		}

		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("private key has world/group bits set: %o", info.Mode().Perm())
		}
	})
}

func TestPublicKeyPEMRoundtripLoad(t *testing.T) {
	dir := t.TempDir()

	key, err := LoadOrGenerateKeys(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	m := New(key, "local.test", "http", 5)
	t.Cleanup(m.Close)

	pemStr, err := m.PublicKeyPEM()
	if err != nil {
		t.Fatalf("PublicKeyPEM: %v", err)
	}

	parsed, err := parsePublicKeyPEM(pemStr)
	if err != nil {
		t.Fatalf("parsePublicKeyPEM: %v", err)
	}

	if parsed == nil || parsed.N.Cmp(key.PublicKey.N) != 0 {
		t.Error("re-parsed PEM public key does not match the private key")
	}
}

func TestGetPublicKeyFetchesAndCaches(t *testing.T) {
	remoteKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	remote := New(remoteKey, "remote.test", "http", 5)
	t.Cleanup(remote.Close)

	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path != wellKnownPath {
			http.NotFound(w, r)
			return
		}

		remote.WellKnownHandler(w, r)
	}))
	defer srv.Close()

	// Point the manager at the local server: override the client so the
	// safe dialer's loopback refusal does not interfere, and use the
	// listener address as the "remote domain".
	m := newTestManager(t, "local.test")
	m.client = srv.Client()

	domain := strings.TrimPrefix(srv.URL, "http://")

	first := m.getPublicKey(context.Background(), domain)
	second := m.getPublicKey(context.Background(), domain)

	if first == nil || first.N.Cmp(remoteKey.PublicKey.N) != 0 {
		t.Fatal("first fetch returned the wrong key")
	}

	if second == nil || second.N.Cmp(remoteKey.PublicKey.N) != 0 {
		t.Fatal("cached fetch returned the wrong key")
	}

	if hits != 1 {
		t.Fatalf("expected exactly 1 well-known fetch, got %d", hits)
	}
}

func TestGetPublicKeyNonOKStatusIsNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	m := newTestManager(t, "local.test")
	m.client = srv.Client()

	domain := strings.TrimPrefix(srv.URL, "http://")

	if got := m.getPublicKey(context.Background(), domain); got != nil {
		t.Fatal("getPublicKey should return nil when well-known returns non-200")
	}
}
