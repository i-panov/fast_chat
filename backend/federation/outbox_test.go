package federation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"fast_chat/model"
)

// fakeOutbox is an in-memory stand-in for the durable queue.
type fakeOutbox struct {
	mu         sync.Mutex
	ops        []*model.FederationOp
	deleted    []string
	resched    []model.FederationOp
	enqueueErr error
}

func (f *fakeOutbox) EnqueueFederationOp(_ context.Context, op *model.FederationOp) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.enqueueErr != nil {
		return f.enqueueErr
	}

	if op.ID == "" {
		op.ID = fmt.Sprintf("op-%d", len(f.ops)+1)
	}

	if op.CreatedAt.IsZero() {
		op.CreatedAt = time.Now().UTC()
	}

	if op.NextAttemptAt.IsZero() {
		op.NextAttemptAt = op.CreatedAt
	}

	f.ops = append(f.ops, op)

	return nil
}

func (f *fakeOutbox) DueFederationOps(_ context.Context, limit int) ([]*model.FederationOp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	out := make([]*model.FederationOp, 0, len(f.ops))
	for _, op := range f.ops {
		if op.NextAttemptAt.After(time.Now().UTC()) {
			continue
		}

		out = append(out, op)
	}

	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}

	return out, nil
}

func (f *fakeOutbox) DeleteFederationOp(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.deleted = append(f.deleted, id)

	for i, op := range f.ops {
		if op.ID == id {
			f.ops = append(f.ops[:i], f.ops[i+1:]...)
			break
		}
	}

	return nil
}

func (f *fakeOutbox) RescheduleFederationOp(_ context.Context, id string, attempts int, nextAttemptAt time.Time, lastError string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	for i, op := range f.ops {
		if op.ID != id {
			continue
		}

		op.Attempts = attempts
		op.NextAttemptAt = nextAttemptAt
		op.LastError = lastError
		f.ops[i] = op
		f.resched = append(f.resched, *op)

		return nil
	}

	return nil
}

func (f *fakeOutbox) snapshot() []model.FederationOp {
	f.mu.Lock()
	defer f.mu.Unlock()

	out := make([]model.FederationOp, 0, len(f.ops))
	for _, op := range f.ops {
		out = append(out, *op)
	}

	return out
}

func TestPostQueuesTheOperation(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/api/federated/chats", map[string]string{"op": "create"})

	ops := outbox.snapshot()
	if len(ops) != 1 {
		t.Fatalf("queued %d operations, want 1", len(ops))
	}

	if ops[0].Method != http.MethodPost || ops[0].Path != "/api/federated/chats" {
		t.Fatalf("unexpected operation %+v", ops[0])
	}

	var body map[string]string
	if err := json.Unmarshal([]byte(ops[0].Body), &body); err != nil {
		t.Fatalf("decode queued body: %v", err)
	}

	if body["op"] != "create" {
		t.Errorf("queued body op = %q, want %q", body["op"], "create")
	}

	// Nothing is sent before the worker runs.
	if got := len(rec.all()); got != 0 {
		t.Fatalf("recorded %d requests before the worker ran, want 0", got)
	}
}

func TestOutboxDeliversAndRemovesTheOperation(t *testing.T) {
	m := newTestManager(t, "local.test")
	srv, rec := newRecordingServer(t)

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/api/federated/chats", map[string]string{"op": "create"})

	c.drainOutbox(context.Background())

	if got := len(rec.all()); got != 1 {
		t.Fatalf("recorded %d requests, want 1", got)
	}

	if len(outbox.snapshot()) != 0 {
		t.Fatalf("the delivered operation is still queued: %+v", outbox.snapshot())
	}
}

func TestOutboxKeepsAFailedOperation(t *testing.T) {
	m := newTestManager(t, "local.test")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/api/federated/chats", map[string]string{"op": "create"})

	c.drainOutbox(context.Background())

	ops := outbox.snapshot()
	if len(ops) != 1 {
		t.Fatalf("queued %d operations after the failure, want 1", len(ops))
	}

	if ops[0].Attempts != 1 {
		t.Errorf("attempts = %d, want 1", ops[0].Attempts)
	}

	if !ops[0].NextAttemptAt.After(time.Now().UTC()) {
		t.Errorf("the failed operation was not postponed: %v", ops[0].NextAttemptAt)
	}
}

// A rejection the peer will repeat (a 4xx that is not a timeout or a rate
// limit) must not be retried forever: with the per-peer order of the outbox
// it would block every later operation of that peer.
func TestOutboxDropsAPermanentlyRejectedOperation(t *testing.T) {
	m := newTestManager(t, "local.test")

	var paths []string
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()

		if r.URL.Path == "/first" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	peer := peerHost(t, srv)
	c.Post(context.Background(), peer, "/first", nil)
	c.Post(context.Background(), peer, "/second", nil)

	c.drainOutbox(context.Background())

	mu.Lock()
	delivered := append([]string(nil), paths...)
	mu.Unlock()

	if len(delivered) != 2 || delivered[0] != "/first" || delivered[1] != "/second" {
		t.Fatalf("delivered %v, want the rejected operation and the one behind it", delivered)
	}

	// The rejected operation is gone: it is not retried, and it does not
	// block the queue of the peer. The operation behind it was delivered.
	ops := outbox.snapshot()
	if len(ops) != 0 {
		t.Fatalf("queued %+v, want an empty queue", ops)
	}
}

// An operation that fails for a long time may not block the queue of its
// peer forever: after the attempt limit it is dropped with a loud log.
func TestOutboxDropsAnOperationAfterTooManyAttempts(t *testing.T) {
	m := newTestManager(t, "local.test")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/first", nil)

	// The operation is already at the limit.
	outbox.mu.Lock()
	outbox.ops[0].Attempts = outboxMaxAttempts - 1
	outbox.mu.Unlock()

	c.drainOutbox(context.Background())

	if ops := outbox.snapshot(); len(ops) != 0 {
		t.Fatalf("queued %+v, want the operation to be dropped", ops)
	}
}

// A 5xx answer and a rate limit are worth retrying: the peer may answer
// differently next time.
// errNetwork stands for a failure that never reached the peer.
var errNetwork = errors.New("connection refused")

func TestIsPermanentError(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{&StatusError{Status: 400}, true},
		{&StatusError{Status: 403}, true},
		// A 404 rides the bounded retry queue instead of dropping at once:
		// when a chat creation is still queued, every message behind it
		// answers 404 until the creation lands.
		{&StatusError{Status: 404}, false},
		// A refused signature also happens on a clock skew or a rotated key
		// of the peer: it may pass on the next attempt.
		{&StatusError{Status: 401}, false},
		{&StatusError{Status: 408}, false},
		{&StatusError{Status: 429}, false},
		{&StatusError{Status: 500}, false},
		{&StatusError{Status: 502}, false},
		{errNetwork, false},
	}

	for _, c := range cases {
		if got := IsPermanentError(c.err); got != c.want {
			t.Errorf("IsPermanentError(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}

// The operations of one peer keep their order: a message must not arrive
// before the chat it belongs to.
func TestOutboxKeepsTheOrderOfOnePeer(t *testing.T) {
	m := newTestManager(t, "local.test")

	var paths []string
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()

		if len(paths) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	peer := peerHost(t, srv)
	c.Post(context.Background(), peer, "/first", nil)
	c.Post(context.Background(), peer, "/second", nil)

	c.drainOutbox(context.Background())

	mu.Lock()
	defer mu.Unlock()

	if len(paths) != 1 || paths[0] != "/first" {
		t.Fatalf("delivered %v, want only the first operation", paths)
	}
}

// A failed operation blocks the queue of its peer: the next tick must not
// send the message of a chat whose creation is still waiting.
func TestOutboxKeepsTheOrderAcrossTicks(t *testing.T) {
	m := newTestManager(t, "local.test")

	var paths []string
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		failed := len(paths) == 1
		mu.Unlock()

		if failed {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	peer := peerHost(t, srv)
	c.Post(context.Background(), peer, "/first", nil)
	c.Post(context.Background(), peer, "/second", nil)

	c.drainOutbox(context.Background())

	mu.Lock()
	delivered := len(paths)
	mu.Unlock()

	if delivered != 1 {
		t.Fatalf("delivered %d operations in the first drain, want 1", delivered)
	}

	// The failed operation was postponed, so the second one has to wait for
	// it. The store is the one that decides: the fake outbox returns every
	// operation, so the barrier is checked here.
	if len(outbox.snapshot()) != 2 {
		t.Fatalf("queued %d operations, want 2", len(outbox.snapshot()))
	}
}

func TestOutboxDelayGrowsAndIsCapped(t *testing.T) {
	if got := outboxDelay(1); got != outboxBaseDelay {
		t.Errorf("delay after the first failure = %v, want %v", got, outboxBaseDelay)
	}

	if got := outboxDelay(2); got != 2*outboxBaseDelay {
		t.Errorf("delay after the second failure = %v, want %v", got, 2*outboxBaseDelay)
	}

	if got := outboxDelay(50); got != outboxMaxDelay {
		t.Errorf("delay after many failures = %v, want %v", got, outboxMaxDelay)
	}
}

func TestOutboxPreservesDroppedOpsInDeadLetters(t *testing.T) {
	m := newTestManager(t, "local.test")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/first", nil)
	c.drainOutbox(context.Background())

	if ops := outbox.snapshot(); len(ops) != 0 {
		t.Fatalf("queued %+v, want the rejected operation removed from the queue", ops)
	}

	dead := c.DeadLetters()
	if len(dead) != 1 || dead[0].Op.Path != "/first" {
		t.Fatalf("dead letters = %+v, want the rejected operation preserved", dead)
	}
}

func TestOutbox404IsRetriedNotDropped(t *testing.T) {
	m := newTestManager(t, "local.test")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(srv.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	c.Post(context.Background(), peerHost(t, srv), "/msg", nil)
	c.drainOutbox(context.Background())

	// A 404 must ride the retry queue (it may resolve once the chat creation
	// ahead of it lands), not drop into the dead letters at once.
	if ops := outbox.snapshot(); len(ops) != 1 {
		t.Fatalf("queued %d operations, want the 404 kept for retry", len(ops))
	}

	if dead := c.DeadLetters(); len(dead) != 0 {
		t.Fatalf("dead letters = %+v, want none for a first 404", dead)
	}
}

// errQueueFull stands for a transient database failure on the enqueue path.
var errQueueFull = errors.New("disk full")

// A failed enqueue must not silently drop the operation: the local user was
// already told "sent", so the loss has to stay inspectable.
func TestOutboxEnqueueFailureIsDeadLettered(t *testing.T) {
	m := newTestManager(t, "local.test")

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetOutbox(&fakeOutbox{enqueueErr: errQueueFull})

	c.Post(context.Background(), "peer.test", "/api/federated/chats", map[string]string{"op": "create"})

	dead := c.DeadLetters()
	if len(dead) != 1 {
		t.Fatalf("dead letters = %d, want 1", len(dead))
	}

	if !strings.Contains(dead[0].Reason, "disk full") {
		t.Errorf("reason = %q, want the enqueue error", dead[0].Reason)
	}

	if dead[0].Op.Path != "/api/federated/chats" {
		t.Errorf("dead letter lost the operation: %+v", dead[0].Op)
	}
}

// One unavailable or slow peer must not hold back the deliveries of every
// other peer for its whole retry budget.
func TestOutboxDrainsPeersIndependently(t *testing.T) {
	m := newTestManager(t, "local.test")

	slowStarted := make(chan struct{})
	var slowOnce sync.Once

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		slowOnce.Do(func() { close(slowStarted) })
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer slow.Close()

	fastDone := make(chan struct{})
	var fastOnce sync.Once

	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fastOnce.Do(func() { close(fastDone) })
		w.WriteHeader(http.StatusOK)
	}))
	defer fast.Close()

	c := NewClient(m, "local.test", "http", 5, false)
	c.SetHTTPClient(fast.Client())

	outbox := &fakeOutbox{}
	c.SetOutbox(outbox)

	// The failing peer is first in the queue: the old sequential drain would
	// reach the healthy peer only after the retries of the slow one.
	c.Post(context.Background(), peerHost(t, slow), "/slow", nil)
	c.Post(context.Background(), peerHost(t, fast), "/fast", nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() {
		defer close(done)
		c.drainOutbox(ctx)
	}()

	select {
	case <-slowStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("the slow peer was never attempted")
	}

	select {
	case <-fastDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the healthy peer was held back by the unavailable one")
	}

	cancel()
	<-done
}
