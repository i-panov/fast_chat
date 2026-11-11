package store

import (
	"context"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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
