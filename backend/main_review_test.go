package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// deadlineRecorder records the write deadline a handler asked for.
type deadlineRecorder struct {
	*httptest.ResponseRecorder
	deadline time.Time
	set      bool
}

func (r *deadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	r.deadline = deadline
	r.set = true

	return nil
}

// An ordinary response gets a finite write deadline; the SSE stream must not,
// or every event stream would be cut.
func TestWriteDeadlineMiddlewareSkipsOnlyTheEventStream(t *testing.T) {
	plain := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler := writeDeadlineMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	handler.ServeHTTP(plain, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/chats", http.NoBody))

	if !plain.set {
		t.Fatal("an ordinary response must get a write deadline")
	}
	if until := time.Until(plain.deadline); until <= 0 || until > responseWriteTimeout {
		t.Fatalf("deadline in %v, want within %v", until, responseWriteTimeout)
	}

	stream := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}

	handler.ServeHTTP(stream, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/events?connectionId=x", http.NoBody))

	if stream.set {
		t.Fatal("the event stream must not get a write deadline")
	}
}

// An in-memory database has no directory: the process working directory must
// keep its mode.
func TestPrepareDatabaseDirLeavesInMemoryAlone(t *testing.T) {
	dir := t.TempDir()

	// A directory mode the chmod would have changed.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })

	if err := prepareDatabaseDir(dbInMemoryPath); err != nil {
		t.Fatalf("prepareDatabaseDir(:memory:) = %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("the working directory mode changed to %o", info.Mode().Perm())
	}
}

// A file database gets its own directory, created private.
func TestPrepareDatabaseDirTightensTheDataDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")

	if err := prepareDatabaseDir(filepath.Join(dir, "fastchat.db")); err != nil {
		t.Fatalf("prepareDatabaseDir = %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}

	if info.Mode().Perm() != 0o700 {
		t.Fatalf("data directory mode = %o, want 700", info.Mode().Perm())
	}
}
