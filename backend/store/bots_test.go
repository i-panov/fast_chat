package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

func TestBotStoreLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	owner := createTestUser(t, s, "alice")
	botUser := createTestUser(t, s, "weather_bot")
	botUser.IsBot = true
	if err := s.DB().Model(&model.User{}).Where("id = ?", botUser.ID).Update("is_bot", true).Error; err != nil {
		t.Fatal(err)
	}

	chat, err := s.CreateChat(ctx, owner.ID, botUser.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	bot := &model.Bot{
		UserID: botUser.ID, OwnerID: owner.ID,
		TokenHash: "hash-1", TokenPrefix: "fcb_1",
		EncryptionMode: "server", IsActive: true,
		CreatedAt: time.Now().UTC(),
	}
	if err := s.CreateBot(ctx, bot, chat); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.GetBot(ctx, botUser.ID); !ok {
		t.Fatal("bot not found")
	}
	if _, ok := s.GetBotByTokenHash(ctx, "hash-1"); !ok {
		t.Fatal("token lookup failed")
	}
	if botChat, ok := s.GetBotChat(ctx, botUser.ID, owner.ID); !ok || botChat.ChatID != chat.ID {
		t.Fatalf("bot chat = %+v ok=%v", botChat, ok)
	}

	update, err := s.AppendBotUpdate(ctx, botUser.ID, "message", `{"x":1}`)
	if err != nil {
		t.Fatal(err)
	}
	if update.ID == 0 {
		t.Fatal("update id is zero")
	}
	updates, err := s.GetBotUpdates(ctx, botUser.ID, update.ID, 10)
	if err != nil || len(updates) != 1 {
		t.Fatalf("updates = %+v err=%v", updates, err)
	}

	cb := &model.BotCallbackQuery{
		ID: "cb-1", BotID: botUser.ID, ChatID: chat.ID,
		MessageID: "m1", UserID: owner.ID, Data: "yes", CreatedAt: time.Now().UTC(),
	}
	if err := s.CreateBotCallbackQuery(ctx, cb); err != nil {
		t.Fatal(err)
	}
	if err := s.AnswerBotCallbackQuery(ctx, "cb-1", botUser.ID, "ok", false); err != nil {
		t.Fatal(err)
	}
	if err := s.AnswerBotCallbackQuery(ctx, "cb-1", botUser.ID, "again", false); err == nil {
		t.Fatal("double answer must fail")
	}
}

// An explicit state change supersedes the ban marker. Otherwise an unban
// later resurrects a bot that an admin had just switched off.
func TestSetBotActiveClearsTheBanMarker(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	owner := createTestUser(t, s, "alice")
	botUser := createTestUser(t, s, "status_bot")

	bot := &model.Bot{
		UserID: botUser.ID, OwnerID: owner.ID,
		TokenHash: "hash-status", TokenPrefix: "fcb_2",
		EncryptionMode: "server", IsActive: true, DisabledByBan: true,
		CreatedAt: time.Now().UTC(),
	}
	if err := s.CreateBot(ctx, bot, nil); err != nil {
		t.Fatal(err)
	}

	if err := s.SetBotActive(ctx, botUser.ID, false, nil); err != nil {
		t.Fatal(err)
	}

	stored, ok := s.GetBot(ctx, botUser.ID)
	if !ok {
		t.Fatal("bot not found")
	}

	if stored.IsActive {
		t.Fatal("the bot is still active")
	}

	if stored.DisabledByBan {
		t.Fatal("an explicit disable kept the ban marker; a later unban would resurrect the bot")
	}
}
