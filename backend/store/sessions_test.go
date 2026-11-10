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
	return newTestStore(t)
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

func TestBackfillSessionsSkipsExistingTokenHash(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	now := time.Now().UTC()
	deviceSession := &model.Session{
		ID:         GenerateID(),
		UserID:     user.ID,
		DeviceID:   "dev-1",
		DeviceName: "Chrome",
		TokenHash:  hashToken(user.Token),
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(time.Hour),
	}
	if err := s.DB().Create(deviceSession).Error; err != nil {
		t.Fatal(err)
	}

	// No legacy row for this user: the only session is the real device one.
	if err := s.DB().Where("user_id = ? AND device_id = ?", user.ID, "legacy").Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	var count int64
	if err := s.DB().Model(&model.Session{}).Where("user_id = ?", user.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("session count = %d, want 1", count)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("token of the existing session must keep working")
	}
	if gotUser.ID != user.ID {
		t.Fatalf("user = %s, want %s", gotUser.ID, user.ID)
	}
	if sess.DeviceID != "dev-1" {
		t.Fatalf("deviceID = %q, want dev-1", sess.DeviceID)
	}
}

func TestBackfillSessionsReconcilesRotatedToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	const rotatedToken = "rotated-token"
	newExpiry := time.Now().Add(2 * time.Hour).UTC()
	if err := s.DB().Model(&model.User{}).Where("id = ?", user.ID).
		Updates(map[string]any{
			"token":            hashToken(rotatedToken),
			"token_expires_at": newExpiry,
		}).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	var sessions []model.Session
	if err := s.DB().Where("user_id = ?", user.ID).Find(&sessions).Error; err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("session count = %d, want 1", len(sessions))
	}
	if sessions[0].DeviceID != "legacy" {
		t.Fatalf("deviceID = %q, want legacy", sessions[0].DeviceID)
	}
	if sessions[0].TokenHash != hashToken(rotatedToken) {
		t.Fatal("legacy session must carry the rotated token hash")
	}
	if !sessions[0].ExpiresAt.Equal(newExpiry) {
		t.Fatalf("expiresAt = %v, want %v", sessions[0].ExpiresAt, newExpiry)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, rotatedToken)
	if !ok {
		t.Fatal("rotated token must resolve through the reconciled legacy session")
	}
	if gotUser.ID != user.ID || sess.ID != sessions[0].ID {
		t.Fatalf("resolved user/session = %s/%s, want %s/%s", gotUser.ID, sess.ID, user.ID, sessions[0].ID)
	}
	if _, _, ok := s.GetSessionByToken(ctx, user.Token); ok {
		t.Fatal("old token must stop working after reconciliation")
	}
}

func TestGetSessionByTokenRejectsExpiredAndRevoked(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	now := time.Now().UTC()
	revokedAt := now.Add(-time.Minute)
	sessions := []model.Session{
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "expired",
			TokenHash:  hashToken("expired-token"),
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  now.Add(-time.Minute),
		},
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "revoked",
			TokenHash:  hashToken("revoked-token"),
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  now.Add(time.Hour),
			RevokedAt:  &revokedAt,
		},
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "active",
			TokenHash:  hashToken("active-token"),
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  now.Add(time.Hour),
		},
	}
	for i := range sessions {
		if err := s.DB().Create(&sessions[i]).Error; err != nil {
			t.Fatal(err)
		}
	}

	if _, _, ok := s.GetSessionByToken(ctx, "expired-token"); ok {
		t.Fatal("expired session must not authenticate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, "revoked-token"); ok {
		t.Fatal("revoked session must not authenticate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, "active-token"); !ok {
		t.Fatal("active session must authenticate")
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
	if _, err := s.CreateUser(context.Background(), "m@test.local", "m", "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	return s.DB()
}
