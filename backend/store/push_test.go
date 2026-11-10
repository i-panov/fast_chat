package store

import (
	"context"
	"testing"
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
