package service

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"

	"fast_chat/model"
)

// maxConcurrentPushes bounds the push fan-out: every SendToUser walks its
// subscriptions sequentially with a 10s HTTP timeout each, so an unbounded
// burst of goroutines would pile up for the sum of those timeouts.
const maxConcurrentPushes = 8

var (
	pushSendSem      = make(chan struct{}, maxConcurrentPushes)
	droppedPushCount atomic.Int64
)

// DroppedPushes reports how many push fan-outs were dropped because the sender
// was saturated.
func DroppedPushes() int64 {
	return droppedPushCount.Load()
}

// sendPushBounded delivers a push payload without letting a burst of messages
// spawn an unbounded number of goroutines. When all slots are busy the push
// is dropped and counted instead of queued forever.
func sendPushBounded(ps pushSender, payload []byte, subs []model.PushSubscription) {
	select {
	case pushSendSem <- struct{}{}:
		go func() {
			defer func() { <-pushSendSem }()
			ps.SendToUser(payload, subs)
		}()
	default:
		droppedPushCount.Add(1)
		log().Warn("push dropped: sender saturated")
	}
}

// PushPayload is the WebPush notification payload sent to clients.
type PushPayload struct {
	Title string          `json:"title"`
	Body  string          `json:"body,omitempty"`
	Tag   string          `json:"tag"`
	Data  PushPayloadData `json:"data"`
}

// PushPayloadData carries the deep-link target of a push notification.
type PushPayloadData struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	ThreadID  string `json:"threadId,omitempty"`
}

// pushEndpointHosts are the push services a browser subscription may point
// at.
var pushEndpointHosts = []string{
	"fcm.googleapis.com",                // Chrome, Edge on Android
	"updates.push.services.mozilla.com", // Firefox
	"push.services.mozilla.com",         // Firefox
	"web.push.apple.com",                // Safari
}

// pushEndpointHostSuffixes cover the hosts with a regional prefix, like the
// Windows push service (wns2-pn1p.notify.windows.com).
var pushEndpointHostSuffixes = []string{
	".notify.windows.com",
}

// IsValidPushEndpoint reports whether the endpoint belongs to a trusted push
// service. The allowlist blocks an attacker from pointing push subscriptions
// at an arbitrary URL.
//
// The check is on the host of the parsed URL, not on a prefix of the string:
// a prefix comparison would accept a lookalike host such as
// "fcm.googleapis.com.attacker.test" and turn the push sender into a request
// forwarder for arbitrary addresses.
func IsValidPushEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return false
	}

	if parsed.Scheme != "https" {
		return false
	}

	host := parsed.Hostname()
	if host == "" {
		return false
	}

	if slices.Contains(pushEndpointHosts, host) {
		return true
	}

	for _, suffix := range pushEndpointHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}

	return false
}

// SendPushForMessage sends a push notification for a message to an offline
// recipient. It is a no-op when push is disabled or the recipient is online.
func (s *Service) SendPushForMessage(
	ctx context.Context,
	chat *model.Chat,
	msg *model.Message,
	threadID,
	recipientID string,
) {

	if s.push == nil || s.store.IsOnline(recipientID) {
		return
	}

	payload := PushPayload{
		Title: msg.FromNick,
		// The server does not know the recipient's language and the
		// message content is E2E-encrypted anyway; keep the body empty
		// so the notification is just the sender's nickname.
		Tag: "chat-" + chat.ID,
		Data: PushPayloadData{
			ChatID:    chat.ID,
			MessageID: msg.ID,
			ThreadID:  threadID,
		},
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}

	subs, err := s.store.GetPushSubscriptionsByUser(ctx, recipientID)
	if err != nil || len(subs) == 0 {
		return
	}

	sendPushBounded(s.push, raw, subs)
}
