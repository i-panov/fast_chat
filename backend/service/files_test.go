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

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &store.ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}, &model.PushSubscription{}, &model.MessageReadStatus{}); err != nil {
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
		{"", true},
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

	stored, err := s.store.SaveFile(ctx, "hash-abc", "image/png", 10, "a.png", "20060102/one")
	if err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, "hash-abc", "image/png", 10, "a.png")
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

	if _, err := s.store.SaveFile(ctx, "hash-abc", "image/png", 10, "a.png", "20060102/one"); err != nil {
		t.Fatal(err)
	}

	check, deduped, err := s.DedupFileByHash(ctx, "hash-abc", "image/png", 10, "b.png")
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

func TestDedupFileByHash_UnknownHash(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	check, deduped, err := s.DedupFileByHash(ctx, "never-seen", "image/png", 5, "c.png")
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

func countFiles(t *testing.T, s *Service, hash string) int {
	t.Helper()

	var n int64
	if err := s.store.DB().Model(&model.File{}).Where("hash = ?", hash).Count(&n).Error; err != nil {
		t.Fatal(err)
	}

	return int(n)
}
