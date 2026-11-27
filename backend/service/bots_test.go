package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"fast_chat/model"
)

func v3TestPayload() string {
	nonce := base64.RawURLEncoding.EncodeToString(make([]byte, 24))
	box := base64.RawURLEncoding.EncodeToString(make([]byte, 48))
	sender := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	identity := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	signature := base64.RawURLEncoding.EncodeToString(make([]byte, 64))
	return fmt.Sprintf(
		`{"v":3,"nonce":%q,"senderKey":%q,"identityKey":%q,"identitySig":%q,"envelopes":[{"keyId":"u1","keyVersion":1,"box":%q,"nonce":%q}]}`,
		nonce, sender, identity, signature, box, nonce,
	)
}

func TestBotChatRoundTrip(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	created, err := s.CreateBot(ctx, owner.ID, "weather_bot", "Погода")
	if err != nil {
		t.Fatal(err)
	}
	if created.Token == "" || created.User.IsBot != true {
		t.Fatalf("created bot = %+v", created)
	}
	if _, _, ok := s.GetBotByToken(ctx, created.Token); !ok {
		t.Fatal("token does not resolve")
	}

	view, err := s.OpenBotChat(ctx, owner.ID, "weather_bot")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Members) != 2 || view.BotID == "" {
		t.Fatalf("bot chat = %+v", view)
	}

	msg, err := s.SendMessage(ctx, &model.Chat{ID: view.ID, Type: "private", Members: []string{owner.ID, created.User.ID}, BotID: created.User.ID}, "", owner.ID, "alice", &SendMessageInput{Text: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Text != "hello" {
		t.Fatalf("message = %+v", msg)
	}

	updates, err := s.PollBotUpdates(ctx, created.User.ID, 0, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(updates) != 1 || updates[0].Type != "message" {
		t.Fatalf("updates = %+v", updates)
	}

	reply, err := s.SendBotMessage(ctx, created.User.ID, view.ID, "hello from bot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Text != "hello from bot" || reply.FromID != created.User.ID {
		t.Fatalf("reply = %+v", reply)
	}
}

func TestRootBotCreatesBot(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.EnsureMasterBot(ctx); err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, MasterBotUsername)
	if err != nil {
		t.Fatal(err)
	}
	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("root chat missing")
	}
	send := func(text string) {
		t.Helper()
		if _, err := s.SendMessage(ctx, chat, "", owner.ID, "alice", &SendMessageInput{Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	send("/newbot")
	send("Погода")
	send("weather_bot")

	bots, err := s.store.ListBotsByOwner(ctx, owner.ID)
	if err != nil || len(bots) != 1 {
		t.Fatalf("bots = %+v err=%v", bots, err)
	}
}

func TestBotInlineCallback(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "weather_bot", "Погода")
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "weather_bot")
	if err != nil {
		t.Fatal(err)
	}
	markup := &model.InlineKeyboardMarkup{InlineKeyboard: [][]model.InlineKeyboardButton{{
		{Text: "Да", CallbackData: "yes"},
	}}}
	msg, err := s.SendBotMessage(ctx, created.User.ID, view.ID, "Выбери", markup)
	if err != nil {
		t.Fatal(err)
	}
	if msg.ReplyMarkup == nil {
		t.Fatal("markup not stored")
	}
	q, err := s.CreateBotCallback(ctx, owner.ID, view.ID, msg.ID, "yes")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AnswerBotCallback(ctx, created.User.ID, q.ID, "ok", false, false, ""); err != nil {
		t.Fatal(err)
	}
}

func TestBotEditAndDeleteOwnMessage(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "edit_bot", "Edit")
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "edit_bot")
	if err != nil {
		t.Fatal(err)
	}
	msg, err := s.SendBotMessage(ctx, created.User.ID, view.ID, "before", nil)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := s.EditBotMessage(ctx, created.User.ID, view.ID, msg.ID, "after", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Text != "after" {
		t.Fatalf("edited text = %q", updated.Text)
	}
	if err := s.DeleteBotMessage(ctx, created.User.ID, view.ID, msg.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.GetMessage(ctx, view.ID, msg.ID); err == nil {
		t.Fatal("deleted message still exists")
	}
}

func TestCreatePrivateChatRoutesToBot(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "route_bot", "Route")
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.CreatePrivateChat(ctx, owner.ID, created.User.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !view.IsBotChat || view.BotID != created.User.ID {
		t.Fatalf("view = %+v", view)
	}
}

func TestCreatePrivateChatIgnoresBotFlagForHuman(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	view, err := s.CreatePrivateChat(ctx, alice.ID, bob.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if view.IsBotChat || view.BotID != "" || view.BotEncryptionMode != "" {
		t.Fatalf("human chat was marked as a bot chat: %+v", view)
	}

	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("chat missing")
	}
	if chat.BotID != "" || chat.BotEncryptionMode != "" {
		t.Fatalf("stored chat was poisoned: botID=%q mode=%q", chat.BotID, chat.BotEncryptionMode)
	}
}

func TestBotEncryptionMode(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "crypto_bot", "Crypto")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetBotEncryptionKey(ctx, created.User.ID, "cHVibGlj", "aWRlbnRpdHk="); err != nil {
		t.Fatal(err)
	}
	bot, ok := s.store.GetBot(ctx, created.User.ID)
	if !ok || bot.EncryptionMode != "e2ee" {
		t.Fatalf("bot = %+v", bot)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "crypto_bot")
	if err != nil {
		t.Fatal(err)
	}
	if view.BotEncryptionMode != "e2ee" {
		t.Fatalf("mode = %q", view.BotEncryptionMode)
	}
	payload := v3TestPayload()
	msg, err := s.SendBotEncryptedMessageWithID(ctx, created.User.ID, view.ID, "test-encrypted-id", "ciphertext", payload)
	if err != nil {
		t.Fatal(err)
	}
	if !msg.Encrypted || msg.Text != "ciphertext" {
		t.Fatalf("msg = %+v", msg)
	}
}

func TestBotUpdateCarriesEncryptionAndAuthor(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "update_bot", "Update")
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "update_bot")
	if err != nil {
		t.Fatal(err)
	}
	msg := &model.Message{
		ID: "m1", ChatID: view.ID, FromID: owner.ID, FromNick: "Alice",
		Text: "cipher", Encrypted: true, EncryptedPayload: `{"v":1}`,
		CreatedAt: time.Now().UTC(),
	}
	s.AppendBotMessageUpdate(ctx, view.ID, msg)
	updates, err := s.PollBotUpdates(ctx, created.User.ID, 0, 10, 0)
	if err != nil || len(updates) != 1 {
		t.Fatalf("updates = %v err=%v", updates, err)
	}
	if !strings.Contains(updates[0].Payload, `"encrypted_payload":"{\"v\":1}"`) {
		t.Fatalf("payload = %s", updates[0].Payload)
	}
	if !strings.Contains(updates[0].Payload, `"username":"alice"`) ||
		!strings.Contains(updates[0].Payload, `"is_bot":false`) {

		t.Fatalf("from payload = %s", updates[0].Payload)
	}
}

func TestBotSendsFileAndLocation(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "media_bot", "Media")
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "media_bot")
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.store.SaveFile(ctx, "hash", "text/plain", 5, "a.txt", "a.txt", created.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	withFile, err := s.SendBotFile(ctx, created.User.ID, view.ID, file.ID, "caption")
	if err != nil {
		t.Fatal(err)
	}
	if len(withFile.Files) != 1 || withFile.Files[0].OriginalName != "a.txt" {
		t.Fatalf("files = %+v", withFile.Files)
	}
	withLocation, err := s.SendBotLocation(ctx, created.User.ID, view.ID, 55.75, 37.61)
	if err != nil {
		t.Fatal(err)
	}
	if withLocation.Location == nil || withLocation.Location.Lat != 55.75 {
		t.Fatalf("location = %+v", withLocation.Location)
	}
}

func TestBotE2EEFileEnforcement(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "files@test.local", "files", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateBot(ctx, owner.ID, "files_bot", "Files")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetBotEncryptionKey(ctx, created.User.ID, "cHVibGlj", "aWRlbnRpdHk="); err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenBotChat(ctx, owner.ID, "files_bot")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := s.store.SaveFileEncrypted(ctx, "plain-hash", "text/plain", 4, "a.txt", "a.txt", created.User.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := s.store.SaveFileEncrypted(ctx, "enc-hash", "text/plain", 4, "b.txt", "b.txt", created.User.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	payload := v3TestPayload()
	if _, err := s.SendBotMessageWithFiles(ctx, created.User.ID, view.ID, "x", nil, []string{plaintext.ID}, true, payload, nil); err == nil {
		t.Fatal("plaintext file accepted in e2ee bot chat")
	}
	if _, err := s.SendBotMessageWithFiles(ctx, created.User.ID, view.ID, "x", nil, []string{encrypted.ID}, true, payload, nil); err != nil {
		t.Fatalf("encrypted file rejected: %v", err)
	}
}

// fakeFileFederation answers every signed request with the canned bytes of a
// remote file and records the URL, so the test sees which endpoint the
// placeholder is fetched from.
type fakeFileFederation struct {
	body     []byte
	requests []string
}

func (f *fakeFileFederation) URL(remoteServer, path string) string {
	return "https://" + remoteServer + path
}

func (f *fakeFileFederation) Request(_ context.Context, _, urlStr string, _ any) ([]byte, error) {
	f.requests = append(f.requests, urlStr)

	return f.body, nil
}

func TestFetchFederatedBotFile(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	remote := &model.File{
		ID:           "remote-file-1",
		Hash:         "remote-hash",
		MimeType:     "image/png",
		Size:         4,
		OriginalName: "photo.png",
		UploadedBy:   "bob:remote.test",
		RemoteServer: "remote.test",
	}
	if err := s.store.CreateRemoteFile(ctx, remote); err != nil {
		t.Fatal(err)
	}

	fed := &fakeFileFederation{body: []byte("data")}
	s.SetFederationClient(fed)

	body, file, err := s.FetchFederatedFile(ctx, remote.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "data" || file.ID != remote.ID || file.RemoteServer != "remote.test" {
		t.Fatalf("body=%q file=%+v", body, file)
	}
	if len(fed.requests) != 1 || fed.requests[0] != "https://remote.test/api/federated/files/"+remote.ID {
		t.Fatalf("federation requests = %v", fed.requests)
	}

	// A local file is not fetched from a peer: its bytes are on this server.
	local, err := s.store.SaveFile(ctx, "local-hash", "text/plain", 5, "a.txt", "a.txt", "alice:localhost:8080")
	if err != nil {
		t.Fatal(err)
	}
	body, file, err = s.FetchFederatedFile(ctx, local.ID)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil || file.ID != local.ID || file.RemoteServer != "" {
		t.Fatalf("local body=%q file=%+v", body, file)
	}
	if len(fed.requests) != 1 {
		t.Fatalf("a local file must not call the peer: %v", fed.requests)
	}

	// Without a federated client the placeholder cannot be resolved.
	s.SetFederationClient(nil)
	if _, _, err := s.FetchFederatedFile(ctx, remote.ID); !errors.Is(err, ErrFileNotFound) {
		t.Fatalf("err = %v, want ErrFileNotFound", err)
	}
}
