package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGetChats(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodGet, "/api/chats", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.GetChats)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), chat.ID) {
		t.Errorf("expected chat %s in response, got %s", chat.ID, w.Body.String())
	}
}

func TestCloseWithInFlightFederatedRequest(t *testing.T) {
	h := newTestHandler(t)

	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started) })
		<-release
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	h.fedClient = srv.Client()

	// Fire a background federated request against the local httptest
	// server. Close() must wait for it to finish.
	remoteAddr := srv.Listener.Addr().String()
	h.doFedRequestBackground(context.Background(), remoteAddr, "/x", http.MethodGet, nil)

	<-started

	closeFinished := make(chan struct{})
	go func() {
		defer close(closeFinished)
		h.Close()
	}()

	select {
	case <-closeFinished:
		t.Fatal("Close() returned before the in-flight request finished")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-closeFinished:
	case <-time.After(5 * time.Second):
		t.Fatal("Close() did not return after the request finished")
	}
}

func TestSearchFederatedLocalDomain(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	// q contains "nick:localhost:8080" -> local search branch.
	req := authReq(http.MethodGet, "/api/users/search?q="+strings.ReplaceAll("bob:localhost:8080", ":", "%3A"), alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), bob.id) {
		t.Errorf("expected user %s in local federated search, got %s", bob.id, w.Body.String())
	}
}

func TestSearchFederatedValidationBranches(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	// Empty nick -> 400.
	req := authReq(http.MethodGet, "/api/users/search?q="+strings.ReplaceAll(":remote.test", ":", "%3A"), alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty nick: expected 400, got %d", w.Code)
	}

	// Loopback IP domain -> rejected by isValidRemoteDomain -> 400.
	req = authReq(http.MethodGet, "/api/users/search?q="+strings.ReplaceAll("bob:127.0.0.1", ":", "%3A"), alice.token, "")
	w = httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("loopback domain: expected 400, got %d", w.Code)
	}
}

func TestSearchFederatedRemote(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"users":[{"id":"bob:remote.test","nick":"bob"}]}`))
	}))
	defer srv.Close()

	h.fedClient = srv.Client()

	// Route the federated search at the loopback upstream. The port suffix
	// makes the domain pass isValidRemoteDomain (it is not a bare IP).
	addr := srv.Listener.Addr().String()
	req := authReq(http.MethodGet, "/api/users/search?q="+strings.ReplaceAll("bob:"+addr, ":", "%3A"), alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "bob:remote.test") {
		t.Errorf("expected remote user in response, got %s", w.Body.String())
	}
}
