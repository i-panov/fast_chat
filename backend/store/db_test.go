package store

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// initTestDB opens a file-backed store the way main does, so the connection pool
// and pragmas are the production ones. A file is required: an in-memory database
// is private to its connection and would not reproduce the contention.
func initTestDB(t *testing.T) *Store {
	t.Helper()

	db, err := InitDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("InitDB: %v", err)
	}

	return New(db)
}

// concurrentRecorder collects failures from the goroutines below.
type concurrentRecorder struct {
	mu   sync.Mutex
	errs []error
}

func (r *concurrentRecorder) add(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.errs = append(r.errs, err)
}

func (r *concurrentRecorder) failed() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.errs)
}

func (r *concurrentRecorder) first() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.errs) == 0 {
		return nil
	}

	return r.errs[0]
}

// TestConcurrentWritesDoNotHitSQLiteBusy drives more writers than the pool has
// connections, interleaving reads so the pool is not saturated by writes alone.
func TestConcurrentWritesDoNotHitSQLiteBusy(t *testing.T) {
	const (
		writers        = 12
		messagesPerRun = 6
	)

	s := initTestDB(t)
	ctx := context.Background()

	if _, err := s.CreateUser(ctx, "a@example.com", "alice", "test", 0); err != nil {
		t.Fatal(err)
	}

	if _, err := s.CreateUser(ctx, "b@example.com", "bob", "test", 0); err != nil {
		t.Fatal(err)
	}

	chat, err := s.CreateChat(ctx, "alice:test", "bob:test", "")
	if err != nil {
		t.Fatal(err)
	}

	var (
		wg      sync.WaitGroup
		rec     concurrentRecorder
		chatID  = chat.ID
		users   = []string{"alice:test", "bob:test"}
		addRuns = writers * messagesPerRun
	)

	for w := range writers {
		wg.Add(1)

		go func(w int) {
			defer wg.Done()

			for i := range messagesPerRun {
				if _, err := s.GetMessage(ctx, chatID, "nonexistent"); err == nil {
					rec.add(fmt.Errorf("reader %d/%d: expected a miss", w, i))
				}

				if _, _, err := s.AddMessage(ctx, chatID, "", users[w%len(users)], "n",
					fmt.Sprintf("w%d i%d", w, i),
					fmt.Sprintf("m-%d-%d", w, i), "", nil, false, ""); err != nil {
					rec.add(fmt.Errorf("writer %d/%d: %w", w, i, err))
				}
			}
		}(w)
	}

	wg.Wait()

	if rec.failed() > 0 {
		t.Errorf("%d of %d concurrent operations failed, first: %v", rec.failed(), addRuns, rec.first())
	}
}

// TestReadThenWriteTransactionSurvivesAConcurrentCommit is the case that used to
// surface as SQLITE_BUSY for a user.
//
// A transaction here reads before it writes: AddChatMember counts the current
// members and then inserts, and the edit and delete paths read a message before
// changing it. Under a deferred BEGIN that read pins a snapshot, so the write
// after it is an upgrade. If any other connection committed in between, the
// upgrade cannot be granted and fails immediately rather than waiting — the busy
// handler is not consulted for it. AddChatMember concurrent with plain message
// inserts reproduces exactly that interleaving.
func TestReadThenWriteTransactionSurvivesAConcurrentCommit(t *testing.T) {
	const (
		joiners    = 8
		committers = 4
		commits    = 12
	)

	s := initTestDB(t)
	ctx := context.Background()

	owner := "owner:test"

	if _, err := s.CreateUser(ctx, "owner@example.com", "owner", "test", 0); err != nil {
		t.Fatal(err)
	}

	group, err := s.CreateGroupChat(ctx, owner, "group", nil, "")
	if err != nil {
		t.Fatal(err)
	}

	users := make([]string, joiners)
	for i := range joiners {
		nick := fmt.Sprintf("j%d", i)
		if _, err := s.CreateUser(ctx, nick+"@example.com", nick, "test", 0); err != nil {
			t.Fatal(err)
		}

		users[i] = nick + ":test"
	}

	var (
		wg  sync.WaitGroup
		rec concurrentRecorder
	)

	for i, userID := range users {
		wg.Add(1)

		go func(i int, userID string) {
			defer wg.Done()

			// A few rounds so the joins interleave with the commits repeatedly
			// rather than settling into one clean order.
			for round := range 3 {
				if err := s.AddChatMember(ctx, group.ID, userID, joiners+1); err != nil {
					rec.add(fmt.Errorf("AddChatMember %s round %d: %w", userID, round, err))
				}
			}
		}(i, userID)
	}

	for c := range committers {
		wg.Add(1)

		go func(c int) {
			defer wg.Done()

			for i := range commits {
				if _, _, err := s.AddMessage(ctx, group.ID, "", owner, "owner",
					fmt.Sprintf("c%d i%d", c, i),
					fmt.Sprintf("msg-%d-%d", c, i), "", nil, false, ""); err != nil {
					rec.add(fmt.Errorf("commit %d/%d: %w", c, i, err))
				}
			}
		}(c)
	}

	wg.Wait()

	if rec.failed() > 0 {
		t.Errorf("%d concurrent operations failed, first: %v", rec.failed(), rec.first())
	}

	// The members really joined: a fix that made the transaction fail quietly
	// would pass the check above.
	chat, ok := s.GetChat(ctx, group.ID)
	if !ok {
		t.Fatal("group chat disappeared")
	}

	for _, userID := range users {
		if !slices.Contains(chat.Members, userID) {
			t.Errorf("%s did not join; members: %v", userID, chat.Members)
		}
	}
}

// TestEveryPooledConnectionCarriesTheBusyTimeout pins the dependency on the
// driver applying a busy timeout to every connection it opens. A transaction
// waiting for the write lock is only retried if that timeout is set, and this
// package no longer sets it itself.
func TestEveryPooledConnectionCarriesTheBusyTimeout(t *testing.T) {
	const want = 5000

	db, err := InitDB(filepath.Join(t.TempDir(), "pragma.db"))
	if err != nil {
		t.Fatalf("InitDB: %v", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}

	// Hold each connection without releasing it, so the pool has to open a new
	// one for the next call and each pragma read reflects a distinct connection.
	held := make([]interface{ Close() error }, 0, maxOpenConns)

	defer func() {
		for _, c := range held {
			_ = c.Close()
		}
	}()

	for range maxOpenConns {
		conn, err := sqlDB.Conn(context.Background())
		if err != nil {
			t.Fatalf("Conn: %v", err)
		}

		held = append(held, conn)

		var got int
		if err := conn.QueryRowContext(context.Background(), "PRAGMA busy_timeout").Scan(&got); err != nil {
			t.Fatalf("PRAGMA busy_timeout: %v", err)
		}

		if got != want {
			t.Errorf("a pooled connection has busy_timeout=%d, want %d", got, want)
		}
	}
}

// TestWithPragmasKeepsAnExistingQuery keeps a DSN that already carries
// parameters usable: appending with "?" would silently drop them.
func TestWithPragmasKeepsAnExistingQuery(t *testing.T) {
	cases := []struct {
		name string
		dsn  string
	}{
		{name: "plain path", dsn: "data/fastchat.db"},
		{name: "uri form", dsn: "file:data/fastchat.db?cache=shared"},
		{name: "existing pragma", dsn: "/tmp/x.db?_pragma=foreign_keys%281%29"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := withPragmas(tc.dsn)

			if !strings.Contains(got, "journal_mode%28WAL%29") {
				t.Errorf("WAL pragma missing from %q", got)
			}

			if !strings.Contains(got, "_txlock=immediate") {
				t.Errorf("_txlock missing from %q", got)
			}

			if strings.Count(got, "?") > 1 {
				t.Errorf("second query separator introduced: %q", got)
			}

			base := tc.dsn
			if i := strings.Index(base, "?"); i >= 0 {
				base = base[:i]
				if !strings.Contains(got, strings.TrimPrefix(base, "file:")) {
					t.Errorf("existing query dropped: %q", got)
				}
			}
		})
	}
}
