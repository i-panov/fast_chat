package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

func TestMasterBotMigratesLegacyIdentity(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	legacyID := legacyMasterBotUsername + ":" + s.ServerDomain()
	owner, _ := newAdminUser(t, s, "alice")

	legacy := &model.User{
		ID: legacyID, Email: "bot+legacy@bots.local",
		Username: legacyMasterBotUsername, DisplayName: "Fast Chat Bot", IsBot: true,
	}
	if err := s.store.CreateBotUser(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	if err := s.store.CreateBot(ctx, &model.Bot{
		UserID: legacyID, TokenHash: "legacy-hash", TokenPrefix: "legacy",
		EncryptionMode: EncryptionModeServer, IsActive: true, IsMaster: true,
	}, nil); err != nil {
		t.Fatal(err)
	}
	chat, err := s.store.CreateChat(ctx, owner.ID, legacyID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.SetChatBot(ctx, chat.ID, legacyID, EncryptionModeServer); err != nil {
		t.Fatal(err)
	}
	if err := s.store.CreateBotChat(ctx, legacyID, owner.ID, chat.ID); err != nil {
		t.Fatal(err)
	}
	msg, _, err := s.store.AddMessage(ctx, chat.ID, "", legacyID, "bot", "hello", "m1", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.DB().WithContext(ctx).Create(&model.MessageReadStatus{
		MessageID: msg.ID, UserID: legacyID, Status: "read", ReadAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.EnsureMasterBot(ctx); err != nil {
		t.Fatal(err)
	}

	newID := s.masterBotUserID()
	if _, ok := s.store.GetUserByID(ctx, legacyID); ok {
		t.Fatal("legacy bot user survived the rename")
	}
	user, ok := s.store.GetUserByID(ctx, newID)
	if !ok || user.Username != MasterBotUsername || user.DisplayName != masterBotDisplayName {
		t.Fatalf("new bot user = %+v ok=%v", user, ok)
	}
	if bot, ok := s.store.GetBot(ctx, newID); !ok || !bot.IsMaster {
		t.Fatalf("new bot = %+v ok=%v", bot, ok)
	}
	if renamed, ok := s.store.GetChat(ctx, chat.ID); !ok || renamed.BotID != newID {
		t.Fatalf("chat after rename = %+v ok=%v", renamed, ok)
	}
	if _, ok := s.store.GetBotChat(ctx, newID, owner.ID); !ok {
		t.Fatal("bot chat was not moved to the new id")
	}
	if moved, err := s.store.GetMessage(ctx, chat.ID, msg.ID); err != nil || moved.FromID != newID {
		t.Fatalf("message after rename = %+v err=%v", moved, err)
	}
	var read model.MessageReadStatus
	if err := s.store.DB().WithContext(ctx).
		Where("message_id = ? AND user_id = ?", msg.ID, newID).
		First(&read).Error; err != nil {
		t.Fatalf("read status was not migrated: %v", err)
	}
}

func TestMasterBotRefusesNameTakenByAnotherAccount(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(
		ctx, "human@example.test", MasterBotUsername, s.ServerDomain(), time.Hour,
	); err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.EnsureMasterBot(ctx); !errors.Is(err, store.ErrMasterBotNameTaken) {
		t.Fatalf("err = %v, want ErrMasterBotNameTaken", err)
	}
}

func TestMasterBotRefusesAnotherUsersBotWithTheName(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, _ := newAdminUser(t, s, "alice")
	takenID := MasterBotUsername + ":" + s.ServerDomain()

	squatter := &model.User{
		ID: takenID, Email: "squatter@example.test", Username: MasterBotUsername,
		DisplayName: "Squatter", IsBot: true,
	}
	if err := s.store.CreateBotUser(ctx, squatter); err != nil {
		t.Fatal(err)
	}
	if err := s.store.CreateBot(ctx, &model.Bot{
		UserID: takenID, OwnerID: owner.ID, TokenHash: "squatter-hash", TokenPrefix: "squat",
		EncryptionMode: EncryptionModeServer, IsActive: true, IsMaster: false,
	}, nil); err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.EnsureMasterBot(ctx); !errors.Is(err, store.ErrMasterBotNameTaken) {
		t.Fatalf("err = %v, want ErrMasterBotNameTaken", err)
	}
}

func TestBotNamesOfTheBuiltInBotAreReserved(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, _ := newAdminUser(t, s, "alice")

	for _, username := range []string{MasterBotUsername, legacyMasterBotUsername} {
		if _, err := s.CreateBot(ctx, owner.ID, username, "Taken"); !errors.Is(err, ErrBotUsernameReserved) {
			t.Fatalf("CreateBot(%q) err = %v, want ErrBotUsernameReserved", username, err)
		}
	}
}

func TestPresenceEventsStayOrderedAgainstAnExpiredSweep(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, _ := newAdminUser(t, s, "alice")
	created, err := s.CreateBot(ctx, owner.ID, "weather_bot", "Weather")
	if err != nil {
		t.Fatal(err)
	}
	// The status broadcast only reaches accounts that share a chat with the
	// bot: open one, exactly as a client would before seeing the dot.
	if _, err := s.OpenBotChat(ctx, owner.ID, "weather_bot"); err != nil {
		t.Fatal(err)
	}

	rec := &presenceOrderRecorder{svc: s, bot: created.Bot}
	s.events = rec

	s.TouchBotActivity(ctx, created.Bot)
	if len(rec.snapshot()) != 1 {
		t.Fatalf("the online transition was not broadcast: %v", rec.snapshot())
	}

	// While the sweep announces the expiry, a live bot touches the API. The
	// transition and its event must be one critical section: the touch may
	// not complete inside the sweep (that is what let a stale offline event
	// land last before), and its online event must be the last one.
	done := make(chan struct{})
	rec.onFirstOffline = func() {
		go func() {
			defer close(done)
			rec.svc.TouchBotActivity(context.Background(), rec.bot)
		}()
		select {
		case <-done:
			rec.mu.Lock()
			rec.touchCompletedInsideSweep = true
			rec.mu.Unlock()
		case <-time.After(100 * time.Millisecond):
		}
	}
	s.ExpireInactiveBots(ctx, time.Now().UTC().Add(BotOnlineWindow+time.Minute), BotOnlineWindow)
	<-done

	rec.mu.Lock()
	completedInside, events := rec.touchCompletedInsideSweep, append([]bool(nil), rec.onlines...)
	rec.mu.Unlock()

	if completedInside {
		t.Fatal("the sweep released its lock before finishing the offline broadcast")
	}
	if !s.store.IsOnline(created.User.ID) {
		t.Fatal("a live bot ended offline in the store")
	}
	if len(events) == 0 || events[len(events)-1] != true {
		t.Fatalf("event order = %v, want the last one online", events)
	}
}

type presenceOrderRecorder struct {
	mu                        sync.Mutex
	onlines                   []bool
	svc                       *Service
	bot                       *model.Bot
	fired                     bool
	touchCompletedInsideSweep bool
	onFirstOffline            func()
}

func (r *presenceOrderRecorder) Send(_ string, event sse.Event) {
	if event.Event != "user_status_changed" {
		return
	}

	online := false
	if data, ok := event.Data.(map[string]any); ok {
		online, _ = data["online"].(bool)
	}
	r.mu.Lock()
	r.onlines = append(r.onlines, online)
	firstOffline := !online && !r.fired
	if firstOffline {
		r.fired = true
	}
	hook := r.onFirstOffline
	r.mu.Unlock()

	if firstOffline && hook != nil {
		hook()
	}
}

func (r *presenceOrderRecorder) snapshot() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return append([]bool(nil), r.onlines...)
}

func TestBotPollTimeoutStaysBelowThePresenceWindow(t *testing.T) {
	if MaxBotPollTimeout >= BotOnlineWindow {
		t.Fatalf("MaxBotPollTimeout=%v must be below BotOnlineWindow=%v", MaxBotPollTimeout, BotOnlineWindow)
	}
}

func TestExternalBotPresenceExpires(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, _ := newAdminUser(t, s, "alice")
	created, err := s.CreateBot(ctx, owner.ID, "weather_bot", "Weather")
	if err != nil {
		t.Fatal(err)
	}

	s.TouchBotActivity(ctx, created.Bot)
	if !s.store.IsOnline(created.User.ID) {
		t.Fatal("bot is not online after an API request")
	}

	// The root bot lives in-process and must never expire.
	_, rootUser, err := s.EnsureMasterBot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !s.store.IsOnline(rootUser.ID) {
		t.Fatal("root bot is not online")
	}

	s.ExpireInactiveBots(ctx, time.Now().UTC().Add(BotOnlineWindow+time.Minute), BotOnlineWindow)
	if s.store.IsOnline(created.User.ID) {
		t.Fatal("inactive external bot stayed online")
	}
	if !s.store.IsOnline(rootUser.ID) {
		t.Fatal("root bot expired")
	}
}

//nolint:gocyclo // one scenario covers the menu, callback, cancel and help paths.
func TestRootBotMenuButtonsAndCancel(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, _ := newAdminUser(t, s, "alice")
	if _, _, err := s.EnsureMasterBot(ctx); err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, MasterBotUsername)
	if err != nil {
		t.Fatal(err)
	}
	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("chat missing")
	}
	bot, _, err := s.EnsureMasterBot(ctx)
	if err != nil {
		t.Fatal(err)
	}

	s.HandleRootBotCommand(ctx, chat, &model.Message{FromID: owner.ID, Text: "/start"})
	// The reply is the last bot message; fetch it through the chat page.
	messages, _, _, err := s.store.GetMessagesPaginatedE(ctx, chat.ID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	var menu *model.Message
	for i := range messages {
		if messages[i].FromID == bot.UserID && messages[i].ReplyMarkup != nil {
			menu = &messages[i]
		}
	}
	if menu == nil {
		t.Fatal("greeting has no inline keyboard")
	}
	if len(menu.ReplyMarkup.InlineKeyboard) != 3 {
		t.Fatalf("menu rows = %d", len(menu.ReplyMarkup.InlineKeyboard))
	}
	if !strings.Contains(menu.Text, "Root Bot") || strings.Contains(menu.Text, "Привет") {
		t.Fatalf("greeting = %q, want English", menu.Text)
	}

	// Press "Create a bot": the root bot handles the callback in-process and
	// switches to the display-name step.
	callbackMsg := menu
	if _, err := s.CreateBotCallback(ctx, owner.ID, chat.ID, callbackMsg.ID, rootCallbackNewBot); err != nil {
		t.Fatal(err)
	}
	state, ok := s.store.GetBotFatherState(ctx, owner.ID)
	if !ok || state.Step != "newbot_display_name" {
		t.Fatalf("state = %+v ok=%v", state, ok)
	}
	if updates, err := s.store.GetBotUpdates(ctx, bot.UserID, 0, 10); err != nil {
		t.Fatal(err)
	} else if len(updates) != 0 {
		t.Fatalf("root callback was queued: %+v", updates)
	}

	// The inline Cancel button is context-aware too.
	prompt, _, _, err := s.store.GetMessagesPaginatedE(ctx, chat.ID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	var cancelMessage *model.Message
	for i := range prompt {
		if prompt[i].ReplyMarkup != nil {
			cancelMessage = &prompt[i]
		}
	}
	if cancelMessage == nil {
		t.Fatal("cancel prompt missing")
	}
	if _, err := s.CreateBotCallback(ctx, owner.ID, chat.ID, cancelMessage.ID, rootCallbackCancel); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.store.GetBotFatherState(ctx, owner.ID); ok {
		t.Fatal("state survived the inline cancel")
	}
	if _, err := s.CreateBotCallback(ctx, owner.ID, chat.ID, cancelMessage.ID, rootCallbackCancel); err != nil {
		t.Fatal(err)
	}
	messages, _, _, err = s.store.GetMessagesPaginatedE(ctx, chat.ID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	last := messages[len(messages)-1]
	if !strings.Contains(last.Text, "Nothing to cancel") {
		t.Fatalf("second inline cancel = %q", last.Text)
	}

	s.HandleRootBotCommand(ctx, chat, &model.Message{FromID: owner.ID, Text: "/cancel"})
	state, ok = s.store.GetBotFatherState(ctx, owner.ID)
	if ok {
		t.Fatalf("state survived cancel: %+v", state)
	}
	// Outside a flow the command must not claim that something was cancelled.
	s.HandleRootBotCommand(ctx, chat, &model.Message{FromID: owner.ID, Text: "/cancel"})
	messages, _, _, err = s.store.GetMessagesPaginatedE(ctx, chat.ID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	last = messages[len(messages)-1]
	if last.FromID != bot.UserID || !strings.Contains(last.Text, "Nothing to cancel") {
		t.Fatalf("last reply = %+v", last)
	}
}
