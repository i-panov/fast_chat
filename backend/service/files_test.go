package service

import (
	"context"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/store"
)

func newTestService(t *testing.T) *Service {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &store.ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{}); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
	}

	return New(store.New(db), cfg, nil, nil)
}

func TestIsHexString(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"0123456789abcdef", true},
		{"ABCDEF", true},
		{"deadbeef", true},
		{"zz", false},
		{"abcdefg", false},
		{"0x12", false},
		{"-1", false},
	}
	for _, c := range cases {
		if got := IsHexString(c.in); got != c.want {
			t.Errorf("IsHexString(%q)=%v want %v", c.in, got, c.want)
		}
	}
}

func TestDedupFileByHash_ExactPairReuse(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	stored, err := s.store.SaveFile(ctx, "hash-abc", "image/png", 10, "a.png", "20060102/one", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, &FileUpload{
		Hash:         "hash-abc",
		MimeType:     "image/png",
		Size:         10,
		OriginalName: "a.png",
		Uploader:     "alice:local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !deduped {
		t.Fatal("expected deduped")
	}
	if !check.ExactMatch {
		t.Fatal("expected exact match reuse")
	}
	if check.File == nil || check.File.ID != stored.ID {
		t.Fatalf("expected replayed record %q, got %v", stored.ID, check.File)
	}

	if count := countFiles(t, s, "hash-abc"); count != 1 {
		t.Fatalf("exact reuse must not create a new record, got %d", count)
	}
}

func TestDedupFileByHash_NewNameNewRecord(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	if _, err := s.store.SaveFile(ctx, "hash-abc", "image/png", 10, "a.png", "20060102/one", "alice:local"); err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, &FileUpload{
		Hash:         "hash-abc",
		MimeType:     "image/png",
		Size:         10,
		OriginalName: "b.png",
		Uploader:     "alice:local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !deduped {
		t.Fatal("expected deduped")
	}
	if check.ExactMatch {
		t.Fatal("expected NOT exact match for a new name")
	}
	if check.File == nil || check.File.OriginalName != "b.png" {
		t.Fatalf("expected new record named b.png, got %+v", check.File)
	}

	if count := countFiles(t, s, "hash-abc"); count != 2 {
		t.Fatalf("expected two records sharing the hash, got %d", count)
	}
}

// A second user uploading the same content gets their own record: the record
// carries the uploader, and only the uploader may attach the file.
func TestDedupFileByHash_OtherUserGetsOwnRecord(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	first, err := s.store.SaveFile(ctx, "hash-abc", "image/png", 10, "a.png", "20060102/one", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, &FileUpload{
		Hash:         "hash-abc",
		MimeType:     "image/png",
		Size:         10,
		OriginalName: "a.png",
		Uploader:     "bob:local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !deduped {
		t.Fatal("expected deduped")
	}
	if check.File == nil || check.File.ID == first.ID {
		t.Fatalf("expected a separate record for the second uploader, got %+v", check.File)
	}
	if check.File.UploadedBy != "bob:local" {
		t.Fatalf("expected the record to belong to bob, got %q", check.File.UploadedBy)
	}
	if check.File.StoragePath != first.StoragePath {
		t.Fatalf("expected the physical file to be shared, got %q", check.File.StoragePath)
	}
}

// An encrypted upload holds a per-user ciphertext, so it must never be
// deduplicated against another user's file.
func TestDedupFileByHash_EncryptedNeverDeduped(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	if _, err := s.store.SaveFile(ctx, "hash-abc", "application/octet-stream", 10, "a.png", "20060102/one", "alice:local"); err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, &FileUpload{
		Hash:         "hash-abc",
		MimeType:     "application/octet-stream",
		Size:         10,
		OriginalName: "a.png",
		Uploader:     "bob:local",
		Encrypted:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if deduped {
		t.Fatal("expected NOT deduped for an encrypted upload")
	}
	if check.File != nil {
		t.Fatalf("expected nil file, got %+v", check.File)
	}
}

func TestDedupFileByHash_UnknownHash(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	check, deduped, err := s.DedupFileByHash(ctx, &FileUpload{
		Hash:         "never-seen",
		MimeType:     "image/png",
		Size:         5,
		OriginalName: "c.png",
		Uploader:     "alice:local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if deduped {
		t.Fatal("expected NOT deduped for unknown hash")
	}
	if check.File != nil {
		t.Fatalf("expected nil file, got %+v", check.File)
	}
}

// A file id that leaked from a chat must not become a way back into it: only
// the uploader may attach the file to a message.
func TestResolveMessageFiles_DropsFilesTheSenderDoesNotOwn(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	owned, err := s.store.SaveFile(ctx, "hash-1", "image/png", 10, "a.png", "20060102/one", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	foreign, err := s.store.SaveFile(ctx, "hash-2", "image/png", 10, "b.png", "20060102/two", "bob:local")
	if err != nil {
		t.Fatal(err)
	}

	got := s.ResolveMessageFiles(ctx, "alice:local", []string{owned.ID, foreign.ID, "missing"}, nil)
	if len(got) != 1 || got[0] != owned.ID {
		t.Fatalf("expected only the owned file, got %v", got)
	}
}

// A content hash is resolved inside the sender's own files: the server already
// holding the content must not hand it over to somebody else.
func TestResolveMessageFiles_HashIsScopedToTheOwner(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	if _, err := s.store.SaveFile(ctx, "hash-1", "image/png", 10, "a.png", "20060102/one", "bob:local"); err != nil {
		t.Fatal(err)
	}

	if got := s.ResolveMessageFiles(ctx, "alice:local", nil, []string{"hash-1"}); len(got) != 0 {
		t.Fatalf("expected the foreign hash to be dropped, got %v", got)
	}

	owned, err := s.store.SaveFile(ctx, "hash-2", "image/png", 10, "c.png", "20060102/three", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	got := s.ResolveMessageFiles(ctx, "alice:local", nil, []string{"hash-2"})
	if len(got) != 1 || got[0] != owned.ID {
		t.Fatalf("expected the owned hash to resolve, got %v", got)
	}
}

// The uploader keeps access to their own file; a file of another user stays
// unreachable.
func TestUserCanAccessFile_UploaderKeepsAccess(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	file, err := s.store.SaveFile(ctx, "hash-1", "image/png", 10, "a.png", "20060102/one", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	if !s.UserCanAccessFile(ctx, "alice:local", file.ID) {
		t.Fatal("expected the uploader to keep access")
	}

	if s.UserCanAccessFile(ctx, "bob:local", file.ID) {
		t.Fatal("expected another user to be refused")
	}
}

func countFiles(t *testing.T, s *Service, hash string) int {
	t.Helper()

	var n int64
	if err := s.store.DB().Model(&model.File{}).Where("hash = ?", hash).Count(&n).Error; err != nil {
		t.Fatal(err)
	}

	return int(n)
}
