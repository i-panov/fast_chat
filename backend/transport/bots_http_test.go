package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fast_chat/model"
)

// A bot the user blocked must get 403, not 500: the SDK treats 500 as
// retryable and hammers the endpoint.
func TestBotApiBlockedUserIsForbidden(t *testing.T) {
	ts := newDomainTestServer(t)
	ctx := context.Background()

	owner := createTestUser(t, ts.Store)
	created, err := ts.Svc.CreateBot(ctx, owner.ID, "blocked_bot", "Blocked")
	if err != nil {
		t.Fatal(err)
	}

	view, err := ts.Svc.OpenBotChat(ctx, owner.ID, "blocked_bot")
	if err != nil {
		t.Fatal(err)
	}

	if err := ts.Svc.BlockUser(ctx, owner.ID, created.User.ID); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/bot-api/sendMessage", created.Token,
		`{"chat_id":"`+view.ID+`","text":"hello"}`))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("sendMessage = %d, want 403: %s", rec.Code, rec.Body.String())
	}
}

// A retried answerCallbackQuery is a normal conflict, not a server error: the
// query already has an answer.
func TestBotApiDuplicateCallbackAnswerIsConflict(t *testing.T) {
	ts := newDomainTestServer(t)
	ctx := context.Background()

	owner := createTestUser(t, ts.Store)
	created, err := ts.Svc.CreateBot(ctx, owner.ID, "callback_bot", "Callback")
	if err != nil {
		t.Fatal(err)
	}

	view, err := ts.Svc.OpenBotChat(ctx, owner.ID, "callback_bot")
	if err != nil {
		t.Fatal(err)
	}

	msg, err := ts.Svc.SendBotMessage(ctx, created.User.ID, view.ID, "press a button", nil)
	if err != nil {
		t.Fatal(err)
	}

	query := &model.BotCallbackQuery{
		ID: "cb-1", BotID: created.User.ID, ChatID: view.ID,
		MessageID: msg.ID, UserID: owner.ID, Data: "yes", CreatedAt: time.Now().UTC(),
	}
	if err := ts.Store.CreateBotCallbackQuery(ctx, query); err != nil {
		t.Fatal(err)
	}

	body := `{"callback_query_id":"cb-1","text":"ok","show_alert":false}`

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/bot-api/answerCallbackQuery", created.Token, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("first answer = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/bot-api/answerCallbackQuery", created.Token, body))
	if rec.Code != http.StatusConflict {
		t.Fatalf("second answer = %d, want 409: %s", rec.Code, rec.Body.String())
	}
}

// A bot file must be served with the same hardening as a user file: no inline
// HTML in the site origin.
func TestBotDownloadFileHardensTheResponse(t *testing.T) {
	ts := newDomainTestServer(t)
	ctx := context.Background()

	owner := createTestUser(t, ts.Store)
	created, err := ts.Svc.CreateBot(ctx, owner.ID, "file_bot", "Files")
	if err != nil {
		t.Fatal(err)
	}

	view, err := ts.Svc.OpenBotChat(ctx, owner.ID, "file_bot")
	if err != nil {
		t.Fatal(err)
	}

	const storagePath = "bot-file.html"
	if err := os.WriteFile(filepath.Join(ts.Cfg.Uploads.Dir, storagePath), []byte("<html></html>"), 0o600); err != nil {
		t.Fatal(err)
	}

	file, err := ts.Store.SaveFile(ctx, "hash-bot-file", "text/html", 13, "page.html", storagePath, created.User.ID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := ts.Svc.SendBotFile(ctx, created.User.ID, view.ID, file.ID, "here"); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/bot-api/files/"+file.ID, created.Token, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("download = %d: %s", rec.Code, rec.Body.String())
	}

	if got := rec.Header().Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
		t.Errorf("Content-Security-Policy = %q", got)
	}

	if got := rec.Header().Get("Content-Disposition"); len(got) < len("attachment") || got[:len("attachment")] != "attachment" {
		t.Errorf("Content-Disposition = %q, want an attachment", got)
	}

	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}
}

// The rate limiter counts requests on entry, so a second concurrent long poll
// of the same bot has to be refused explicitly.
func TestBotApiSecondLongPollIsConflict(t *testing.T) {
	ts := newDomainTestServer(t)
	ctx := context.Background()

	owner := createTestUser(t, ts.Store)
	created, err := ts.Svc.CreateBot(ctx, owner.ID, "poll_bot", "Poll")
	if err != nil {
		t.Fatal(err)
	}

	if !acquireBotPoll(created.User.ID) {
		t.Fatal("the poll slot of a fresh bot is busy")
	}
	defer releaseBotPoll(created.User.ID)

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/bot-api/getUpdates", created.Token,
		`{"offset":0,"limit":10,"timeout":0}`))

	if rec.Code != http.StatusConflict {
		t.Fatalf("getUpdates = %d, want 409: %s", rec.Code, rec.Body.String())
	}

	// A released slot is reusable.
	releaseBotPoll(created.User.ID)

	if !acquireBotPoll(created.User.ID) {
		t.Fatal("the released poll slot is not reusable")
	}
	releaseBotPoll(created.User.ID)
}
