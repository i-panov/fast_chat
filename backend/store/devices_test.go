package store

import (
	"context"
	"testing"
)

func TestUserDevices(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if err := s.UpsertUserDevice(ctx, "alice:test", "dev-1", "pk-1", 2); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUserDevice(ctx, "alice:test", "dev-1", "pk-2", 2); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUserDevice(ctx, "alice:test", "dev-2", "pk-3", 2); err != nil {
		t.Fatal(err)
	}

	devices, err := s.ListUserDevices(ctx, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 {
		t.Fatalf("devices = %d, want 2", len(devices))
	}
	if devices[0].PublicKey != "pk-2" {
		t.Fatalf("dev-1 key = %q", devices[0].PublicKey)
	}

	if err := s.RevokeUserDevice(ctx, "alice:test", "dev-1"); err != nil {
		t.Fatal(err)
	}
	devices, err = s.ListUserDevices(ctx, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "dev-2" {
		t.Fatalf("after revoke = %+v", devices)
	}

	// Re-registering the same device on the next page load must not revive a
	// key the user revoked.
	if err := s.UpsertUserDevice(ctx, "alice:test", "dev-1", "pk-4", 2); err != nil {
		t.Fatal(err)
	}
	devices, err = s.ListUserDevices(ctx, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "dev-2" {
		t.Fatalf("revoked key revived by upsert: %+v", devices)
	}
}

func TestDeviceKeyFollowsSessionRevocation(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")
	session, _, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("session missing")
	}
	if err := s.UpsertUserDevice(ctx, user.ID, session.ID, "pk", 2); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeSession(ctx, user.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	devices, err := s.ListUserDevices(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("device key survived session revocation: %+v", devices)
	}
}
