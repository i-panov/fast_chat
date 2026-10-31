package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"fast_chat/calls"
	"fast_chat/config"
)

// fakeFed records the federated requests the service makes. URL mimics
// federation.Client by prefixing the scheme and the remote server.
type fakeFed struct {
	mu           sync.Mutex
	lastMethod   string
	lastURL      string
	lastBody     any
	responseBody []byte
	err          error
}

func (f *fakeFed) URL(remoteServer, path string) string {
	return "https://" + remoteServer + path
}

func (f *fakeFed) Request(_ context.Context, method, urlStr string, body any) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.lastMethod = method
	f.lastURL = urlStr
	f.lastBody = body

	return f.responseBody, f.err
}

func (f *fakeFed) lastRequest() (method, urlStr string, body any) {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.lastMethod, f.lastURL, f.lastBody
}

func newFederatedCallService(t *testing.T, fed *fakeFed) (*Service, *eventRecorder) {
	t.Helper()

	s, recorder := newCallService(t)
	s.SetFederationClient(fed)

	return s, recorder
}

func TestStartCallInvitesTheRemoteServer(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newFederatedCallService(t, fed)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatalf("StartCall federated: %v", err)
	}

	if call == nil {
		t.Fatal("expected a call")
	}

	method, urlStr, body := fed.lastRequest()

	if method != "POST" {
		t.Fatalf("method = %q, want POST", method)
	}

	if !strings.Contains(urlStr, "/api/federated/calls/invite") {
		t.Fatalf("url = %q, want it to contain /api/federated/calls/invite", urlStr)
	}

	payload, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v, want a map", body)
	}

	if payload["callId"] != call.ID || payload["offer"] != "offer" {
		t.Fatalf("body = %#v, want the call id and the offer", payload)
	}

	if _, ok := payload["iceServers"]; !ok {
		t.Fatalf("body = %#v, want iceServers", payload)
	}
}

func TestStartCallEndsTheCallWhenTheInviteFails(t *testing.T) {
	fed := &fakeFed{err: errTestSendFailure}
	s, _ := newFederatedCallService(t, fed)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	if _, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer"); err == nil {
		t.Fatal("expected the invite error")
	}

	_, _, body := fed.lastRequest()

	payload, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v, want a map", body)
	}

	callID, _ := payload["callId"].(string)
	if callID == "" {
		t.Fatalf("body = %#v, want a call id", payload)
	}

	stored, ok := s.calls.Get(callID)
	if !ok {
		t.Fatal("the failed call is gone")
	}

	if stored.State != calls.StateEnded {
		t.Fatalf("state = %q, want ended", stored.State)
	}
}

func TestHandleFederatedInviteReservesAndNotifies(t *testing.T) {
	fed := &fakeFed{}
	s, recorder := newFederatedCallService(t, fed)
	s.cfg.Server.Domain = "remote.test"
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	if err := s.HandleFederatedInvite(ctx, "localhost:8080", "call-1", chatID, "alice:localhost:8080", "bob:remote.test", "offer", nil); err != nil {
		t.Fatalf("HandleFederatedInvite: %v", err)
	}

	if _, ok := s.calls.GetFederated("call-1"); !ok {
		t.Fatal("the shadow is missing")
	}

	for _, e := range recorder.all() {
		if e.Event.Event != "call_incoming" || e.UserID != "bob:remote.test" {
			continue
		}

		data, ok := e.Event.Data.(map[string]any)
		if !ok {
			t.Fatalf("data = %#v, want a map", e.Event.Data)
		}

		if data["federated"] != true || data["owner"] != "localhost:8080" {
			t.Fatalf("data = %#v, want federated with the owner", data)
		}

		return
	}

	t.Fatalf("no federated call_incoming: %+v", recorder.all())
}

// newProxiedCallService builds server B: its domain is remote.test, so a call
// owned by localhost:8080 arrives as a shadow for the local callee.
func newProxiedCallService(t *testing.T, fed *fakeFed, callID string) (*Service, string) {
	t.Helper()

	s, _ := newFederatedCallService(t, fed)
	s.cfg.Server.Domain = "remote.test"
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	if err := s.HandleFederatedInvite(ctx, "localhost:8080", callID, chatID, "alice:localhost:8080", "bob:remote.test", "offer", nil); err != nil {
		t.Fatalf("HandleFederatedInvite: %v", err)
	}

	return s, chatID
}

func TestAcceptCallForwardsTheShadowToTheOwner(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newProxiedCallService(t, fed, "call-accept")
	ctx := context.Background()

	accepted, err := s.AcceptCall(ctx, "bob:remote.test", "call-accept", "answer")
	if err != nil {
		t.Fatalf("AcceptCall proxied: %v", err)
	}

	if accepted == nil || accepted.ID != "call-accept" {
		t.Fatalf("accepted = %+v, want the proxied call", accepted)
	}

	method, urlStr, body := fed.lastRequest()

	if method != "POST" {
		t.Fatalf("method = %q, want POST", method)
	}

	if !strings.Contains(urlStr, "/api/federated/calls/call-accept/accept") {
		t.Fatalf("url = %q, want the owner accept endpoint", urlStr)
	}

	payload, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v, want a map", body)
	}

	if payload["answer"] != "answer" {
		t.Fatalf("body = %#v, want the answer", payload)
	}

	if _, ok := payload["iceServers"]; !ok {
		t.Fatalf("body = %#v, want iceServers", payload)
	}

	if _, ok := s.calls.Get("call-accept"); ok {
		t.Fatal("the proxy must not own the call")
	}
}

func TestHangupCallForwardsTheShadowToTheOwner(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newProxiedCallService(t, fed, "call-hangup")
	ctx := context.Background()

	if err := s.HangupCall(ctx, "bob:remote.test", "call-hangup", "whatever"); err != nil {
		t.Fatalf("HangupCall proxied: %v", err)
	}

	method, urlStr, body := fed.lastRequest()

	if method != "POST" {
		t.Fatalf("method = %q, want POST", method)
	}

	if !strings.Contains(urlStr, "/api/federated/calls/call-hangup/hangup") {
		t.Fatalf("url = %q, want the owner hangup endpoint", urlStr)
	}

	payload, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v, want a map", body)
	}

	if payload["reason"] != calls.ReasonHangup {
		t.Fatalf("body = %#v, want the normalized hangup reason", payload)
	}

	if _, ok := s.calls.GetFederated("call-hangup"); !ok {
		t.Fatal("the proxy must keep the shadow until the owner reports ended")
	}
}

func TestCurrentCallReportsTheShadowAsRinging(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newProxiedCallService(t, fed, "call-current")
	ctx := context.Background()

	call, found := s.CurrentCall(ctx, "bob:remote.test")
	if !found {
		t.Fatal("expected the shadow in CurrentCall")
	}

	if call.ID != "call-current" || call.State != calls.StateRinging {
		t.Fatalf("call = %+v, want the ringing shadow", call)
	}

	if call.CallerID != "alice:localhost:8080" || call.CalleeID != "bob:remote.test" {
		t.Fatalf("call = %+v, want the federated sides", call)
	}

	if _, found := s.CurrentCall(ctx, "carol:remote.test"); found {
		t.Fatal("a stranger must see no call")
	}
}

func TestHandleFederatedInviteIsIdempotent(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newFederatedCallService(t, fed)
	s.cfg.Server.Domain = "remote.test"
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	invite := func() error {
		return s.HandleFederatedInvite(ctx, "localhost:8080", "call-retry", chatID, "alice:localhost:8080", "bob:remote.test", "offer", nil)
	}

	if err := invite(); err != nil {
		t.Fatalf("first invite: %v", err)
	}

	shadow, ok := s.calls.GetFederated("call-retry")
	if !ok || shadow.Offer != "offer" {
		t.Fatalf("shadow = %+v, %v, want the offer kept", shadow, ok)
	}

	if err := invite(); err != nil {
		t.Fatalf("repeated invite: %v", err)
	}
}

func TestHandleFederatedAcceptExtendsTheShadow(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newProxiedCallService(t, fed, "call-extend")
	ctx := context.Background()

	before, ok := s.calls.GetFederated("call-extend")
	if !ok {
		t.Fatal("the shadow is missing")
	}

	if err := s.HandleFederatedAccept(ctx, "call-extend", "answer", nil); err != nil {
		t.Fatalf("HandleFederatedAccept: %v", err)
	}

	after, ok := s.calls.GetFederated("call-extend")
	if !ok {
		t.Fatal("the shadow is gone after accept")
	}

	if !after.ExpiresAt.After(before.ExpiresAt) {
		t.Fatalf("expiry = %v, want it after %v", after.ExpiresAt, before.ExpiresAt)
	}
}

func TestSendIceForwardsToTheRemotePeer(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newFederatedCallService(t, fed)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatalf("StartCall federated: %v", err)
	}

	candidate := json.RawMessage(`{"candidate":"candidate:1"}`)
	if err := s.SendIce(ctx, "alice:localhost:8080", call.ID, candidate); err != nil {
		t.Fatalf("SendIce: %v", err)
	}

	_, urlStr, _ := fed.lastRequest()

	if !strings.Contains(urlStr, "/api/federated/calls/"+call.ID+"/ice") {
		t.Fatalf("url = %q, want the federated ice path", urlStr)
	}
}

func TestLocalICEMintsTURNCredentials(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newFederatedCallService(t, fed)

	s.cfg.ICE.STUN = []string{"stun:stun.test:3478"}
	s.cfg.ICE.TURN = []config.TURNServer{{
		URLs:   []string{"turn:turn.test:3478"},
		Secret: "test-secret",
	}}

	ice := s.localICE("bob:remote.test")

	servers, ok := ice["turn"].([]config.TURNServer)
	if !ok {
		t.Fatalf("turn = %#v, want []config.TURNServer", ice["turn"])
	}

	if len(servers) != 1 {
		t.Fatalf("turn = %#v, want one server", ice["turn"])
	}

	if servers[0].Username == "" || servers[0].Credential == "" {
		t.Fatalf("turn = %+v, want a minted username and credential", servers[0])
	}

	// The invite/accept wire shape is ICEConfig{stun,turn[{urls,username,credential}]}:
	// the secret has no JSON name and must not leak.
	raw, err := json.Marshal(ice)
	if err != nil {
		t.Fatalf("marshal iceServers: %v", err)
	}

	var decoded config.ICEConfig
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal iceServers: %v", err)
	}

	if len(decoded.TURN) != 1 || decoded.TURN[0].Username == "" || decoded.TURN[0].Credential == "" {
		t.Fatalf("decoded = %+v, want one TURN server with credentials", decoded)
	}

	if decoded.TURN[0].Secret != "" {
		t.Fatalf("decoded = %+v, the TURN secret must not cross the wire", decoded)
	}
}

func TestHandleFederatedInviteRejectsForeignCaller(t *testing.T) {
	fed := &fakeFed{}
	s, _ := newFederatedCallService(t, fed)
	s.cfg.Server.Domain = "remote.test"
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:evil.test", "bob:remote.test")

	err := s.HandleFederatedInvite(ctx, "localhost:8080", "call-spoof", chatID, "alice:evil.test", "bob:remote.test", "offer", nil)
	if !errors.Is(err, ErrNotParticipant) {
		t.Fatalf("err = %v, want ErrNotParticipant", err)
	}

	if _, ok := s.calls.GetFederated("call-spoof"); ok {
		t.Fatal("a spoofed invite must not reserve the callee")
	}
}
