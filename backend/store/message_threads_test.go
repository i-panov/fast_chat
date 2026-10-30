package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

// threadSetup is the fixture a chat with one thread and two replies in it.
type threadSetup struct {
	chat   *model.Chat
	thread *model.Thread
	first  string
	second string
}

// threadFixture creates a chat with one thread holding two messages.
//
// The member ids are the testAlice/testBob constants without creating user
// rows: nothing in this path looks a user up, and the read-status assertions
// only compare the stored user id.
func threadFixture(t *testing.T, s *Store) threadSetup {
	t.Helper()

	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick)
	if err != nil {
		t.Fatal(err)
	}

	first, _, err := s.AddMessage(ctx, chat.ID, thread.ID, testAlice, "alice", "in thread", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	second, _, err := s.AddMessage(ctx, chat.ID, thread.ID, testBob, "bob", "also in thread", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	return threadSetup{chat: chat, thread: thread, first: first.ID, second: second.ID}
}

// TestThreadMessagesCarryBothIDs pins the data model: chat_id always names the
// chat and thread_id names the thread. Overloading chat_id with the thread id
// hid thread messages from every chat-scoped query.
func TestThreadMessagesCarryBothIDs(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	createTestUser(t, s, "alice")

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick)
	if err != nil {
		t.Fatal(err)
	}

	reply, _, err := s.AddMessage(ctx, chat.ID, thread.ID, testAlice, "alice", "reply", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if reply.ChatID != chat.ID {
		t.Errorf("thread message chat_id = %q, want the chat %q", reply.ChatID, chat.ID)
	}

	if reply.ThreadID != thread.ID {
		t.Errorf("thread message thread_id = %q, want %q", reply.ThreadID, thread.ID)
	}

	top, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "top level", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if top.ThreadID != "" {
		t.Errorf("chat message thread_id = %q, want empty", top.ThreadID)
	}
}

// TestChatMessageListExcludesThreadMessages guards the chat feed: thread_id is
// no longer implied by chat_id, so the filter has to be explicit or every
// thread message would appear inline in the chat.
func TestChatMessageListExcludesThreadMessages(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	msgs, _, _ := s.GetMessagesPaginated(ctx, fx.chat.ID, 50, "")
	if len(msgs) != 1 || msgs[0].Text != "parent" {
		t.Fatalf("chat listing returned %d messages, want only the parent", len(msgs))
	}

	threadMsgs, _, _ := s.GetThreadMessagesPaginated(ctx, fx.thread.ID, 50, "")
	if len(threadMsgs) != 2 {
		t.Fatalf("thread listing returned %d messages, want 2", len(threadMsgs))
	}

	for _, m := range threadMsgs {
		if m.ChatID != fx.chat.ID {
			t.Errorf("thread message %s has chat_id %q, want %q", m.ID, m.ChatID, fx.chat.ID)
		}
	}

	if threadMsgs[0].ID != fx.first && threadMsgs[1].ID != fx.first {
		t.Error("thread listing lost the first reply")
	}
}

// TestSyncDeltaExcludesThreadMessages pins the wire contract. The client writes
// everything from the delta into its chat message store, so including thread
// messages would duplicate a thread into the chat feed.
func TestSyncDeltaExcludesThreadMessages(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	since := time.Now().UTC().Add(-time.Hour)

	got, err := s.MessagesChangedSince(ctx, []string{fx.chat.ID}, since, "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Rows) != 1 || got.Rows[0].Text != "parent" {
		t.Errorf("delta returned %d messages, want only the chat message", len(got.Rows))
	}
}

// TestThreadMessagesCanBeMarkedRead covers the read-receipt path: the client
// sends thread message ids together with the real chat id, so resolving them
// must not be scoped to the thread bucket.
func TestThreadMessagesCanBeMarkedRead(t *testing.T) {
	s := newTestStoreWithRead(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	found, err := s.GetMessagesByIDs(ctx, []string{fx.first}, fx.chat.ID)
	if err != nil {
		t.Fatal(err)
	}

	if len(found) != 1 || found[0].ID != fx.first {
		t.Fatalf("GetMessagesByIDs resolved %d thread messages, want 1", len(found))
	}

	if err := s.MarkMessagesRead(ctx, []string{fx.first}, testBob); err != nil {
		t.Fatal(err)
	}

	// The status is stored per reader, so ask as the user who marked it read.
	statuses, err := s.GetMessageReadStatusesBatch(ctx, []string{fx.first}, testBob)
	if err != nil {
		t.Fatal(err)
	}

	if statuses[fx.first] != statusRead {
		t.Errorf("read status for the thread message = %q, want %q", statuses[fx.first], statusRead)
	}
}

// TestThreadMessagesCanBeDeleted covers the delete path, which previously
// resolved the message inside the thread bucket and so 404'd for every
// thread message.
func TestThreadMessagesCanBeDeleted(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	if err := s.DeleteMessage(ctx, fx.chat.ID, fx.first, testAlice); err != nil {
		t.Fatalf("deleting a thread message by (fx.chat, id) failed: %v", err)
	}

	if _, err := s.GetMessage(ctx, fx.chat.ID, fx.first); err == nil {
		t.Error("thread message still present after delete")
	}

	// The tombstone must name the real chat so a reconnecting client learns
	// about the deletion.
	var tomb model.DeletedMessage
	if err := s.DB().First(&tomb, "message_id = ?", fx.first).Error; err != nil {
		t.Fatalf("no tombstone written: %v", err)
	}

	if tomb.ChatID != fx.chat.ID {
		t.Errorf("tombstone chat_id = %q, want %q", tomb.ChatID, fx.chat.ID)
	}
}

// TestDeleteChatRemovesThreadMessages covers the orphaning bug: chat deletion
// used to drop the threads and then delete only WHERE chat_id = fx.chat, leaving
// every thread message behind with no tombstone.
func TestDeleteChatRemovesThreadMessages(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, err := s.CreateGroupChat(ctx, "G", testAlice, []string{testBob, testCarol}, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick)
	if err != nil {
		t.Fatal(err)
	}

	first, _, err := s.AddMessage(ctx, chat.ID, thread.ID, testAlice, "alice", "in thread", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	second, _, err := s.AddMessage(ctx, chat.ID, thread.ID, testBob, "bob", "also in thread", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	firstID, secondID := first.ID, second.ID

	if err := s.DeleteChat(ctx, chat.ID); err != nil {
		t.Fatal(err)
	}

	var left int64
	s.DB().Model(&model.Message{}).Where("id IN ?", []string{firstID, secondID}).Count(&left)
	if left != 0 {
		t.Errorf("%d thread messages survived the chat deletion", left)
	}

	var parentLeft int64
	s.DB().Model(&model.Message{}).Where("chat_id = ?", chat.ID).Count(&parentLeft)
	if parentLeft != 0 {
		t.Errorf("%d chat messages survived the chat deletion", parentLeft)
	}

	var threads int64
	s.DB().Model(&model.Thread{}).Where("id = ?", thread.ID).Count(&threads)
	if threads != 0 {
		t.Error("thread row survived the chat deletion")
	}

	var tombs int64
	s.DB().Model(&model.DeletedMessage{}).Where("message_id IN ?", []string{firstID, secondID}).Count(&tombs)
	if tombs != 2 {
		t.Errorf("wrote %d tombstones for deleted thread messages, want 2", tombs)
	}
}

// TestThreadAttachmentResolvesRealChat covers file access: the chat lookup used
// to take the message's chat_id verbatim, so a file attached only to a thread
// message resolved to a chat that does not exist and nobody could read it.
func TestThreadAttachmentResolvesRealChat(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	file, err := s.SaveFile(ctx, "hash-1", "image/png", 4, "a.png", "a.png", "alice:local")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.AddMessageFiles(ctx, fx.first, []string{file.ID}); err != nil {
		t.Fatal(err)
	}

	chats, err := s.GetFileChats(ctx, file.ID)
	if err != nil {
		t.Fatal(err)
	}

	if len(chats) != 1 || chats[0] != fx.chat.ID {
		t.Errorf("file chats = %v, want [%s] (thread %s)", chats, fx.chat.ID, fx.thread.ID)
	}
}

// TestBackfillMessageThreadID migrates a database written before thread_id
// existed, where chat_id held the thread id.
func TestBackfillMessageThreadID(t *testing.T) {
	s := newTestStore(t)

	fx := threadFixture(t, s)

	// Reproduce the old layout: thread messages carried the thread id in
	// chat_id and had no thread_id at all.
	if err := s.DB().Model(&model.Message{}).Where("id IN ?", []string{fx.first, fx.second}).
		Update("chat_id", fx.thread.ID).Error; err != nil {
		t.Fatal(err)
	}

	if err := s.DB().Model(&model.Message{}).Where("id IN ?", []string{fx.first, fx.second}).
		Update("thread_id", "").Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillMessageThreadID(s.DB()); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{fx.first, fx.second} {
		var msg model.Message
		if err := s.DB().First(&msg, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}

		if msg.ChatID != fx.chat.ID {
			t.Errorf("message %s chat_id = %q, want %q", id, msg.ChatID, fx.chat.ID)
		}

		if msg.ThreadID != fx.thread.ID {
			t.Errorf("message %s thread_id = %q, want %q", id, msg.ThreadID, fx.thread.ID)
		}
	}

	// A second pass must change nothing.
	if err := backfillMessageThreadID(s.DB()); err != nil {
		t.Fatalf("backfill is not idempotent: %v", err)
	}

	var msg model.Message
	if err := s.DB().First(&msg, "id = ?", fx.first).Error; err != nil {
		t.Fatal(err)
	}

	if msg.ChatID != fx.chat.ID || msg.ThreadID != fx.thread.ID {
		t.Errorf("second pass changed the row: chat_id=%q thread_id=%q", msg.ChatID, msg.ThreadID)
	}
}

// TestBackfillMessageThreadIDMarksOrphans covers rows whose thread was deleted
// by the old chat-deletion path: they name neither a chat nor a live thread, so
// they must be marked as thread rows rather than left to look like chat
// messages.
//
// The chat id is deliberately left pointing at the dead thread: there is no
// mapping left to recover the real chat from, and inventing one (for instance
// rewriting it to the only remaining chat) would be wrong. Marking the row as a
// thread message is enough to keep it out of the chat feed and the delta.
func TestBackfillMessageThreadIDMarksOrphans(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	// Reproduce the legacy layout (chat_id holds the thread id) and then
	// remove the thread, which is what the old chat deletion did: the row is
	// left pointing at a thread that no longer exists.
	if err := s.DB().Model(&model.Message{}).Where("id = ?", fx.first).
		Updates(map[string]any{"chat_id": fx.thread.ID, "thread_id": ""}).Error; err != nil {
		t.Fatal(err)
	}

	if err := s.DB().Exec("DELETE FROM threads WHERE id = ?", fx.thread.ID).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillMessageThreadID(s.DB()); err != nil {
		t.Fatal(err)
	}

	var msg model.Message
	if err := s.DB().First(&msg, "id = ?", fx.first).Error; err != nil {
		t.Fatal(err)
	}

	// The dead thread id stays in chat_id: the real chat is not recoverable
	// once the thread row is gone, so only thread_id is stamped.
	if msg.ThreadID != fx.thread.ID {
		t.Errorf("orphan thread_id = %q, want the dead thread id %q", msg.ThreadID, fx.thread.ID)
	}

	if msg.ChatID != fx.thread.ID {
		t.Errorf("orphan chat_id = %q, want it left at the dead thread id %q", msg.ChatID, fx.thread.ID)
	}

	// It must stay out of the chat feed and the delta.
	since := time.Now().UTC().Add(-time.Hour)
	if page, err := s.MessagesChangedSince(ctx, []string{fx.chat.ID}, since, "", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	} else if len(page.Rows) != 1 {
		t.Errorf("delta returned %d messages, want only the chat message", len(page.Rows))
	}
}

// TestAddMessageRejectsThreadFromAnotherChat stops a thread id from another chat
// being used to write into this one.
func TestAddMessageRejectsThreadFromAnotherChat(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	createTestUser(t, s, "alice")

	chatA, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.AddMessage(ctx, chatA.ID, "", testAlice, "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.CreateThread(ctx, chatA.ID, parent.ID, parent.Text, parent.FromNick)
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.AddMessage(ctx, "other-chat", thread.ID, testAlice, "alice", "x", "", "", nil, false, ""); err == nil {
		t.Error("a thread from another chat was accepted")
	}

	if _, err := s.EditMessage(ctx, "other-chat", thread.ID, "whatever", testAlice, "x", nil, false, nil, nil); err == nil {
		t.Error("editing with a thread from another chat was accepted")
	}
}

// TestPaginationCursorStaysInContainer stops a cursor from another container
// from paging past the end of a chat or a thread.
func TestPaginationCursorStaysInContainer(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	// A message from the thread must not act as a chat cursor.
	msgs, _, _ := s.GetMessagesPaginated(ctx, fx.chat.ID, 50, fx.first)
	if len(msgs) != 0 {
		t.Errorf("chat listing accepted a thread message as cursor, got %d messages", len(msgs))
	}

	// A chat message must not act as a thread cursor.
	msgs, _, _ = s.GetThreadMessagesPaginated(ctx, fx.thread.ID, 50, "parent")
	if len(msgs) != 0 {
		t.Errorf("thread listing accepted a chat message as cursor, got %d messages", len(msgs))
	}

	msgs, _, _ = s.GetThreadMessagesPaginated(ctx, fx.thread.ID, 50, fx.second)
	if len(msgs) != 1 || msgs[0].ID != fx.first {
		t.Errorf("thread pagination after its own cursor returned %d messages", len(msgs))
	}
}

// TestReplyInsideThreadResolvesWithinThread keeps reply previews scoped: a
// thread reply may reference a thread message, not an unrelated chat message.
func TestReplyInsideThreadResolvesWithinThread(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	if _, _, err := s.AddMessage(ctx, fx.chat.ID, fx.thread.ID, testBob, "bob", "re", "", fx.first, nil, false, ""); err != nil {
		t.Fatalf("reply to a thread message failed: %v", err)
	}

	if _, _, err := s.AddMessage(ctx, fx.chat.ID, fx.thread.ID, testBob, "bob", "re", "", "parent", nil, false, ""); err == nil {
		t.Error("a thread reply resolved a chat-level message")
	}
}

// TestAddRawMessageValidatesThreadID covers the second write path into
// messages. AddRawMessage is fed by the federation receiver, which builds the
// row from the wire payload, so the thread it names has to be checked the same
// way AddMessage checks it — otherwise a peer could point a message at a
// thread belonging to another chat.
func TestAddRawMessageValidatesThreadID(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fx := threadFixture(t, s)

	raw := func(chatID, threadID string) *model.Message {
		return &model.Message{
			ChatID:   chatID,
			ThreadID: threadID,
			FromID:   "peer:remote.test",
			FromNick: "peer",
			Text:     "from a peer",
		}
	}

	if err := s.AddRawMessage(ctx, raw(fx.chat.ID, fx.thread.ID)); err != nil {
		t.Fatalf("a valid thread was rejected: %v", err)
	}

	// A thread of another chat must not be accepted.
	if err := s.AddRawMessage(ctx, raw("other-chat", fx.thread.ID)); err == nil {
		t.Error("a thread from another chat was accepted")
	}

	// An unknown thread must not be accepted either.
	if err := s.AddRawMessage(ctx, raw(fx.chat.ID, "no-such-thread")); err == nil {
		t.Error("an unknown thread was accepted")
	}

	// The accepted row must be stored under the chat, not the thread.
	var stored model.Message
	if err := s.DB().Where("thread_id = ?", fx.thread.ID).First(&stored).Error; err != nil {
		t.Fatal(err)
	}

	if stored.ChatID != fx.chat.ID {
		t.Errorf("stored chat_id = %q, want %q", stored.ChatID, fx.chat.ID)
	}
}

// TestMessageScopeAndDoesNotShareBackingArray pins the invariant that and()
// exists for.
//
// A bare append(scope.args, ...) is correct only while the backing array has no
// spare capacity, and Go allocates in that case, so the bug is invisible until
// someone changes how a scope is built. The scope below is therefore given
// spare capacity on purpose: that is the only situation in which the two
// implementations differ, and the one in which two queries would write into the
// same array.
func TestMessageScopeAndDoesNotShareBackingArray(t *testing.T) {
	spare := make([]any, 0, 4)
	spare = append(spare, "chat-1")
	base := messageScope{where: "chat_id = ?", args: spare}

	narrowed := base.and("id = ?", "m1")

	if narrowed.where != base.where+" AND id = ?" {
		t.Errorf("narrowed where = %q, want the condition appended", narrowed.where)
	}

	if len(narrowed.args) != 2 || narrowed.args[1] != "m1" {
		t.Fatalf("narrowed args = %v, want the original plus the id", narrowed.args)
	}

	narrowed.args[0] = "clobbered"

	if base.args[0] != "chat-1" {
		t.Errorf("and() shares its backing array with the receiver: base.args = %v", base.args)
	}
}
