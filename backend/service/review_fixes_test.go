package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
)

// --- chat.go: SSRF via port / numeric IP forms ---

func TestIsValidRemoteDomainRejectsUnsafeHosts(t *testing.T) {
	unsafe := []string{
		"127.0.0.1:8080",
		"10.0.0.1:8080",
		"192.168.1.1:9000",
		"[::1]:8080",
		"[::1]",
		"::1",
		"0x7f.0.0.1",
		"0X7F.0.0.1",
		"0177.0.0.1",
		"2130706433",
		"0x7f000001",
		"3232235777", // 192.168.1.1
		"224.0.0.1",
		"localhost",
		"localhost:8080",
		"localhost.",
		"0.0.0.0",
		"",
		"evil@127.0.0.1",
		// Crafted multi-colon authorities: not bare IPv6, must not pass
		// as DNS names (would land in Chat.RemoteServer and fed.URL).
		"evil:127.0.0.1:9000",
		"a:b:c",
		"x:10.0.0.1:8080",
	}

	for _, domain := range unsafe {
		if IsValidRemoteDomain(domain) {
			t.Errorf("IsValidRemoteDomain(%q) = true, want false", domain)
		}
	}

	safe := []string{
		"example.com",
		"example.com:8080",
		"remote.test",
		"8.8.8.8",
		"8.8.8.8:53",
		"1.1.1.1",
	}

	for _, domain := range safe {
		if !IsValidRemoteDomain(domain) {
			t.Errorf("IsValidRemoteDomain(%q) = false, want true", domain)
		}
	}
}

// --- service.go: typed-nil hub ---

func TestNewWithNilHubKeepsEventsNil(t *testing.T) {
	s := newTestService(t)

	if s.events != nil {
		t.Fatal("events must stay nil for a nil hub, or sendEvent panics on typed-nil")
	}

	// Must not panic without a fan-out.
	s.sendEvent("nobody", sse.Event{Event: "x"})
}

// --- typing.go: nil hub + mock clock ---

func TestHandleTypingNilHubDoesNotPanic(t *testing.T) {
	s := newTestService(t)
	chat := &model.Chat{ID: "c1", Members: []string{"a", "b"}}

	if s.HandleTyping(context.Background(), chat, "c1", "a", "a", true) {
		t.Error("expected no throttle on first indicator")
	}

	if s.HandleTyping(context.Background(), chat, "c1", "a", "a", false) {
		t.Error("stop indicator must never throttle")
	}
}

func TestHandleTypingThrottleUsesMockClock(t *testing.T) {
	s := newFedTestService(t)
	chat := &model.Chat{ID: "c1", Members: []string{"a", "b"}}
	ctx := context.Background()

	old := nowFunc
	defer func() { nowFunc = old }()

	base := time.Now()
	nowFunc = func() time.Time { return base }

	if s.HandleTyping(ctx, chat, "c1", "a", "a", true) {
		t.Fatal("first indicator must not throttle")
	}

	if !s.HandleTyping(ctx, chat, "c1", "a", "a", true) {
		t.Fatal("second indicator at the same instant must throttle")
	}

	nowFunc = func() time.Time { return base.Add(TypingThrottleInterval + time.Second) }

	if s.HandleTyping(ctx, chat, "c1", "a", "a", true) {
		t.Fatal("indicator after the throttle window must pass")
	}
}

// --- messages.go: empty after resolve ---

func TestSendMessageRejectsEmptyAfterResolve(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	foreign, err := s.store.SaveFile(ctx, "h-foreign", "image/png", 10, "f.png", "p/1", "bob:local")
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, "alice:local", "bob:local", "")
	if err != nil {
		t.Fatal(err)
	}

	_, err = s.SendMessage(ctx, chat, "", "alice:local", "alice",
		&SendMessageInput{Text: "   ", FileIDs: []string{foreign.ID}})
	if !errors.Is(err, ErrEmptyMessage) {
		t.Fatalf("err = %v, want ErrEmptyMessage", err)
	}
}

func TestEditMessageRejectsEmptyAfterResolve(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	foreign, err := s.store.SaveFile(ctx, "h-foreign", "image/png", 10, "f.png", "p/1", "bob:local")
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, "alice:local", "bob:local", "")
	if err != nil {
		t.Fatal(err)
	}

	msg, err := s.SendMessage(ctx, chat, "", "alice:local", "alice",
		&SendMessageInput{ID: "m1", Text: "hello"})
	if err != nil {
		t.Fatal(err)
	}

	_, _, err = s.EditMessage(ctx, chat.ID, "", msg.ID, "alice:local",
		&DecodedEditRequest{Text: "  ", FileIDs: []string{foreign.ID}}, 0)
	if !errors.Is(err, ErrEmptyMessage) {
		t.Fatalf("err = %v, want ErrEmptyMessage", err)
	}
}

// --- messages.go: single aggregated delivery receipt, online-gated ---

func TestNotifyMessageSentSingleReceiptOnlineOnly(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	for _, nick := range []string{"alice", "bob", "carol"} {
		if _, err := svc.store.CreateUser(ctx, nick+"@example.com", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := svc.store.CreateGroupChat(ctx, "G", "alice:test", []string{"bob:test", "carol:test"}, "")
	if err != nil {
		t.Fatal(err)
	}

	// Only bob is online; carol stays offline.
	svc.store.AddConnection("bob:test")

	aliceEvents := subscribe(t, hub, "alice:test")
	subscribe(t, hub, "bob:test")

	msg, err := svc.SendMessage(ctx, chat, "", "alice:test", "alice", &SendMessageInput{ID: "m1", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}

	if got := countEvents(t, aliceEvents, 1, 1); got != 1 {
		t.Fatalf("sender got %d delivery receipts, want a single aggregated one", got)
	}

	statuses, err := svc.store.GetMessageDeliveryStatuses(ctx, []string{msg.ID}, "alice:test")
	if err != nil {
		t.Fatal(err)
	}

	if statuses[msg.ID] != "delivered" {
		t.Errorf("status = %q, want delivered (bob is online)", statuses[msg.ID])
	}
}

// countEvents drains one new_message and up to wantDelivered delivery
// receipts from the sender channel, failing on timeout or surplus receipts.
func countEvents(t *testing.T, aliceEvents chan sse.Event, wantNew, wantDelivered int) int {
	t.Helper()

	deadline := time.After(time.Second)
	delivered := 0
	newMsg := 0

	for newMsg < wantNew || delivered < wantDelivered {
		select {
		case evt := <-aliceEvents:
			switch evt.Event {
			case eventNewMessage:
				newMsg++
			case eventMessageDelivered:
				delivered++

				if delivered > wantDelivered {
					t.Fatalf("sender got %d delivery receipts, want %d", delivered, wantDelivered)
				}
			}
		case <-deadline:
			t.Fatalf("new=%d delivered=%d, want new>=%d delivered=%d", newMsg, delivered, wantNew, wantDelivered)
		}
	}

	return delivered
}

func TestNotifyMessageSentOfflineStaysSent(t *testing.T) {
	svc, hub := newHubbedTestService(t)
	ctx := context.Background()

	for _, nick := range []string{"alice", "bob"} {
		if _, err := svc.store.CreateUser(ctx, nick+"@example.com", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := svc.store.CreateChat(ctx, "alice:test", "bob:test", "")
	if err != nil {
		t.Fatal(err)
	}

	// Nobody online: no receipt, status stays sent.
	senderEvents := subscribe(t, hub, "alice:test")

	msg, err := svc.SendMessage(ctx, chat, "", "alice:test", "alice", &SendMessageInput{ID: "m2", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}

	timeout := time.After(200 * time.Millisecond)

	for {
		select {
		case evt := <-senderEvents:
			if evt.Event == eventMessageDelivered {
				t.Fatal("offline recipient must not produce a delivery receipt")
			}
		case <-timeout:
			goto checked
		}
	}

checked:
	statuses, err := svc.store.GetMessageDeliveryStatuses(ctx, []string{msg.ID}, "alice:test")
	if err != nil {
		t.Fatal(err)
	}

	if statuses[msg.ID] != "sent" {
		t.Errorf("status = %q, want sent (nobody online)", statuses[msg.ID])
	}
}

// --- messages.go: thread-on-thread ---

func TestCreateThreadRejectsThreadMessage(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	chat, err := s.store.CreateChat(ctx, "alice:local", "bob:local", "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.store.AddMessage(ctx, chat.ID, "", "alice:local", "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.CreateThread(ctx, chat, chat.ID, parent.ID)
	if err != nil {
		t.Fatal(err)
	}

	child, _, err := s.store.AddMessage(ctx, chat.ID, thread.ID, "bob:local", "bob", "in thread", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.CreateThread(ctx, chat, chat.ID, child.ID); !errors.Is(err, ErrThreadOnThread) {
		t.Fatalf("err = %v, want ErrThreadOnThread", err)
	}
}

// --- messages.go: location {} ---

func TestParseLocationPatchRejectsEmptyObject(t *testing.T) {
	for _, raw := range []string{`{}`, `{"foo":1}`, `{"lat":1}`, `{"lng":1}`, `{"lat":"x","lng":1}`} {
		if _, _, err := parseLocationPatch(json.RawMessage(raw)); !errors.Is(err, ErrInvalidCoordinates) {
			t.Errorf("%s: err = %v, want ErrInvalidCoordinates", raw, err)
		}
	}
}

// --- federation.go: location-only inbound ---

func TestSendFederatedMessageAcceptsLocationOnly(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID: "m-loc", FromID: "b:rem", FromNick: "b", Location: &model.Location{Lat: 55.7, Lng: 37.6},
	}, MaxMessageLen); err != nil {
		t.Fatalf("location-only inbound: %v", err)
	}

	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID: "m-empty", FromID: "b:rem", FromNick: "b", Text: "  ",
	}, MaxMessageLen); !errors.Is(err, ErrEmptyMessage) {
		t.Fatalf("empty inbound: err = %v, want ErrEmptyMessage", err)
	}
}

// --- federation.go: edit response keeps full state, clears files ---

func TestEditFederatedMessageKeepsReplyAndThread(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	parent := &model.Message{ID: "p1", ChatID: "c1", FromID: "a:loc", FromNick: "a", Text: "parent", CreatedAt: time.Now().UTC()}
	if err := s.store.AddRawMessage(ctx, parent); err != nil {
		t.Fatal(err)
	}

	threadMsg := &model.Message{ID: "t1", ChatID: "c1", ThreadID: "th1", FromID: "b:rem", FromNick: "b", Text: "in thread", CreatedAt: time.Now().UTC()}
	thread := &model.Thread{ID: "th1", ChatID: "c1", ParentMessageID: "p1", ParentMessageText: "parent", ParentMessageFrom: "a", CreatedAt: time.Now().UTC()}
	if err := s.store.DB().Create(thread).Error; err != nil {
		t.Fatal(err)
	}

	if err := s.store.AddRawMessage(ctx, threadMsg); err != nil {
		t.Fatal(err)
	}

	replyChild := &model.Message{ID: "r1", ChatID: "c1", FromID: "b:rem", FromNick: "b", Text: "reply", CreatedAt: time.Now().UTC(),
		ReplyTo: &model.ReplyToInfo{MessageID: "p1", Text: "parent", FromNick: "a"}}
	if err := s.store.AddRawMessage(ctx, replyChild); err != nil {
		t.Fatal(err)
	}

	updated, err := s.EditFederatedMessage(ctx, chat, "r1", "", &DecodedEditRequest{Text: "edited"}, 0)
	if err != nil {
		t.Fatal(err)
	}

	if updated.ReplyTo == nil || updated.ReplyTo.MessageID != "p1" {
		t.Fatalf("reply context lost: %+v", updated.ReplyTo)
	}

	updatedThread, err := s.EditFederatedMessage(ctx, chat, "t1", "th1", &DecodedEditRequest{Text: "edited thread"}, 0)
	if err != nil {
		t.Fatal(err)
	}

	if updatedThread.ThreadID != "th1" {
		t.Fatalf("thread id lost: %q", updatedThread.ThreadID)
	}
}

func TestEditFederatedMessageClearsFilesOnEmptyList(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	file, err := s.store.SaveFile(ctx, "h1", "image/png", 10, "a.png", "p/1", "b:rem")
	if err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "b:rem", FromNick: "b", Text: "hi", CreatedAt: time.Now().UTC()}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if err := s.store.SetMessageFiles(ctx, "m1", []string{file.ID}); err != nil {
		t.Fatal(err)
	}

	updated, err := s.EditFederatedMessage(ctx, chat, "m1", "", &DecodedEditRequest{
		Text: "hi", FileIDs: []string{},
	}, 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(updated.Files) != 0 {
		t.Fatalf("files = %v, want cleared", updated.Files)
	}
}

// --- federation.go: SyncFederated threads + catchup reply ---

func TestSyncFederatedIncludesThreadMessages(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	thread := &model.Thread{ID: "th1", ChatID: "c1", ParentMessageID: "p1", ParentMessageText: "p", ParentMessageFrom: "a", CreatedAt: time.Now().UTC()}
	if err := s.store.DB().Create(thread).Error; err != nil {
		t.Fatal(err)
	}

	threadMsg := &model.Message{ID: "tm1", ChatID: "c1", ThreadID: "th1", FromID: "b:rem", FromNick: "b", Text: "in thread", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := s.store.AddRawMessage(ctx, threadMsg); err != nil {
		t.Fatal(err)
	}

	resp, err := s.SyncFederated(ctx, "rem", time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	found := false
	for _, m := range resp.ThreadMessages {
		if m.ID == "tm1" {
			found = true
		}
	}

	if !found {
		t.Fatalf("thread message missing from SyncFederated: %+v", resp.ThreadMessages)
	}

	if resp.ThreadMessages == nil || resp.Messages == nil || resp.Chats == nil || resp.DeletedMessages == nil {
		t.Fatal("SyncFederated must return [] instead of nil")
	}
}

func TestCatchupAppliesReplyContext(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	created := time.Now().UTC().Add(-time.Minute)

	parent := &model.Message{ID: "p1", ChatID: "chat-1", FromID: "alice:localhost:8080", FromNick: "alice", Text: "parent", CreatedAt: created}
	chat := &model.Chat{ID: "chat-1", Members: []string{"alice:localhost:8080", "bob:remote.test"}, RemoteServer: "remote.test", CreatedAt: created}

	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	if err := s.store.AddRawMessage(ctx, parent); err != nil {
		t.Fatal(err)
	}

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: created.Add(time.Second),
			Chats: []FederatedChatDTO{{
				ID: "chat-1", Type: "private",
				Members:   []string{"alice:localhost:8080", "bob:remote.test"},
				CreatedAt: created,
			}},
			Messages: []model.Message{{
				ID: "msg-1", ChatID: "chat-1",
				FromID: "bob:remote.test", FromNick: "bob", Text: "reply",
				CreatedAt: created,
				ReplyTo:   &model.ReplyToInfo{MessageID: "p1", Text: "parent", FromNick: "alice"},
			}},
		},
	}

	s.SetFederationClient(client)
	s.catchupPeer(ctx, "remote.test")

	stored, err := s.store.GetMessage(ctx, "chat-1", "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	if stored.ReplyTo == nil || stored.ReplyTo.MessageID != "p1" {
		t.Fatalf("reply context lost in catchup: %+v", stored.ReplyTo)
	}
}

func TestCatchupSendsTombstoneToRemovedMembers(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice.ID, "bob:remote.test", "remote.test")
	if err != nil {
		t.Fatal(err)
	}

	connID := "conn-bob"
	conn := s.hub.Register(connID)
	if err := s.hub.Authenticate(connID, "bob:remote.test", "t", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	defer s.hub.Unregister(connID, conn)

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: time.Now().UTC(),
			Chats: []FederatedChatDTO{{
				ID: chat.ID, Type: "private",
				Members:   []string{alice.ID, "carol:remote.test"},
				CreatedAt: chat.CreatedAt,
			}},
		},
	}

	s.SetFederationClient(client)
	s.catchupPeer(ctx, "remote.test")

	select {
	case evt := <-conn.Channel:
		if evt.Event != eventChatDeleted {
			t.Fatalf("event = %q, want chat_deleted", evt.Event)
		}
	case <-time.After(time.Second):
		t.Fatal("removed member got no chat_deleted tombstone")
	}
}

// --- calls.go: legacy IDs ---

func TestStartCallAcceptsLegacyIDWithoutDomain(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chat, err := s.store.CreateChat(ctx, "alice", "bob", "")
	if err != nil {
		t.Fatal(err)
	}

	// Must not fail with ErrRemoteCallee: a domain-less id is local.
	if _, err := s.StartCall(ctx, "alice", chat.ID, "offer"); err != nil {
		t.Fatalf("StartCall legacy ids: %v", err)
	}
}

// --- auth.go: code stored only after successful send ---

type captureSender struct {
	code string
	err  error
}

var errTestSendFailure = errors.New("test send failure")

func (c *captureSender) SendCode(_, code string) error {
	c.code = code
	return c.err
}

func TestSendCodeStoredOnlyAfterSuccessfulSend(t *testing.T) {
	s := newTestService(t)

	failing := &captureSender{err: errTestSendFailure}
	s.email = failing

	if _, err := s.SendCode("alice@example.com"); !errors.Is(err, ErrEmailSendFailed) {
		t.Fatalf("err = %v, want ErrEmailSendFailed", err)
	}

	if failing.code == "" {
		t.Fatal("sender did not receive a code")
	}

	if s.store.Codes().VerifyCode("alice@example.com", failing.code) {
		t.Fatal("code from a failed send must not be stored")
	}

	ok := &captureSender{}
	s.email = ok

	res, err := s.SendCode("alice@example.com")
	if err != nil {
		t.Fatal(err)
	}

	if res.DebugCode == "" || ok.code != res.DebugCode {
		t.Fatalf("debug code mismatch: %+v captured %q", res, ok.code)
	}

	if !s.store.Codes().VerifyCode("alice@example.com", res.DebugCode) {
		t.Fatal("code from a successful send must verify")
	}
}

// --- sync.go: [] instead of null ---

func TestSyncReturnsEmptySlicesNotNull(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if got := s.buildChats(ctx, nil, nil); got == nil {
		t.Fatal("buildChats(nil) must return [], not nil")
	}

	raw, err := json.Marshal(s.buildChats(ctx, nil, nil))
	if err != nil {
		t.Fatal(err)
	}

	if string(raw) != "[]" {
		t.Fatalf("buildChats marshals as %s, want []", raw)
	}

	resp, err := s.Sync(ctx, "ghost:localhost:8080", time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for name, msgs := range map[string][]model.Message{
		"messages": resp.Messages, "threadMessages": resp.ThreadMessages,
	} {
		if msgs == nil {
			t.Errorf("%s is nil, want []", name)
		}
	}

	if resp.Chats == nil || resp.DeletedMessages == nil || resp.DeletedChats == nil {
		t.Fatal("sync slices must be [], not nil")
	}

	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(out), ":null") {
		t.Fatalf("sync response contains null slices: %s", out)
	}
}

// --- push.go: bounded fan-out ---

func TestPushBoundedDropsWhenSaturated(t *testing.T) {
	before := DroppedPushes()

	// Occupy every slot.
	for range maxConcurrentPushes {
		pushSendSem <- struct{}{}
	}

	defer func() {
		for range maxConcurrentPushes {
			<-pushSendSem
		}
	}()

	called := make(chan struct{}, 1)

	// With a saturated semaphore the payload must be dropped, never delivered.
	done := make(chan struct{})
	go func() {
		defer close(done)
		sendPushBounded(blockingPush{ch: called}, []byte("x"), nil)
	}()

	<-done

	select {
	case <-called:
		t.Fatal("saturated sender must drop, not call")
	default:
	}

	if got := DroppedPushes(); got != before+1 {
		t.Fatalf("dropped = %d, want %d", got, before+1)
	}
}

type blockingPush struct {
	ch chan struct{}
}

func (b blockingPush) SendToUser(_ []byte, _ []model.PushSubscription) {
	close(b.ch)
}
