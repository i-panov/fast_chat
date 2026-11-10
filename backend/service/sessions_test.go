package service

import (
	"context"
	"testing"
	"time"
)

// loginDevice stores a fresh code and verifies it for one device. The code
// store deletes the code on success, so every login needs a new one.
func loginDevice(t *testing.T, s *Service, email, deviceID string) *VerifyCodeResult {
	t.Helper()

	s.store.Codes().StoreCode(email, "123456", time.Minute)

	res, err := s.VerifyCode(context.Background(), email, "123456", DeviceInfo{ID: deviceID, Name: deviceID})
	if err != nil {
		t.Fatal(err)
	}

	if res.Session == nil || res.Token == "" {
		t.Fatalf("login %s returned no session: %+v", deviceID, res)
	}

	return res
}

func TestVerifyCodeSecondDeviceKeepsFirstSession(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	first := loginDevice(t, s, user.Email, "dev-1")
	second := loginDevice(t, s, user.Email, "dev-2")

	if first.Token == second.Token {
		t.Fatal("tokens must differ")
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, first.Token); !ok {
		t.Fatal("first session must survive the second login")
	}
}

func TestListSessionsReturnsEveryDevice(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	loginDevice(t, s, user.Email, "dev-1")
	loginDevice(t, s, user.Email, "dev-2")

	sessions, err := s.ListSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}

	if len(sessions) != 3 { // the legacy session of CreateUser plus two devices.
		t.Fatalf("sessions = %d, want 3", len(sessions))
	}
}

func TestRefreshSessionRotatesOnlyOneDevice(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	first := loginDevice(t, s, user.Email, "dev-1")
	second := loginDevice(t, s, user.Email, "dev-2")

	refreshed, token, err := s.RefreshSession(ctx, first.Session.ID)
	if err != nil {
		t.Fatal(err)
	}

	if refreshed.ID != first.Session.ID {
		t.Fatalf("refreshed session = %q, want %q", refreshed.ID, first.Session.ID)
	}

	if token == first.Token || token == second.Token {
		t.Fatal("refresh must issue a new token")
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, first.Token); ok {
		t.Error("the old token of the refreshed device must stop working")
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, token); !ok {
		t.Error("the refreshed token must work")
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, second.Token); !ok {
		t.Error("refresh must not touch the other device")
	}
}

func TestLogoutRevokesOnlyOneDevice(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	first := loginDevice(t, s, user.Email, "dev-1")
	second := loginDevice(t, s, user.Email, "dev-2")

	if err := s.Logout(ctx, first.Session.ID, user.ID); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, first.Token); ok {
		t.Error("the logged-out device must stop working")
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, second.Token); !ok {
		t.Error("logout must not touch the other device")
	}
}

func TestLogoutAllRevokesEveryDevice(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	first := loginDevice(t, s, user.Email, "dev-1")
	second := loginDevice(t, s, user.Email, "dev-2")

	if err := s.LogoutAll(ctx, user.ID); err != nil {
		t.Fatal(err)
	}

	for _, token := range []string{user.Token, first.Token, second.Token} {
		if _, _, ok := s.store.GetSessionByToken(ctx, token); ok {
			t.Errorf("token %q must be revoked by logout-all", token)
		}
	}
}

func TestTrimSessionsRevokesOldestDevice(t *testing.T) {
	s := newTestService(t)
	s.cfg.Auth.MaxSessionsPerUser = 2
	ctx := context.Background()

	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	first := loginDevice(t, s, user.Email, "dev-1")
	second := loginDevice(t, s, user.Email, "dev-2") // third session: trims the oldest.

	if _, _, ok := s.store.GetSessionByToken(ctx, user.Token); ok {
		t.Error("the oldest session must be trimmed above the cap")
	}

	for _, token := range []string{first.Token, second.Token} {
		if _, _, ok := s.store.GetSessionByToken(ctx, token); !ok {
			t.Errorf("token %q must survive the trim", token)
		}
	}
}

func TestCompleteRegistrationCreatesSession(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	s.store.Codes().StoreCode("alice@test.local", "123456", time.Minute)

	verified, err := s.VerifyCode(ctx, "alice@test.local", "123456", DeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}

	if !verified.IsNew || verified.SetupToken == "" {
		t.Fatalf("expected a setup token, got %+v", verified)
	}

	res, err := s.CompleteRegistration(ctx, verified.SetupToken, "alice", DeviceInfo{ID: "dev-1", Name: "Chrome"})
	if err != nil {
		t.Fatal(err)
	}

	if res.User == nil || res.Session == nil || res.Token == "" {
		t.Fatalf("registration result = %+v", res)
	}

	if res.Session.DeviceID != "dev-1" {
		t.Errorf("deviceID = %q, want dev-1", res.Session.DeviceID)
	}

	if _, _, ok := s.store.GetSessionByToken(ctx, res.Token); !ok {
		t.Error("the registration token must authenticate")
	}
}
