package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"fast_chat/service"
)

func authed(hh *Handler, route func(http.ResponseWriter, *http.Request), token, body string) *httptest.ResponseRecorder {
	req := authReq(http.MethodPost, "/api/push/subscribe", token, body)
	w := httptest.NewRecorder()
	hh.AuthMiddleware(route)(w, req)
	return w
}

func TestIsValidPushEndpoint(t *testing.T) {
	cases := map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc123":              true,
		"https://updates.push.services.mozilla.com/wpush/v2/gAAA": true,
		"https://push.apple.com/abc/def":                          true,
		"http://fcm.googleapis.com/foo":                           false, // http, not https
		"https://fcm.googleapis.com":                              false, // no trailing path
		"https://evil.com/fcm.googleapis.com/":                    false, // prefix after the host
		"https://example.com/push":                                false,
		"":                                                        false,
	}

	for in, want := range cases {
		if got := service.IsValidPushEndpoint(in); got != want {
			t.Errorf("IsValidPushEndpoint(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestSubscribePush(t *testing.T) {
	valid := `{"endpoint":"https://fcm.googleapis.com/fcm/send/xyz","p256dh":"dGVzdA==","auth":"aHVl"}`

	t.Run("missing fields", func(t *testing.T) {
		h := newTestHandler(t)
		user := registerTestUser(t, h, "pushy", "pushy@test.local")

		w := authed(h, h.SubscribePush, user.token, `{"endpoint":""}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("invalid endpoint", func(t *testing.T) {
		h := newTestHandler(t)
		user := registerTestUser(t, h, "pushy", "pushy@test.local")

		w := authed(h, h.SubscribePush, user.token, `{"endpoint":"https://evil.com/p","p256dh":"dGVzdA==","auth":"aHVl"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("valid subscription", func(t *testing.T) {
		h := newTestHandler(t)
		user := registerTestUser(t, h, "pushy", "pushy@test.local")

		w := authed(h, h.SubscribePush, user.token, valid)
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}

		subs, err := h.store.GetPushSubscriptionsByUser(context.Background(), user.id)
		if err != nil {
			t.Fatal(err)
		}
		if len(subs) != 1 || subs[0].Endpoint != "https://fcm.googleapis.com/fcm/send/xyz" {
			t.Errorf("unexpected subscriptions: %+v", subs)
		}
	})

	t.Run("re-subscribe keeps single record", func(t *testing.T) {
		h := newTestHandler(t)
		user := registerTestUser(t, h, "pushy", "pushy@test.local")

		if w := authed(h, h.SubscribePush, user.token, valid); w.Code != http.StatusCreated {
			t.Fatalf("first subscribe: expected 201, got %d", w.Code)
		}
		if w := authed(h, h.SubscribePush, user.token, valid); w.Code != http.StatusCreated {
			t.Fatalf("re-subscribe: expected 201, got %d", w.Code)
		}

		subs, _ := h.store.GetPushSubscriptionsByUser(context.Background(), user.id)
		if len(subs) != 1 {
			t.Errorf("expected single subscription, got %d", len(subs))
		}
	})
}

func TestUnsubscribePush(t *testing.T) {
	h := newTestHandler(t)
	user := registerTestUser(t, h, "pushy3", "pushy3@test.local")

	if _, err := h.store.AddPushSubscription(context.Background(), user.id, "https://fcm.googleapis.com/fcm/send/xyz", "dGVzdA==", "aHVl"); err != nil {
		t.Fatal(err)
	}

	before, _ := h.store.GetPushSubscriptionsByUser(context.Background(), user.id)
	if len(before) != 1 {
		t.Fatalf("sanity: want 1 subscription, got %d", len(before))
	}

	w := authed(h, h.UnsubscribePush, user.token, `{"endpoint":"https://fcm.googleapis.com/fcm/send/xyz"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	after, _ := h.store.GetPushSubscriptionsByUser(context.Background(), user.id)
	if len(after) != 0 {
		t.Errorf("subscription should be removed, got %d", len(after))
	}
}
