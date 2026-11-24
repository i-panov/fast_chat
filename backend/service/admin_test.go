package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"fast_chat/model"
)

func newAdminUser(t *testing.T, s *Service, username string) (*model.User, string) {
	t.Helper()

	user, _, token, err := s.store.CreateUserWithSession(
		context.Background(), username+"@example.test", username, username,
		"localhost:8080", "device-"+username, "Laptop", "", time.Hour,
	)
	if err != nil {
		t.Fatal(err)
	}

	return user, token
}

func TestAdminEndpointsRequireTheRole(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")

	if _, err := s.AdminListUsers(ctx, alice.ID, "", 0, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("err = %v, want ErrAdminRequired", err)
	}
	if _, err := s.AdminListAudit(ctx, alice.ID, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("audit err = %v, want ErrAdminRequired", err)
	}
}

func TestAdminGrantBanAndAudit(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")
	bob, bobToken := newAdminUser(t, s, "bob")

	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	page, err := s.AdminListUsers(ctx, alice.ID, "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 {
		t.Fatalf("total = %d, want 2", page.Total)
	}

	if err := s.AdminSetUserAdmin(ctx, alice.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}
	bobUser, err := s.store.AdminGetUser(ctx, bob.ID)
	if err != nil || !bobUser.IsAdmin {
		t.Fatalf("bob admin = %+v err=%v", bobUser, err)
	}

	// An administrator cannot drop their own role: a mis-click would lock
	// them out of the screen they are using.
	if err := s.AdminSetUserAdmin(ctx, alice.ID, alice.ID, false); !errors.Is(err, ErrAdminSelfAction) {
		t.Fatalf("self-demote err = %v, want ErrAdminSelfAction", err)
	}

	if err := s.AdminSetUserBanned(ctx, alice.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.store.GetSessionByToken(ctx, bobToken); ok {
		t.Fatal("a banned account kept its session")
	}

	entries, err := s.AdminListAudit(ctx, alice.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	actions := make(map[string]bool, len(entries))
	for _, entry := range entries {
		actions[entry.Action] = true
	}
	for _, want := range []string{"user.admin", "user.ban"} {
		if !actions[want] {
			t.Errorf("audit actions = %v, missing %s", actions, want)
		}
	}

	// A banned account cannot use the moderation API either.
	if _, err := s.AdminListUsers(ctx, bob.ID, "", 0, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("banned admin err = %v, want ErrAdminRequired", err)
	}
}

func TestAdminDeletesAnotherUsersMessage(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")
	bob, _ := newAdminUser(t, s, "bob")
	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice.ID, bob.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	msg, _, err := s.store.AddMessage(ctx, chat.ID, "", bob.ID, "bob", "moderate me", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.AdminDeleteMessage(ctx, bob.ID, chat.ID, msg.ID); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("non-admin delete err = %v, want ErrAdminRequired", err)
	}

	if err := s.AdminDeleteMessage(ctx, alice.ID, chat.ID, msg.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.GetMessage(ctx, chat.ID, msg.ID); err == nil {
		t.Fatal("message survived the moderation delete")
	}
}

func TestRegistrationDoesNotGrantAConfiguredAdmin(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	s.cfg.Server.Admins = []string{"alice@example.test"}
	setup := s.store.Codes().CreateSetupToken("alice@example.test", time.Minute)

	res, err := s.CompleteRegistration(ctx, setup, "alice", "", DeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}
	if res.User.IsAdmin {
		t.Fatal("registration granted the administrator role by username")
	}
}

func TestAdminBootstrapFromConfiguration(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")

	s.cfg.Server.Admins = []string{"alice@example.test", "missing@example.test"}

	if err := s.SyncConfiguredAdmins(ctx); err != nil {
		t.Fatal(err)
	}
	user, err := s.store.AdminGetUser(ctx, alice.ID)
	if err != nil || !user.IsAdmin {
		t.Fatalf("alice admin = %+v err=%v", user, err)
	}
}

func TestBannedAccountCannotLogInAgain(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")

	// The ban also revokes the existing sessions; the point of this test is
	// the fresh login attempt with a valid code.
	if err := s.store.AdminSetUserBanned(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	s.store.Codes().StoreCode("alice@example.test", "123456", time.Minute)

	_, err := s.VerifyCode(ctx, "alice@example.test", "123456", DeviceInfo{})
	if !errors.Is(err, ErrUserBanned) {
		t.Fatalf("err = %v, want ErrUserBanned", err)
	}
}

func TestAdminDeletesPrivateAndSelfChats(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")
	bob, _ := newAdminUser(t, s, "bob")
	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	privateChat, err := s.store.CreateChat(ctx, alice.ID, bob.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	selfChat, err := s.store.EnsureSelfChat(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}

	// Owner-facing deletion is group-only; moderation must remove these.
	if err := s.AdminDeleteChat(ctx, alice.ID, privateChat.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.store.GetChat(ctx, privateChat.ID); ok {
		t.Fatal("private chat survived the moderation delete")
	}
	if err := s.AdminDeleteChat(ctx, alice.ID, selfChat.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.store.GetChat(ctx, selfChat.ID); ok {
		t.Fatal("self chat survived the moderation delete")
	}

	if err := s.AdminDeleteChat(ctx, bob.ID, privateChat.ID); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("non-admin delete err = %v, want ErrAdminRequired", err)
	}
}

func TestBanDisablesOwnedBots(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, _ := newAdminUser(t, s, "alice")
	bob, _ := newAdminUser(t, s, "bob")
	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	created, err := s.CreateBot(ctx, bob.ID, "bob_bot", "Bob Bot")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AdminSetUserBanned(ctx, alice.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}

	bot, ok := s.store.GetBot(ctx, created.User.ID)
	if !ok || bot.IsActive {
		t.Fatalf("bot after ban = %+v ok=%v, want inactive", bot, ok)
	}
}
