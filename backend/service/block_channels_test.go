package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
)

// privatePair creates two users and the private chat between them.
func privatePair(t *testing.T, svc *Service, hub *sse.Hub, first, second string) (*model.Chat, chan sse.Event, chan sse.Event) {
	t.Helper()

	ctx := context.Background()
	for _, nick := range []string{first, second} {
		if _, err := svc.store.CreateUser(ctx, nick+"@example.com", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := svc.store.CreateChat(ctx, first+":test", second+":test", "")
	if err != nil {
		t.Fatal(err)
	}

	return chat, subscribe(t, hub, first+":test"), subscribe(t, hub, second+":test")
}

// Blocking has to silence every channel, not only new messages: typing
// indicators, read receipts and deletes are just as much a way to keep
// contacting the person who blocked you.
func TestBlockSilencesTypingReadReceiptsAndEdits(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	chat, aliceEvents, bobEvents := privatePair(t, svc, hub, "alice", "bob")
	aliceID := "alice:test"
	bobID := "bob:test"

	// The message is sent before the block: the block must silence the
	// follow-up channels, not only new sends.
	msg, _, err := svc.SendMessageWithResult(ctx, chat, "", bobID, "bob", &SendMessageInput{ID: "from-bob", Text: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	drainEvents(bobEvents)
	drainEvents(aliceEvents)

	if err := svc.store.BlockUser(ctx, bobID, aliceID); err != nil {
		t.Fatal(err)
	}

	// Typing is suppressed instead of broadcast.
	if !svc.HandleTyping(ctx, chat, chat.ID, aliceID, "alice", true) {
		t.Error("typing from a blocked user must be suppressed")
	}
	if got := drainEvents(bobEvents); len(got) != 0 {
		t.Errorf("blocked user's typing reached the blocker: %v", got)
	}

	// A read receipt from the blocked user must not reach the blocker.
	if err := svc.MarkMessagesRead(ctx, chat.ID, aliceID, []string{msg.ID}); err != nil {
		t.Fatal(err)
	}
	if got := drainEvents(bobEvents); len(got) != 0 {
		t.Errorf("read receipt from the blocked user reached the blocker: %v", got)
	}

	// Editing own old messages is refused.
	_, _, err = svc.EditMessage(ctx, chat.ID, "", msg.ID, bobID, &DecodedEditRequest{Text: "edited"}, 300)
	if !errors.Is(err, ErrUserBlocked) {
		t.Fatalf("edit by a blocked user = %v, want ErrUserBlocked", err)
	}

	// Deleting stays possible, but the blocker is not notified.
	if err := svc.DeleteMessage(ctx, chat, msg.ID, bobID, 0); err != nil {
		t.Fatalf("delete by a blocked user must still work: %v", err)
	}
	if got := drainEvents(aliceEvents); len(got) != 0 {
		t.Errorf("delete event from the blocked user reached the blocker: %v", got)
	}

	// The deleter's own streams still hear about it, so his clients converge.
	if got := drainEvents(bobEvents); len(got) != 1 || got[0] != eventMessageDeleted {
		t.Errorf("the deleter's own streams = %v, want one %s", got, eventMessageDeleted)
	}
}

// Adding a member is the same reach as creating a group: the owner's block
// must not be bypassed by inviting the person into an existing group.
func TestAddChatMemberRejectsBlockedInvitee(t *testing.T) {
	svc, _ := newHubbedTestService(t)
	ctx := context.Background()

	owner := "alice:test"
	if _, err := svc.store.CreateUser(ctx, "alice@example.com", "alice", "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.store.CreateUser(ctx, "bob@example.com", "bob", "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	group, err := svc.CreateGroupChat(ctx, owner, "friends", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.store.BlockUser(ctx, owner, "bob:test"); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.AddChatMember(ctx, group.ID, "bob:test"); !errors.Is(err, ErrUserBlocked) {
		t.Fatalf("adding a blocked user = %v, want ErrUserBlocked", err)
	}
}

// The chat list must not leak the presence of a blocked peer: profiling the
// peer is itself a form of contact.
func TestChatListMasksBlockedPeerPresence(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	chat, _, _ := privatePair(t, svc, hub, "alice", "bob")
	_ = chat
	svc.store.SetPresence("bob:test", true)
	svc.store.SetPresence("alice:test", true)

	before := svc.GetChats(ctx, "alice:test")
	if len(before) != 1 || !before[0].Members[1].Online {
		t.Fatalf("precondition: the peer must be online before the block: %+v", before)
	}

	if err := svc.store.BlockUser(ctx, "bob:test", "alice:test"); err != nil {
		t.Fatal(err)
	}

	after := svc.GetChats(ctx, "alice:test")
	if !after[0].Members[0].Online {
		t.Error("the viewer's own presence must stay visible")
	}
	if after[0].Members[1].Online {
		t.Error("the blocked peer's presence must be masked")
	}
}

// A group name is validated in characters, not bytes: a Cyrillic name that
// fits the limit must not be rejected because it is longer in bytes.
func TestGroupNameCountsRunes(t *testing.T) {
	svc, _ := newHubbedTestService(t)
	ctx := context.Background()

	if _, err := svc.store.CreateUser(ctx, "alice@example.com", "alice", "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	// 21 Cyrillic letters: 42 bytes, 21 characters.
	name := "абвгдежзийклмнопрстуф"
	if _, err := svc.CreateGroupChat(ctx, "alice:test", name, nil); err != nil {
		t.Fatalf("a valid Cyrillic group name was rejected: %v", err)
	}

	tooLong := name + name + name
	if _, err := svc.CreateGroupChat(ctx, "alice:test", tooLong, nil); !errors.Is(err, ErrGroupNameInvalid) {
		t.Fatalf("an over-long name = %v, want ErrGroupNameInvalid", err)
	}
}

// An unbounded memberIDs list turns one request into tens of thousands of
// block checks and lookups.
func TestCreateGroupRejectsTooManyMembers(t *testing.T) {
	svc, _ := newHubbedTestService(t)
	ctx := context.Background()

	ids := make([]string, MaxGroupMembers+1)
	for i := range ids {
		ids[i] = "user" + string(rune('a'+i%26))
	}

	if _, err := svc.CreateGroupChat(ctx, "alice:test", "big", ids); !errors.Is(err, ErrTooManyMembers) {
		t.Fatalf("err = %v, want ErrTooManyMembers", err)
	}
}

// A retried send repairs attachments a previous attempt failed to link: the
// outbox resends the same id, and the row must not stay without its files.
func TestSendRetryRepairsAttachments(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	chat, _, _ := privatePair(t, svc, hub, "alice", "bob")
	alice := "alice:test"

	file, err := svc.store.SaveFile(ctx, "hash-1", "image/png", 4, "a.png", "20060102/one", alice)
	if err != nil {
		t.Fatal(err)
	}
	storeBlob(t, svc, file.StoragePath)

	input := &SendMessageInput{ID: "msg-files", Text: "with a photo", FileIDs: []string{file.ID}}
	if _, _, err := svc.SendMessageWithResult(ctx, chat, "", alice, "alice", input); err != nil {
		t.Fatal(err)
	}

	// Simulate the failure the retry has to repair: the row is stored, the
	// link is not.
	if err := svc.store.DB().Where("message_id = ?", "msg-files").Delete(&model.MessageFile{}).Error; err != nil {
		t.Fatal(err)
	}

	msg, created, err := svc.SendMessageWithResult(ctx, chat, "", alice, "alice", input)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("the retry must not report a new row")
	}
	if len(msg.Files) != 1 || msg.Files[0].ID != file.ID {
		t.Fatalf("the retry did not repair the attachment: %+v", msg.Files)
	}
}

// The edit broadcast carries a per-viewer reaction aggregate: the editor's "my
// reaction" flag must not become everyone else's.
func TestEditBroadcastKeepsPerViewerReactions(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	chat, aliceEvents, bobEvents := privatePair(t, svc, hub, "alice", "bob")

	msg, err := svc.SendMessage(ctx, chat, "", "alice:test", "alice", &SendMessageInput{ID: "m1", Text: "before"})
	if err != nil {
		t.Fatal(err)
	}
	_ = msg
	if _, err := svc.AddReaction(ctx, chat, "m1", "bob:test", "👍"); err != nil {
		t.Fatal(err)
	}
	drainEvents(aliceEvents)
	drainEvents(bobEvents)

	updated, _, err := svc.EditMessage(ctx, chat.ID, "", "m1", "alice:test", &DecodedEditRequest{Text: "after"}, 300)
	if err != nil {
		t.Fatal(err)
	}
	// The response to the editor carries the editor's view: no own reaction.
	if len(updated.Reactions) != 1 || updated.Reactions[0].Me {
		t.Fatalf("editor view = %+v, want one reaction without Me", updated.Reactions)
	}

	svc.BroadcastMessageUpdated(ctx, chat, "", &updated)

	aliceView := findMessageUpdated(t, aliceEvents)
	if aliceView.Reactions[0].Me {
		t.Error("the editor received its own Me flag for another user's reaction")
	}

	bobView := findMessageUpdated(t, bobEvents)
	if !bobView.Reactions[0].Me {
		t.Error("the reader lost their own Me flag after the edit")
	}
	if bobView.Reactions[0].Count != 1 {
		t.Errorf("reaction count = %d, want 1", bobView.Reactions[0].Count)
	}
}

// findMessageUpdated waits for the message_updated event and returns the
// message it carries.
func findMessageUpdated(t *testing.T, events chan sse.Event) model.Message {
	t.Helper()

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Event != eventMessageUpdated {
				continue
			}
			msg, ok := event.Data.(*model.Message)
			if !ok {
				t.Fatalf("message_updated payload = %T", event.Data)
			}

			return *msg
		case <-deadline:
			t.Fatal("no message_updated event")
		}
	}
}

// A client message id is a global primary key: an unbounded value must be
// refused before it reaches the store.
func TestSendRejectsOverlongMessageID(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	chat, _, _ := privatePair(t, svc, hub, "alice", "bob")

	big := make([]byte, MaxMessageIDLen+1)
	for i := range big {
		big[i] = 'x'
	}

	_, _, err := svc.SendMessageWithResult(ctx, chat, "", "alice:test", "alice", &SendMessageInput{ID: string(big), Text: "hi"})
	if !errors.Is(err, ErrMessageIDInvalid) {
		t.Fatalf("err = %v, want ErrMessageIDInvalid", err)
	}
}
