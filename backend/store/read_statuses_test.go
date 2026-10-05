package store

import (
	"context"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/model"
)

// newTestStoreWithRead creates a store whose schema also has the
// MessageReadStatus table (not included in the default test migration).
func newTestStoreWithRead(t *testing.T) *Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}, &model.MessageReadStatus{}); err != nil {
		t.Fatal(err)
	}

	return New(db)
}

func seedMessages(t *testing.T, s *Store, chatID string, msgs ...string) []model.Message {
	t.Helper()

	out := make([]model.Message, 0, len(msgs))
	for _, text := range msgs {
		m, _, err := s.AddMessage(context.Background(), chatID, "", "alice:test", "alice", text, "", "", nil, false, "")
		if err != nil {
			t.Fatalf("add message %q: %v", text, err)
		}
		out = append(out, *m)
	}

	return out
}

func TestMarkMessagesReadAndBatch(t *testing.T) {
	s := newTestStoreWithRead(t)
	_ = createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")

	chat, err := s.CreateGroupChat(context.Background(), "room", "alice:test", []string{"alice:test", bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "one", "two", "three")
	ids := []string{msgs[0].ID, msgs[1].ID, msgs[2].ID}

	if err := s.MarkMessagesRead(context.Background(), ids, bob.ID); err != nil {
		t.Fatalf("MarkMessagesRead: %v", err)
	}

	statuses, err := s.GetMessageReadStatusesBatch(context.Background(), ids, bob.ID)
	if err != nil {
		t.Fatalf("batch: %v", err)
	}

	for _, id := range ids {
		if statuses[id] != statusRead {
			t.Errorf("message %s status = %q, want read", id, statuses[id])
		}
	}

	// Empty lists are safe.
	if err := s.MarkMessagesRead(context.Background(), nil, bob.ID); err != nil {
		t.Errorf("empty read list: %v", err)
	}
	if m, _ := s.GetMessageReadStatusesBatch(context.Background(), nil, bob.ID); len(m) != 0 {
		t.Errorf("empty batch should return empty map, got %v", m)
	}
}

func TestMarkMessagesDeliveredDoesNotOverrideRead(t *testing.T) {
	s := newTestStoreWithRead(t)
	_ = createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")

	chat, err := s.CreateGroupChat(context.Background(), "room", "alice:test", []string{"alice:test", bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "one")
	id := msgs[0].ID

	// Mark delivered first.
	if err := s.MarkMessagesDelivered(context.Background(), []string{id}, bob.ID); err != nil {
		t.Fatalf("delivered: %v", err)
	}

	statuses, _ := s.GetMessageReadStatusesBatch(context.Background(), []string{id}, bob.ID)
	if statuses[id] != statusDelivered {
		t.Errorf("status = %q, want delivered", statuses[id])
	}

	// Now mark read.
	if err := s.MarkMessagesRead(context.Background(), []string{id}, bob.ID); err != nil {
		t.Fatalf("read: %v", err)
	}

	// Trying to downgrade delivered (already read) must keep read.
	if err := s.MarkMessagesDelivered(context.Background(), []string{id}, bob.ID); err != nil {
		t.Fatalf("re-delivered: %v", err)
	}

	statuses, _ = s.GetMessageReadStatusesBatch(context.Background(), []string{id}, bob.ID)
	if statuses[id] != statusRead {
		t.Errorf("status = %q after redeliver, want read preserved", statuses[id])
	}
}

func TestGetMessageReadStatusesForSender(t *testing.T) {
	s := newTestStoreWithRead(t)
	alice := createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")
	carol := createTestUser(t, s, "carol")

	chat, err := s.CreateGroupChat(context.Background(), "room", alice.ID, []string{alice.ID, bob.ID, carol.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "hello")
	id := msgs[0].ID

	// Bob reads, Carol does not.
	if err := s.MarkMessagesRead(context.Background(), []string{id}, bob.ID); err != nil {
		t.Fatal(err)
	}

	readers, err := s.GetMessageReadStatusesForSender(context.Background(), []string{id}, alice.ID)
	if err != nil {
		t.Fatalf("for sender: %v", err)
	}

	if len(readers[id]) != 1 || readers[id][0] != bob.ID {
		t.Errorf("readers = %v, want [%s]", readers[id], bob.ID)
	}

	// Unknown message IDs return empty.
	empty, _ := s.GetMessageReadStatusesForSender(context.Background(), []string{"nope"}, alice.ID)
	if len(empty) != 0 {
		t.Errorf("unknown ids should be empty, got %v", empty)
	}
}

func TestGetMessageDeliveryStatuses(t *testing.T) {
	s := newTestStoreWithRead(t)
	alice := createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")

	chat, err := s.CreateGroupChat(context.Background(), "room", alice.ID, []string{alice.ID, bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "one", "two")
	m1, m2 := msgs[0].ID, msgs[1].ID

	// No delivery records -> "sent".
	statuses, err := s.GetMessageDeliveryStatuses(context.Background(), []string{m1, m2}, alice.ID)
	if err != nil {
		t.Fatalf("delivery: %v", err)
	}
	if statuses[m1] != "sent" || statuses[m2] != "sent" {
		t.Errorf("initial statuses = %v, want sent", statuses)
	}

	// m2 delivered.
	if err := s.MarkMessagesDelivered(context.Background(), []string{m2}, bob.ID); err != nil {
		t.Fatal(err)
	}
	// m1 read.
	if err := s.MarkMessagesRead(context.Background(), []string{m1}, bob.ID); err != nil {
		t.Fatal(err)
	}

	statuses, _ = s.GetMessageDeliveryStatuses(context.Background(), []string{m1, m2}, alice.ID)
	if statuses[m1] != statusRead {
		t.Errorf("m1 = %q, want read", statuses[m1])
	}
	if statuses[m2] != statusDelivered {
		t.Errorf("m2 = %q, want delivered", statuses[m2])
	}
}

func TestGetMessageReaders(t *testing.T) {
	s := newTestStoreWithRead(t)
	alice := createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")
	carol := createTestUser(t, s, "carol")

	chat, err := s.CreateGroupChat(context.Background(), "room", alice.ID, []string{alice.ID, bob.ID, carol.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "hello")
	id := msgs[0].ID

	if err := s.MarkMessagesRead(context.Background(), []string{id}, bob.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkMessagesRead(context.Background(), []string{id}, carol.ID); err != nil {
		t.Fatal(err)
	}

	readers, err := s.GetMessageReaders(context.Background(), id, 10)
	if err != nil {
		t.Fatalf("readers: %v", err)
	}

	if len(readers) != 2 {
		t.Errorf("readers = %v, want 2 readers", readers)
	}

	// Limit applies.
	limited, _ := s.GetMessageReaders(context.Background(), id, 1)
	if len(limited) != 1 {
		t.Errorf("limited readers = %v, want 1", limited)
	}
}

func TestGetMessagesByIDs(t *testing.T) {
	s := newTestStoreWithRead(t)
	alice := createTestUser(t, s, "alice")

	chat, err := s.CreateGroupChat(context.Background(), "room", alice.ID, []string{alice.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	msgs := seedMessages(t, s, chat.ID, "one", "two")

	got, err := s.GetMessagesByIDs(context.Background(), []string{msgs[0].ID, msgs[1].ID}, chat.ID)
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("got %d messages, want 2", len(got))
	}

	// Wrong chat -> none.
	other, err := s.GetMessagesByIDs(context.Background(), []string{msgs[0].ID}, "chat-zzz")
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Errorf("wrong chat should return none, got %d", len(other))
	}
}
