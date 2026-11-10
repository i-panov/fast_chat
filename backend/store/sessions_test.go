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

// createTestUserWithoutSessions drops the legacy session CreateUser now writes,
// for tests that manage session rows themselves.
func createTestUserWithoutSessions(t *testing.T, s *Store, nick string) *model.User {
	t.Helper()

	user := createTestUser(t, s, nick)
	if err := s.DB().Where("user_id = ?", user.ID).Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

	return user
}

func TestCreateUserWithSessionReturnsWorkingToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	user, sess, token, err := s.CreateUserWithSession(ctx, "bob@test.local", "bob", "test", "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != "bob:test" {
		t.Fatalf("user ID = %s", user.ID)
	}
	if sess.UserID != user.ID || sess.DeviceID != "dev-1" {
		t.Fatalf("session = %+v", sess)
	}
	if _, gotUser, ok := s.GetSessionByToken(ctx, token); !ok || gotUser.ID != user.ID {
		t.Fatal("token must resolve to the new user")
	}
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
	user := createTestUserWithoutSessions(t, s, "alice")

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

func TestCreateSessionTwiceSameDeviceReplacesToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	second, secondToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != second.ID {
		t.Fatalf("same device must reuse the session row: %s != %s", first.ID, second.ID)
	}
	if firstToken == secondToken {
		t.Fatal("token must rotate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("old token must stop working")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("new token must work")
	}
}

func TestCreateSessionRevivesRevokedDevice(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}

	second, token, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("login on a logged-out device must reuse the row: %s != %s", first.ID, second.ID)
	}
	if second.RevokedAt != nil {
		t.Fatal("relogin must clear revoked_at")
	}
	if _, _, ok := s.GetSessionByToken(ctx, token); !ok {
		t.Fatal("token of the revived session must work")
	}
}

func TestCreateSessionForAnotherDeviceKeepsFirstSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	_, firstToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := s.GetSessionByToken(ctx, firstToken); !ok {
		t.Fatal("login on a second device must not invalidate the first session")
	}
}

func TestRevokeSessionOnlyRevokesOne(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, secondToken, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)

	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("revoked session must not authenticate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("other session must survive")
	}
}

func TestRefreshSessionRotatesOnlyOne(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, secondToken, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)

	_, newFirstToken, err := s.RefreshSession(ctx, first.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("old first token must be rotated")
	}
	if _, _, ok := s.GetSessionByToken(ctx, newFirstToken); !ok {
		t.Fatal("new first token must work")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("second session must survive")
	}
}

func TestListSessionsExcludesRevoked(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	first, _, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if _, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}

	sessions, err := s.ListSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].DeviceID != "dev-2" {
		t.Fatalf("sessions = %+v, want only dev-2", sessions)
	}
}

func TestGetSessionByIDKeepsRevokedSessionVisible(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	session, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeSession(ctx, user.ID, session.ID); err != nil {
		t.Fatal(err)
	}

	got, ok := s.GetSessionByID(ctx, session.ID)
	if !ok {
		t.Fatal("revoked session must still be found by id")
	}
	if got.RevokedAt == nil {
		t.Fatal("revoked session must carry revoked_at")
	}

	if _, ok := s.GetSessionByID(ctx, "missing"); ok {
		t.Fatal("unknown session must not be found")
	}
}

func TestRevokeAllSessionsRevokesEveryDevice(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	_, firstToken, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, secondToken, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)

	revoked, err := s.RevokeAllSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 2 {
		t.Fatalf("revoked = %d, want 2", revoked)
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("first session must be revoked")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); ok {
		t.Fatal("second session must be revoked")
	}

	revoked, err = s.RevokeAllSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 0 {
		t.Fatalf("second revoke = %d, want 0", revoked)
	}
}

func TestTrimSessionsRevokesOldestAndKeepsGivenSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	oldest, _, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	middle, _, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	newest, _, _ := s.CreateSession(ctx, user.ID, "dev-3", "Tablet", "ua", time.Hour)

	base := time.Now().UTC().Add(-time.Hour)
	for i, session := range []*model.Session{oldest, middle, newest} {
		if err := s.DB().Model(&model.Session{}).Where("id = ?", session.ID).
			Update("last_seen_at", base.Add(time.Duration(i)*time.Minute)).Error; err != nil {
			t.Fatal(err)
		}
	}

	revoked, err := s.TrimSessions(ctx, user.ID, 2, newest.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 1 || revoked[0] != oldest.ID {
		t.Fatalf("revoked = %v, want only %s", revoked, oldest.ID)
	}

	sessions, err := s.ListSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("active sessions = %d, want 2", len(sessions))
	}

	// keepID is never revoked even when it is the oldest active session, so
	// the next-oldest session pays the price instead.
	if _, err := s.TrimSessions(ctx, user.ID, 1, middle.ID); err != nil {
		t.Fatal(err)
	}
	if got, ok := s.GetSessionByID(ctx, middle.ID); !ok || got.RevokedAt != nil {
		t.Fatal("keepID session must survive trimming")
	}
	if got, ok := s.GetSessionByID(ctx, newest.ID); !ok || got.RevokedAt == nil {
		t.Fatal("trimming must revoke another session when keepID is skipped")
	}
}

func TestDeleteOldSessionsRemovesOnlyStaleRows(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	longAgo := time.Now().UTC().Add(-48 * time.Hour)
	cutoff := time.Now().UTC().Add(-24 * time.Hour)

	stale := []model.Session{
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "expired-long-ago",
			TokenHash:  hashToken("expired-long-ago"),
			CreatedAt:  longAgo,
			LastSeenAt: longAgo,
			ExpiresAt:  longAgo.Add(time.Hour),
		},
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "revoked-long-ago",
			TokenHash:  hashToken("revoked-long-ago"),
			CreatedAt:  longAgo,
			LastSeenAt: longAgo,
			ExpiresAt:  longAgo.Add(time.Hour),
			RevokedAt:  &longAgo,
		},
	}
	fresh := []model.Session{
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "active",
			TokenHash:  hashToken("active"),
			CreatedAt:  cutoff,
			LastSeenAt: cutoff,
			ExpiresAt:  cutoff.Add(24 * time.Hour),
		},
		{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "revoked-recently",
			TokenHash:  hashToken("revoked-recently"),
			CreatedAt:  cutoff,
			LastSeenAt: cutoff,
			ExpiresAt:  cutoff.Add(24 * time.Hour),
			RevokedAt:  &cutoff,
		},
	}

	rows := make([]model.Session, 0, len(stale)+len(fresh))
	rows = append(rows, stale...)
	rows = append(rows, fresh...)
	for i := range rows {
		if err := s.DB().Create(&rows[i]).Error; err != nil {
			t.Fatal(err)
		}
	}

	deleted, err := s.DeleteOldSessions(ctx, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("deleted = %d, want 2", deleted)
	}

	var count int64
	if err := s.DB().Model(&model.Session{}).Where("user_id = ?", user.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("remaining sessions = %d, want 2", count)
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
