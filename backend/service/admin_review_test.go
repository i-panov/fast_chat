package service

import (
	"context"
	"sync"
	"testing"
	"time"

	"fast_chat/model"
)

// The audit log records where a moderation action came from: a stolen
// administrator session is attributable to a device, not only to the account.
func TestAdminAuditRecordsTheRequestMetadata(t *testing.T) {
	s := newTestService(t)
	ctx := WithAuditRequest(context.Background(), AuditRequest{
		IP:        "203.0.113.7",
		UserAgent: "Mozilla/5.0 test",
	})

	alice, _ := newAdminUser(t, s, "alice")
	bob, _ := newAdminUser(t, s, "bob")

	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	if err := s.AdminSetUserBanned(ctx, alice.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}

	entries, err := s.AdminListAudit(ctx, alice.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("no audit entries")
	}

	entry := entries[0]
	if entry.IP != "203.0.113.7" {
		t.Errorf("audit ip = %q, want the request address", entry.IP)
	}
	if entry.UserAgent != "Mozilla/5.0 test" {
		t.Errorf("audit user agent = %q", entry.UserAgent)
	}
}

// A role granted from the configuration must leave a trail, and a demotion
// made in /admin must not be undone by the next restart.
func TestSyncConfiguredAdminsAuditsAndRespectsTheDemotion(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	alice, _ := newAdminUser(t, s, "alice")
	bob, _ := newAdminUser(t, s, "bob")

	s.cfg.Server.Admins = []string{"alice@example.test", "bob@example.test"}

	if err := s.SyncConfiguredAdmins(ctx); err != nil {
		t.Fatal(err)
	}

	// The grant is logged with the configuration as the actor.
	entries, err := s.AdminListAudit(ctx, alice.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("audit entries = %d, want 2", len(entries))
	}
	for _, entry := range entries {
		if entry.ActorID != "config" || entry.Action != "user.admin" {
			t.Fatalf("unexpected audit entry: %+v", entry)
		}
	}

	// Another administrator revokes bob's role in the panel.
	if err := s.store.AdminSetUserAdmin(ctx, alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AdminSetUserAdmin(ctx, alice.ID, bob.ID, false); err != nil {
		t.Fatal(err)
	}

	// The next startup must not hand the role back.
	if err := s.SyncConfiguredAdmins(ctx); err != nil {
		t.Fatal(err)
	}

	bobUser, err := s.store.AdminGetUser(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bobUser.IsAdmin {
		t.Fatal("the startup sync resurrected a role another administrator revoked")
	}
}

// recordingFederation captures the operations the service queues.
type recordingFederation struct {
	mu   sync.Mutex
	ops  []string
	body []any
}

func (f *recordingFederation) URL(remoteServer, path string) string {
	return "https://" + remoteServer + path
}

func (f *recordingFederation) Request(context.Context, string, string, any) ([]byte, error) {
	return nil, nil
}

func (f *recordingFederation) Post(_ context.Context, remoteServer, path string, body any) {
	f.record("POST " + remoteServer + " " + path)
	f.body = append(f.body, body)
}

func (f *recordingFederation) Patch(_ context.Context, remoteServer, path string, _ any) {
	f.record("PATCH " + remoteServer + " " + path)
}

func (f *recordingFederation) Delete(_ context.Context, remoteServer, path string) {
	f.record("DELETE " + remoteServer + " " + path)
}

func (f *recordingFederation) record(op string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.ops = append(f.ops, op)
}

func (f *recordingFederation) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.ops...)
}

// The moderation delete of a federated group goes through the durable queue:
// a disconnected peer must not lose the deletion when the admin closes the
// browser.
func TestAdminDeleteChatQueuesTheFederationDelete(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	admin := "admin:test"
	if _, err := s.store.CreateUser(ctx, "admin@example.test", "admin", "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.store.AdminSetUserAdmin(ctx, admin, true, nil); err != nil {
		t.Fatal(err)
	}

	fed := &recordingFederation{}
	s.SetFederationClient(fed)

	chat := &model.Chat{
		ID:        "group-1",
		Type:      chatTypeGroup,
		Name:      "remote group",
		OwnerID:   admin,
		CreatedAt: time.Now().UTC(),
		Members:   []string{"alice:peer.test", admin},
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}
	// A replication of the group on this server: the peer owns it.
	if err := s.store.DB().Model(&model.Chat{}).Where("id = ?", chat.ID).
		Update("remote_server", "peer.test").Error; err != nil {
		t.Fatal(err)
	}

	if err := s.AdminDeleteChat(ctx, admin, chat.ID); err != nil {
		t.Fatal(err)
	}

	ops := fed.recorded()
	if len(ops) != 1 || ops[0] != "DELETE peer.test /api/federated/groups/group-1" {
		t.Fatalf("queued operations = %v", ops)
	}
}
