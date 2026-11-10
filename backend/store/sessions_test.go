package store

import (
	"context"
	"testing"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

func newSessionTestStore(t *testing.T) *Store {
	t.Helper()
	s := newTestStore(t)
	if err := s.DB().AutoMigrate(&model.Session{}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestBackfillSessionsFromUserToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	user, err := s.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Эмулируем базу до миграции: сессии нет, токен лежит в users.
	if err := s.DB().Where("1 = 1").Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy token must resolve through the backfilled session")
	}
	if gotUser.ID != user.ID {
		t.Fatalf("user = %s, want %s", gotUser.ID, user.ID)
	}
	if sess.DeviceID != "legacy" {
		t.Fatalf("deviceID = %q, want legacy", sess.DeviceID)
	}
}

// A token issued before CreateUser switched to UTC carries the host's local
// offset in users.token_expires_at. The backfilled session must store the
// instant in UTC: GetSessionByToken compares expires_at in SQL, and SQLite
// compares the stored text, so an offset west of UTC would sort below the UTC
// bound and reject a token that is still valid.
func TestBackfillSessionsNormalizesExpiryToUTC(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	const token = "legacy-token"
	expiry := time.Now().Add(time.Hour).In(time.FixedZone("west", -12*3600))

	user := &model.User{
		ID:             "old:test",
		Email:          "old@test.local",
		Nick:           "old",
		Token:          hashToken(token),
		TokenExpiresAt: expiry,
	}
	if err := s.DB().Create(user).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, token)
	if !ok {
		t.Fatalf("valid legacy token rejected, expiry %v", expiry)
	}
	if gotUser.ID != user.ID {
		t.Fatalf("user = %s, want %s", gotUser.ID, user.ID)
	}
	if !sess.ExpiresAt.Equal(expiry) {
		t.Fatalf("expiresAt = %v, want %v", sess.ExpiresAt, expiry)
	}
}

func TestBackfillSessionsIsIdempotent(t *testing.T) {
	db := newTestDBForMigration(t)
	if err := backfillSessions(db); err != nil {
		t.Fatal(err)
	}
	if err := backfillSessions(db); err != nil {
		t.Fatal(err)
	}

	var count int64
	if err := db.Model(&model.Session{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("session count = %d, want 1", count)
	}
}

func newTestDBForMigration(t *testing.T) *gorm.DB {
	t.Helper()
	s := newTestStore(t)
	if err := s.DB().AutoMigrate(&model.Session{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(context.Background(), "m@test.local", "m", "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	return s.DB()
}
