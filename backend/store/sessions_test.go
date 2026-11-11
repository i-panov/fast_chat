package store

import (
	"context"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

func TestBackfillSessionsSkipsUserWithExistingSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	// A real device session whose token differs from users.token models a
	// database written before session writes mirrored the legacy columns.
	_, token, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	staleToken := "stale-users-token"
	if err := s.DB().Model(&model.User{}).Where("id = ?", user.ID).
		Updates(map[string]any{
			"token":            hashToken(staleToken),
			"token_expires_at": time.Now().Add(time.Hour).UTC(),
		}).Error; err != nil {
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
		t.Fatalf("session count = %d, want the existing device session only", count)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, token)
	if !ok {
		t.Fatal("token of the existing session must keep working")
	}
	if gotUser.ID != user.ID {
		t.Fatalf("user = %s, want %s", gotUser.ID, user.ID)
	}
	if sess.DeviceID != "dev-1" {
		t.Fatalf("deviceID = %q, want dev-1", sess.DeviceID)
	}

	if _, _, ok := s.GetSessionByToken(ctx, staleToken); ok {
		t.Fatal("users.token must not authenticate once the user has a session")
	}
}

// Once a user has any session row, users.token is ignored: a rotated value
// written by an older build must not overwrite the authoritative session.
func TestBackfillSessionsDoesNotOverrideSessionWithUserToken(t *testing.T) {
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
	if sessions[0].TokenHash != hashToken(user.Token) {
		t.Fatal("backfill must not overwrite the session token from users.token")
	}

	if _, _, ok := s.GetSessionByToken(ctx, user.Token); !ok {
		t.Fatal("the session token must keep working")
	}
	if _, _, ok := s.GetSessionByToken(ctx, rotatedToken); ok {
		t.Fatal("users.token must not authenticate once the user has a session")
	}
}

// After a session refresh the legacy columns mirror the new hash, so a
// backfill neither creates a second legacy row nor restores the old token.
func TestBackfillSessionsKeepsRefreshedSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	legacy, _, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy session missing")
	}

	_, refreshedToken, err := s.RefreshSession(ctx, legacy.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	stored, ok := s.GetUserByID(ctx, user.ID)
	if !ok || stored.Token != hashToken(refreshedToken) {
		t.Fatal("RefreshSession must mirror the new token into users.token")
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

	if _, _, ok := s.GetSessionByToken(ctx, refreshedToken); !ok {
		t.Fatal("the refreshed token must survive the restart")
	}
	if _, _, ok := s.GetSessionByToken(ctx, user.Token); ok {
		t.Fatal("the old token must stay revoked after a restart")
	}
}

func TestBackfillSessionsDoesNotResurrectRevokedSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	legacy, _, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy session missing")
	}
	if err := s.RevokeSession(ctx, user.ID, legacy.ID); err != nil {
		t.Fatal(err)
	}

	stored, ok := s.GetUserByID(ctx, user.ID)
	if !ok {
		t.Fatal("user missing")
	}
	if stored.Token == hashToken(user.Token) {
		t.Fatal("RevokeSession must clear the legacy token")
	}

	// Model a database written by an older build: users.token still carries
	// the revoked token with a future expiry.
	if err := s.DB().Model(&model.User{}).Where("id = ?", user.ID).
		Updates(map[string]any{
			"token":            hashToken(user.Token),
			"token_expires_at": time.Now().Add(time.Hour).UTC(),
		}).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := s.GetSessionByToken(ctx, user.Token); ok {
		t.Fatal("backfill must not resurrect a revoked session from users.token")
	}

	var count int64
	if err := s.DB().Model(&model.Session{}).Where("user_id = ?", user.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("session count = %d, want the revoked row only", count)
	}

	got, ok := s.GetSessionByID(ctx, legacy.ID)
	if !ok || got.RevokedAt == nil {
		t.Fatal("backfill must leave the revoked session revoked")
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

	// newTestDBForMigration creates the user's legacy session through
	// CreateUser. Drop it so these calls exercise the real migration path:
	// the first backfill creates the row, the second one skips it because the
	// user already has a session.
	if err := db.Where("1 = 1").Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

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

func TestCreateSessionTruncatesFieldsOnRuneBoundary(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	// 40 two-byte runes = 80 bytes: a naive 64-byte cut would split rune 32.
	name := strings.Repeat("\u044f", 40)
	agent := strings.Repeat("\u044f", 300) // 600 bytes.

	session, _, err := s.CreateSession(ctx, user.ID, "dev-1", name, agent, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if len(session.DeviceName) > 64 || !utf8.ValidString(session.DeviceName) {
		t.Fatalf("device name %q is longer than 64 bytes or invalid UTF-8", session.DeviceName)
	}
	if len(session.UserAgent) > 512 || !utf8.ValidString(session.UserAgent) {
		t.Fatalf("user agent is longer than 512 bytes or invalid UTF-8 (len=%d)", len(session.UserAgent))
	}
}

// Every login must leave users.token describing the newest session: the
// backfill reads those legacy columns, so a stale mirror can resurrect an old
// token after a restart.
func TestCreateSessionMirrorsLegacyToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	assertMirror := func(session *model.Session, token string) {
		t.Helper()

		stored, ok := s.GetUserByID(ctx, user.ID)
		if !ok {
			t.Fatal("user missing")
		}
		if stored.Token != hashToken(token) {
			t.Errorf("users.token = %q, want the hash of the new session token", stored.Token)
		}
		if !stored.TokenExpiresAt.Equal(session.ExpiresAt) {
			t.Errorf("users.token_expires_at = %v, want %v", stored.TokenExpiresAt, session.ExpiresAt)
		}
		if !stored.TokenExpiresAt.After(time.Now()) {
			t.Errorf("users.token_expires_at = %v, want a future instant", stored.TokenExpiresAt)
		}
	}

	created, token, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	assertMirror(created, token)

	replaced, replacedToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.ID != created.ID {
		t.Fatalf("re-login must reuse the session row: %s != %s", replaced.ID, created.ID)
	}
	assertMirror(replaced, replacedToken)
}

func TestTouchSessionAdvancesStaleTimestampOnly(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	session, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	stale := time.Now().UTC().Add(-time.Hour)
	if err := s.DB().Model(&model.Session{}).Where("id = ?", session.ID).
		Update("last_seen_at", stale).Error; err != nil {
		t.Fatal(err)
	}

	touchAt := time.Now().UTC()
	if err := s.TouchSession(ctx, session.ID, touchAt); err != nil {
		t.Fatal(err)
	}

	got, ok := s.GetSessionByID(ctx, session.ID)
	if !ok {
		t.Fatal("session missing")
	}
	if !got.LastSeenAt.Equal(touchAt) {
		t.Fatalf("last_seen_at = %v, want %v", got.LastSeenAt, touchAt)
	}

	// A fresh timestamp is inside the throttle window: the second touch must
	// not rewrite the row.
	next := touchAt.Add(time.Minute)
	if err := s.TouchSession(ctx, session.ID, next); err != nil {
		t.Fatal(err)
	}
	got, ok = s.GetSessionByID(ctx, session.ID)
	if !ok {
		t.Fatal("session missing")
	}
	if !got.LastSeenAt.Equal(touchAt) {
		t.Fatalf("fresh last_seen_at was rewritten: %v, want %v", got.LastSeenAt, touchAt)
	}

	// Once the window has passed the timestamp advances again.
	later := touchAt.Add(sessionTouchInterval + time.Minute)
	if err := s.TouchSession(ctx, session.ID, later); err != nil {
		t.Fatal(err)
	}
	got, ok = s.GetSessionByID(ctx, session.ID)
	if !ok {
		t.Fatal("session missing")
	}
	if !got.LastSeenAt.Equal(later) {
		t.Fatalf("last_seen_at = %v, want %v after the throttle window", got.LastSeenAt, later)
	}
}

func TestGetSessionsByIDs(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.GetSessionsByIDs(ctx, []string{first.ID, second.ID, "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[first.ID].DeviceID != "dev-1" || got[second.ID].DeviceID != "dev-2" {
		t.Fatalf("sessions = %+v", got)
	}
}

func TestDeleteOldSessionsBatches(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	now := time.Now().UTC()
	sessions := make([]model.Session, 0, 501)
	for range 501 {
		sessions = append(sessions, model.Session{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "old-" + GenerateID(),
			DeviceName: "old",
			TokenHash:  hashToken(GenerateID()),
			CreatedAt:  now.Add(-2 * time.Hour),
			LastSeenAt: now.Add(-2 * time.Hour),
			ExpiresAt:  now.Add(-time.Hour),
		})
	}
	if err := s.DB().CreateInBatches(&sessions, 100).Error; err != nil {
		t.Fatal(err)
	}

	deleted, err := s.DeleteOldSessions(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 501 {
		t.Fatalf("deleted = %d, want 501", deleted)
	}
}

func TestRevokeSessionDeletesLegacyPushRows(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")
	session, _, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy session missing")
	}
	if _, err := s.AddPushSubscriptionForSession(ctx, user.ID, "", "https://fcm.googleapis.com/fcm/send/legacy", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.RevokeSession(ctx, user.ID, session.ID); err != nil {
		t.Fatal(err)
	}

	var count int64
	if err := s.DB().Model(&model.PushSubscription{}).Where("user_id = ?", user.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("push subscriptions = %d, want 0", count)
	}
}

func TestCreateUserZeroTTLUsesDefault(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	user, err := s.CreateUser(ctx, "zero@test.local", "zero", "test", 0)
	if err != nil {
		t.Fatal(err)
	}

	session, _, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("token must resolve to a session")
	}
	if !session.ExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("session expiry = %v, want a future time", session.ExpiresAt)
	}
}
