package federation

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"fast_chat/model"
)

// Outbox is the durable queue of the operations waiting to be delivered to a
// peer. It is implemented by the store; the federation package only needs
// the four operations below.
type Outbox interface {
	EnqueueFederationOp(ctx context.Context, op *model.FederationOp) error
	DueFederationOps(ctx context.Context, limit int) ([]*model.FederationOp, error)
	DeleteFederationOp(ctx context.Context, id string) error
	RescheduleFederationOp(ctx context.Context, id string, attempts int, nextAttemptAt time.Time, lastError string) error
}

const (
	// outboxBatchSize bounds how many operations are sent per tick.
	outboxBatchSize = 32
	// outboxBaseDelay is the delay after the first failure. Every further
	// failure doubles it, up to outboxMaxDelay.
	outboxBaseDelay = 5 * time.Second
	// outboxMaxDelay caps the backoff: a peer that stays down must not turn
	// into a busy loop.
	outboxMaxDelay = 5 * time.Minute
	// outboxMaxAttempts bounds how long one operation may block the queue of
	// its peer. A peer that is down for hours must not freeze the queue
	// forever: the operation is dropped with a loud log after that many
	// attempts, and the queue moves on. The limit is high enough to survive a
	// long outage (with the capped backoff it is about four hours).
	outboxMaxAttempts = 50
	// maxDeadLetters bounds the in-memory dead-letter queue: dropped
	// operations stay inspectable, but a peer that is gone for good must
	// not grow memory without bound.
	maxDeadLetters = 1000
)

// DeadLetter is an operation the outbox gave up on, kept for manual
// inspection instead of vanishing into a log line.
type DeadLetter struct {
	Op        model.FederationOp
	Reason    string
	DroppedAt time.Time
}

// outboxDelay returns the delay before the next attempt of an operation that
// failed `attempts` times.
func outboxDelay(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}

	delay := outboxBaseDelay
	for range attempts - 1 {
		delay *= 2
		if delay >= outboxMaxDelay {
			return outboxMaxDelay
		}
	}

	if delay > outboxMaxDelay {
		return outboxMaxDelay
	}

	return delay
}

// SetOutbox attaches the durable queue to the client. Without it the client
// falls back to sending the operations in the background, which is what the
// tests and the one-shot tools use.
func (c *Client) SetOutbox(outbox Outbox) {
	c.outbox = outbox
}

// enqueue puts an operation into the durable queue. The operation is not sent
// inline: the caller answers the local user immediately, and the worker
// delivers the operation to the peer with retries.
func (c *Client) enqueue(ctx context.Context, remoteServer, method, path string, body any) {
	if remoteServer == "" {
		return
	}

	bodyBytes, err := marshalBody(body)
	if err != nil {
		slog.Error("federation operation could not be encoded", "method", method, "path", path, "err", err)
		return
	}

	if c.outbox != nil {
		op := &model.FederationOp{
			RemoteServer: remoteServer,
			Method:       method,
			Path:         path,
			Body:         string(bodyBytes),
		}

		if err := c.outbox.EnqueueFederationOp(ctx, op); err != nil {
			slog.Error("federation operation could not be queued", "method", method, "path", path, "err", err)

			return
		}

		// The worker picks the operation up right away instead of waiting for
		// the next tick: a message that reaches the peer in five seconds looks
		// like a broken chat.
		select {
		case c.wake <- struct{}{}:
		default:
		}

		return
	}

	c.background(ctx, remoteServer, path, method, body)
}

func marshalBody(body any) ([]byte, error) {
	if body == nil {
		return nil, nil
	}

	return json.Marshal(body)
}

// RunOutbox delivers the queued operations to their peers. It runs until the
// context is cancelled.
//
// The order of the operations of one peer is preserved: the store only hands
// out the operations whose predecessors are already delivered, and a failure
// stops the queue of that peer for the rest of the drain.
func (c *Client) RunOutbox(ctx context.Context, interval time.Duration) {
	if c.outbox == nil {
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
			c.drainOutbox(ctx)
		case <-ticker.C:
			c.drainOutbox(ctx)
		}
	}
}

func (c *Client) drainOutbox(ctx context.Context) {
	ops, err := c.outbox.DueFederationOps(ctx, outboxBatchSize)
	if err != nil {
		slog.Error("federation outbox could not be read", "err", err)
		return
	}

	// A peer whose operation failed waits for the next drain: the operations
	// behind it would arrive out of order. The store keeps the same order
	// across the ticks: an operation that is postponed blocks the queue of
	// its peer there as well.
	blocked := make(map[string]struct{})

	for _, op := range ops {
		if _, ok := blocked[op.RemoteServer]; ok {
			continue
		}

		err := c.deliverOp(ctx, op)
		if err == nil {
			if delErr := c.outbox.DeleteFederationOp(ctx, op.ID); delErr != nil {
				slog.Error("federation operation could not be removed from the queue", "opID", op.ID, "err", delErr)
			}

			continue
		}

		// A rejection that will repeat (the peer refuses the operation for
		// good) must not be retried forever: with the per-peer order of the
		// outbox it would block every later operation of that peer. The
		// operation is moved to the dead-letter queue with a loud log, and
		// the queue moves on.
		if IsPermanentError(err) {
			slog.Error("federation operation was rejected permanently, moving it to the dead-letter queue",
				"opID", op.ID, "peer", op.RemoteServer, "method", op.Method, "path", op.Path, "err", err)
			c.deadLetter(op, err.Error())

			if delErr := c.outbox.DeleteFederationOp(ctx, op.ID); delErr != nil {
				slog.Error("federation operation could not be removed from the queue", "opID", op.ID, "err", delErr)
			}

			continue
		}

		attempts := op.Attempts + 1

		// The operation has blocked the queue of its peer long enough. It is
		// moved to the dead-letter queue with a loud log, so the queue of
		// the peer moves on and the loss stays visible and inspectable.
		if attempts >= outboxMaxAttempts {
			slog.Error("federation operation gave up after too many attempts, moving it to the dead-letter queue",
				"opID", op.ID, "peer", op.RemoteServer, "method", op.Method, "path", op.Path, "attempts", attempts, "err", err)
			c.deadLetter(op, err.Error())

			if delErr := c.outbox.DeleteFederationOp(ctx, op.ID); delErr != nil {
				slog.Error("federation operation could not be removed from the queue", "opID", op.ID, "err", delErr)
			}

			continue
		}

		delay := outboxDelay(attempts)

		if reschedErr := c.outbox.RescheduleFederationOp(ctx, op.ID, attempts, time.Now().UTC().Add(delay), err.Error()); reschedErr != nil {
			slog.Error("federation operation could not be rescheduled", "opID", op.ID, "err", reschedErr)
		}

		slog.Info("federation operation failed, will retry", "opID", op.ID, "peer", op.RemoteServer, "attempts", attempts, "err", err)

		blocked[op.RemoteServer] = struct{}{}
	}
}

// deliverOp sends a queued operation to its peer.
func (c *Client) deliverOp(ctx context.Context, op *model.FederationOp) error {
	url := c.URL(op.RemoteServer, op.Path)

	var body any
	if op.Body != "" {
		body = json.RawMessage(op.Body)
	}

	_, err := c.Request(ctx, op.Method, url, body)

	return err
}

// deadLetter preserves a dropped operation for manual inspection. The queue
// is bounded: beyond maxDeadLetters the oldest entry is evicted first and
// counted, so a permanently unreachable peer cannot grow memory without
// bound.
func (c *Client) deadLetter(op *model.FederationOp, reason string) {
	c.dlqMu.Lock()
	defer c.dlqMu.Unlock()

	if len(c.deadLetters) >= maxDeadLetters {
		c.deadLetters = append(c.deadLetters[:0], c.deadLetters[1:]...)
		c.dlqDropped++
	}

	c.deadLetters = append(c.deadLetters, DeadLetter{
		Op:        *op,
		Reason:    reason,
		DroppedAt: time.Now().UTC(),
	})
}

// DeadLetters returns a copy of the operations the outbox gave up on.
func (c *Client) DeadLetters() []DeadLetter {
	c.dlqMu.Lock()
	defer c.dlqMu.Unlock()

	return append([]DeadLetter(nil), c.deadLetters...)
}

// DeadLetterDropped counts the dead letters evicted by the bound.
func (c *Client) DeadLetterDropped() int {
	c.dlqMu.Lock()
	defer c.dlqMu.Unlock()

	return c.dlqDropped
}
