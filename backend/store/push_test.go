package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

func TestPushSubscriptionSessionUpsert(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	sub, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s1", "https://fcm.googleapis.com/fcm/send/one", "p256dh-1", "auth-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sub.SessionID != "s1" {
		t.Fatalf("session = %q, want s1", sub.SessionID)
	}

	// The same endpoint re-subscribing from another session moves the row
	// instead of growing the table: the endpoint stays unique.
	moved, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s2", "https://fcm.googleapis.com/fcm/send/one", "p256dh-2", "auth-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if moved.ID != sub.ID {
		t.Errorf("id = %q, want the original %q", moved.ID, sub.ID)
	}
	if moved.SessionID != "s2" {
		t.Errorf("session = %q, want s2", moved.SessionID)
	}
	if moved.P256DH != "p256dh-2" || moved.Auth != "auth-2" {
		t.Errorf("keys = %q/%q, want the refreshed ones", moved.P256DH, moved.Auth)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("subscriptions = %d, want 1", len(subs))
	}
}

func TestDeletePushSubscriptionsBySession(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s1", "https://fcm.googleapis.com/fcm/send/one", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s2", "https://fcm.googleapis.com/fcm/send/two", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.DeletePushSubscriptionsBySession(ctx, "s1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(subs) != 1 || subs[0].SessionID != "s2" {
		t.Fatalf("subscriptions = %+v, want only s2", subs)
	}
}

func TestDeletePushSubscriptionForSession(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	const (
		ownEndpoint     = "https://fcm.googleapis.com/fcm/send/own"
		otherEndpoint   = "https://fcm.googleapis.com/fcm/send/other"
		legacyEndpoint  = "https://fcm.googleapis.com/fcm/send/legacy"
		otherSessionID  = "s2"
		requestSession  = "s1"
		legacySessionID = ""
	)

	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, requestSession, ownEndpoint, "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, otherSessionID, otherEndpoint, "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}
	// A subscription written before sessions existed carries no session id.
	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, legacySessionID, legacyEndpoint, "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.DeletePushSubscriptionForSession(ctx, testAlice, requestSession, ownEndpoint); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 2 {
		t.Fatalf("subscriptions = %+v, want the other device and the legacy row", subs)
	}

	// One device must not delete another device's subscription.
	if err := s.DeletePushSubscriptionForSession(ctx, testAlice, requestSession, otherEndpoint); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	subs, err = s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 2 {
		t.Fatalf("subscriptions = %+v, want the other device untouched", subs)
	}

	// The legacy fallback removes the sessionless row of the same endpoint.
	if err := s.DeletePushSubscriptionForSession(ctx, testAlice, requestSession, legacyEndpoint); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	subs, err = s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].SessionID != otherSessionID {
		t.Fatalf("subscriptions = %+v, want only the other device", subs)
	}
}

func TestDeleteAllPushSubscriptions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s1", "https://fcm.googleapis.com/fcm/send/one", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, "s2", "https://fcm.googleapis.com/fcm/send/two", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPushSubscriptionForSession(ctx, testBob, "s3", "https://fcm.googleapis.com/fcm/send/three", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteAllPushSubscriptions(ctx, testAlice); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if subs, err := s.GetPushSubscriptionsByUser(ctx, testAlice); err != nil {
		t.Fatalf("unexpected error: %v", err)
	} else if len(subs) != 0 {
		t.Fatalf("alice subscriptions = %+v, want none", subs)
	}

	// A logout everywhere of alice must not touch bob.
	if subs, err := s.GetPushSubscriptionsByUser(ctx, testBob); err != nil {
		t.Fatalf("unexpected error: %v", err)
	} else if len(subs) != 1 {
		t.Fatalf("bob subscriptions = %d, want 1", len(subs))
	}
}

func TestRevokeSessionDeletesItsPushSubscriptions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	first, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	for _, session := range []*model.Session{first, second} {
		if _, err := s.AddPushSubscriptionForSession(
			ctx, user.ID, session.ID,
			"https://fcm.googleapis.com/fcm/send/"+session.DeviceID, "p256dh", "auth",
		); err != nil {
			t.Fatal(err)
		}
	}

	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].SessionID != second.ID {
		t.Fatalf("subscriptions = %+v, want only the other session's", subs)
	}
}

func TestRevokeAllSessionsDeletesAllPushSubscriptions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	first, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	for _, session := range []*model.Session{first, second} {
		if _, err := s.AddPushSubscriptionForSession(
			ctx, user.ID, session.ID,
			"https://fcm.googleapis.com/fcm/send/"+session.DeviceID, "p256dh", "auth",
		); err != nil {
			t.Fatal(err)
		}
	}
	// Logout-all must also drop legacy rows that carry no session id.
	if _, err := s.AddPushSubscriptionForSession(ctx, user.ID, "", "https://fcm.googleapis.com/fcm/send/legacy", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	revoked, err := s.RevokeAllSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 2 {
		t.Fatalf("revoked = %d, want 2", revoked)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 0 {
		t.Fatalf("subscriptions = %+v, want none after logout-all", subs)
	}
}

func TestDeleteOldSessionsDeletesPushSubscriptions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user := createTestUserWithoutSessions(t, s, "alice")

	session, _, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPushSubscriptionForSession(
		ctx, user.ID, session.ID, "https://fcm.googleapis.com/fcm/send/one", "p256dh", "auth",
	); err != nil {
		t.Fatal(err)
	}

	old := time.Now().UTC().Add(-48 * time.Hour)
	if err := s.DB().Model(&model.Session{}).Where("id = ?", session.ID).
		Update("expires_at", old).Error; err != nil {
		t.Fatal(err)
	}

	deleted, err := s.DeleteOldSessions(ctx, time.Now().UTC().Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 0 {
		t.Fatalf("subscriptions = %+v, want none for the deleted session", subs)
	}
}

func TestDeletePushSubscriptionsBySessionEmptyIsNoop(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if _, err := s.AddPushSubscriptionForSession(ctx, testAlice, "", "https://fcm.googleapis.com/fcm/send/legacy", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.DeletePushSubscriptionsBySession(ctx, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	subs, err := s.GetPushSubscriptionsByUser(ctx, testAlice)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subscriptions = %+v, want the legacy row untouched", subs)
	}
}
