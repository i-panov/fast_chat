package federation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"fast_chat/internal/httputil"
)

// maxConcurrentRequests bounds the number of in-flight background federated
// requests; overflowing requests are dropped with a warning.
const maxConcurrentRequests = 16

// maxResponseBody caps how much of a federated response is read into memory.
const maxResponseBody = 10 << 20

// federatedStreamMaxBytes bounds a streamed file when the caller does not
// pass a limit. It leaves room for ciphertext above the 50 MiB upload limit.
const federatedStreamMaxBytes = 64 << 20

// statusErrorBodyLimit bounds how much of a failed peer response is quoted
// in the error.
const statusErrorBodyLimit = 8 << 10

// retryCount and the exponential backoff base mirror the pre-migration client.
const (
	retryCount     = 3
	retryBackoffMs = 1000
	backgroundTTL  = 30 * time.Second
)

// errFederatedStatus marks unexpected HTTP statuses from remote servers.
var errFederatedStatus = errors.New("federated request returned unexpected status")

// ErrResponseTooLarge reports a peer response whose declared length exceeds
// the caller's cap. It is detected before any bytes are relayed.
var ErrResponseTooLarge = errors.New("federated response is too large")

// StatusError is the answer of a peer that refused the request. It carries
// the status code, so the caller can tell a permanent rejection from a
// failure that is worth retrying.
type StatusError struct {
	Status int
	Body   string
	// Header carries the peer's response headers for statuses where they
	// are part of the answer (416 needs Content-Range, 304 validators).
	Header http.Header
}

func (e *StatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("%s: %d", errFederatedStatus, e.Status)
	}

	return fmt.Sprintf("%s: %d: %s", errFederatedStatus, e.Status, e.Body)
}

// Unwrap keeps the sentinel reachable with errors.Is.
func (e *StatusError) Unwrap() error {
	return errFederatedStatus
}

// IsPermanentError reports whether the peer will refuse the operation the
// same way next time: a 4xx answer that is not a timeout, a rate limit, a
// refused signature, or a missing resource.
//
// Such an operation must not be retried forever: with the per-peer order of
// the outbox it would block every later operation of that peer.
//
// A refused signature (401) is not permanent: it also happens when the clock
// of the peer is off or when it rotated its key and the cached one is stale.
// The attempt limit of the outbox is what bounds that case.
//
// A 404 is not permanent either: when the creation of a chat is still queued
// behind a retry, every message of that chat answers 404 until the creation
// lands. Dropping them as permanent would cascade one failure into the loss
// of the whole chat, so 404s ride the same bounded retry queue instead.
func IsPermanentError(err error) bool {
	var statusErr *StatusError
	if !errors.As(err, &statusErr) {
		return false
	}

	switch statusErr.Status {
	case http.StatusUnauthorized, http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusNotFound:
		return false
	}

	return statusErr.Status >= 400 && statusErr.Status < 500
}

// Client performs signed server-to-server requests against federation peers.
type Client struct {
	manager *Manager
	mu      sync.RWMutex
	http    *http.Client
	scheme  string
	domain  string

	// outbox is the durable queue of the operations waiting to be delivered.
	// Without it the operations are sent in the background and lost when the
	// peer is unreachable.
	outbox Outbox

	// wake tells the outbox worker that a new operation is waiting. The
	// signal is buffered and never blocks the caller: a missed signal only
	// delays the delivery to the next tick.
	wake chan struct{}

	sem chan struct{}
	wg  sync.WaitGroup

	// deadLetters keeps the operations dropped after a permanent rejection
	// or the attempt limit, so the loss stays inspectable instead of
	// vanishing into a log line. Bounded; the oldest entry is evicted first.
	dlqMu       sync.Mutex
	deadLetters []DeadLetter
	dlqDropped  int
}

// NewClient builds a client that signs requests with the manager's key and
// identifies itself as domain.
func NewClient(m *Manager, domain, scheme string, timeoutSec int, allowPrivate bool) *Client {
	return &Client{
		manager: m,
		http:    NewSafeHTTPClient(time.Duration(timeoutSec)*time.Second, allowPrivate),
		scheme:  scheme,
		domain:  domain,
		wake:    make(chan struct{}, 1),
		sem:     make(chan struct{}, maxConcurrentRequests),
	}
}

// randomNonce returns a random value that makes a request unique.
func randomNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	return hex.EncodeToString(buf), nil
}

// URL builds a federation URL using the configured scheme.
func (c *Client) URL(remoteServer, path string) string {
	return fmt.Sprintf("%s://%s%s", c.scheme, remoteServer, path)
}

// Request performs a signed request with retries and returns the response
// body. The incoming request ID (if any) is propagated for log correlation.
//
// Every attempt is signed on its own: the peer rejects a replayed signature,
// so a retry that reuses the signature of the first attempt would be refused
// as a replay even though the request itself is legitimate.
func (c *Client) Request(ctx context.Context, method, urlStr string, body any) ([]byte, error) {
	return c.RequestWithLimit(ctx, method, urlStr, body, maxResponseBody)
}

// RequestWithLimit is Request with a caller-chosen response cap, for the few
// callers that still buffer a response larger than the JSON-oriented default.
func (c *Client) RequestWithLimit(ctx context.Context, method, urlStr string, body any, limit int64) ([]byte, error) {
	var bodyBytes []byte

	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}

		bodyBytes = data
	}

	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return nil, fmt.Errorf("invalid federated URL: %w", err)
	}

	var lastErr error

	for attempt := range retryCount {
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		req, reqErr := http.NewRequestWithContext(ctx, method, urlStr, bodyReader)
		if reqErr != nil {
			return nil, reqErr
		}

		timestamp := time.Now().Unix()

		// Every attempt gets its own nonce: two identical requests within the
		// same second would otherwise share a signature, and the second one
		// would be refused as a replay of the first.
		nonce, nonceErr := randomNonce()
		if nonceErr != nil {
			return nil, fmt.Errorf("federation nonce: %w", nonceErr)
		}

		signature, signErr := c.manager.Sign(parsedURL.Host, method, parsedURL.RequestURI(), bodyBytes, timestamp, nonce)
		if signErr != nil {
			return nil, fmt.Errorf("federation sign: %w", signErr)
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Federation-Server", c.domain)
		req.Header.Set("X-Federation-Signature", signature)
		req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))
		req.Header.Set(NonceHeader, nonce)

		version, versionErr := c.manager.ProtocolVersion(ctx, parsedURL.Host)
		if versionErr != nil {
			return nil, versionErr
		}
		req.Header.Set(ProtocolHeader, strconv.Itoa(version))

		// Propagate the incoming request ID so the upstream server can
		// correlate logs with the originating request.
		if id := httputil.GetRequestID(ctx); id != "" {
			req.Header.Set(httputil.RequestIDHeader, id)
		}

		resp, err := c.httpClient().Do(req)
		if err != nil {
			lastErr = err

			if attempt < retryCount-1 {
				backoff := time.Duration(1<<attempt) * time.Second

				select {
				case <-ctx.Done():
					return nil, fmt.Errorf("federated request cancelled while backing off: %w", ctx.Err())
				case <-time.After(backoff):
				}
			}

			continue
		}

		resp.Body = http.MaxBytesReader(nil, resp.Body, limit)
		body, readErr := io.ReadAll(resp.Body)

		if closeErr := resp.Body.Close(); closeErr != nil {
			slog.Warn("failed to close response body", "err", closeErr)
		}

		if resp.StatusCode >= 400 {
			// The status travels in a typed error: the caller has to tell a
			// rejection that will repeat (the peer refuses the operation for
			// good) from a failure that is worth retrying.
			statusErr := &StatusError{Status: resp.StatusCode}

			if readErr == nil {
				statusErr.Body = strings.TrimSpace(string(body))
			}

			return nil, statusErr
		}

		if readErr != nil {
			return nil, readErr
		}

		return body, nil
	}

	return nil, fmt.Errorf("federated request failed after retries: %w", lastErr)
}

// OpenStream performs a signed request and returns the response without
// buffering its body.
//
// until the response headers arrive: a body that fails mid-copy cannot be
// replayed safely. The body is bounded by limit and responds to ctx
// cancellation while it is copied.
//
//nolint:gocognit // mirrors RequestWithLimit with a streaming body The caller must close resp.Body. Retries happen only
func (c *Client) OpenStream(
	ctx context.Context,
	method, urlStr string,
	body any,
	limit int64,
	header http.Header,
) (*http.Response, error) {

	var bodyBytes []byte

	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}

		bodyBytes = data
	}

	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return nil, fmt.Errorf("invalid federated URL: %w", err)
	}

	if limit <= 0 {
		limit = federatedStreamMaxBytes
	}

	var lastErr error

	for attempt := range retryCount {
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		req, reqErr := http.NewRequestWithContext(ctx, method, urlStr, bodyReader)
		if reqErr != nil {
			return nil, reqErr
		}

		for key, values := range header {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}

		timestamp := time.Now().Unix()
		nonce, nonceErr := randomNonce()
		if nonceErr != nil {
			return nil, fmt.Errorf("federation nonce: %w", nonceErr)
		}
		signature, signErr := c.manager.Sign(parsedURL.Host, method, parsedURL.RequestURI(), bodyBytes, timestamp, nonce)
		if signErr != nil {
			return nil, fmt.Errorf("federation sign: %w", signErr)
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Federation-Server", c.domain)
		req.Header.Set("X-Federation-Signature", signature)
		req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))
		req.Header.Set(NonceHeader, nonce)

		version, versionErr := c.manager.ProtocolVersion(ctx, parsedURL.Host)
		if versionErr != nil {
			return nil, versionErr
		}
		req.Header.Set(ProtocolHeader, strconv.Itoa(version))

		if id := httputil.GetRequestID(ctx); id != "" {
			req.Header.Set(httputil.RequestIDHeader, id)
		}

		resp, doErr := c.streamHTTPClient().Do(req)
		if doErr != nil {
			lastErr = doErr

			if attempt < retryCount-1 {
				backoff := time.Duration(1<<attempt) * time.Second

				select {
				case <-ctx.Done():
					return nil, fmt.Errorf("federated stream cancelled while backing off: %w", ctx.Err())
				case <-time.After(backoff):
				}
			}

			continue
		}

		if resp.StatusCode >= 400 {
			statusErr := &StatusError{Status: resp.StatusCode, Header: resp.Header.Clone()}
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, statusErrorBodyLimit))
			if closeErr := resp.Body.Close(); closeErr != nil {
				slog.Warn("failed to close stream error body", "err", closeErr)
			}
			if readErr == nil {
				statusErr.Body = strings.TrimSpace(string(body))
			}
			return nil, statusErr
		}

		if resp.ContentLength > limit {
			if closeErr := resp.Body.Close(); closeErr != nil {
				slog.Warn("failed to close oversized stream", "err", closeErr)
			}
			return nil, fmt.Errorf("%w: %d > %d", ErrResponseTooLarge, resp.ContentLength, limit)
		}

		resp.Body = http.MaxBytesReader(nil, resp.Body, limit)
		return resp, nil
	}

	return nil, fmt.Errorf("federated stream failed after retries: %w", lastErr)
}

// SetHTTPClient replaces the HTTP client used for signed requests. Same
// rationale as Manager.SetHTTPClient: tests that run federation peers on
// loopback httptest servers must bypass the SSRF-safe dialer. The swap is
// guarded by a mutex so in-flight requests keep the client they started
// with; prefer calling it before traffic starts.
func (c *Client) SetHTTPClient(h *http.Client) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.http = h
}

// Post queues a fire-and-forget signed POST to remoteServer. Empty remote
// servers are a no-op.
func (c *Client) Post(ctx context.Context, remoteServer, path string, body any) {
	c.enqueue(ctx, remoteServer, http.MethodPost, path, body)
}

// Patch queues a fire-and-forget signed PATCH.
func (c *Client) Patch(ctx context.Context, remoteServer, path string, body any) {
	c.enqueue(ctx, remoteServer, http.MethodPatch, path, body)
}

// Delete queues a fire-and-forget signed DELETE.
func (c *Client) Delete(ctx context.Context, remoteServer, path string) {
	c.enqueue(ctx, remoteServer, http.MethodDelete, path, nil)
}

// CloseWait blocks until all in-flight background requests have finished so
// they are not silently dropped on shutdown.
func (c *Client) CloseWait() {
	c.wg.Wait()
}

// CloseWaitContext blocks until the in-flight background requests finish, or
// until ctx is done. A bare Wait has no bound: a peer that stalls a request
// holds it for the full client timeout across all retries, which would keep
// shutdown going past the server's own drain deadline.
//
// On a timeout the returned error is ctx.Err(); the waiter goroutine is left
// behind on purpose, since only the process exit can release it. Callers are
// expected to log it and continue tearing down.
func (c *Client) CloseWaitContext(ctx context.Context) error {
	done := make(chan struct{})

	go func() {
		c.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// streamHTTPClient clones the configured client with the total request
// timeout disabled: http.Client.Timeout covers reading the body, which would
// cut a long file transfer at the JSON timeout. The stream context bounds the
// transfer instead.
func (c *Client) streamHTTPClient() *http.Client {
	base := c.httpClient()
	if base == nil {
		return &http.Client{}
	}
	clone := *base
	clone.Timeout = 0
	return &clone
}

// httpClient returns the HTTP client used for signed requests under a read
// lock: SetHTTPClient may replace it while requests are in flight.
func (c *Client) httpClient() *http.Client {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return c.http
}

// background runs a federated request in its own goroutine with a timeout
// decoupled from the originating HTTP request (context values survive via
// context.WithoutCancel). The semaphore bounds concurrency; recover keeps a
// panic in the goroutine from taking down the process.
func (c *Client) background(ctx context.Context, remoteServer, path, method string, body any) {
	if remoteServer == "" {
		return
	}

	select {
	case c.sem <- struct{}{}:
	default:
		slog.Warn("federation worker pool saturated, dropping request", "method", method, "path", path)
		return
	}

	c.wg.Add(1)

	go func() {
		defer func() {
			<-c.sem
			c.wg.Done()

			if r := recover(); r != nil {
				slog.Error("panic in federation background request", "method", method, "path", path, "panic", r)
			}
		}()

		baseCtx := context.WithoutCancel(ctx)
		timeoutCtx, cancel := context.WithTimeout(baseCtx, backgroundTTL)
		defer cancel()

		if _, err := c.Request(timeoutCtx, method, c.URL(remoteServer, path), body); err != nil {
			slog.Info("federated request failed", "method", method, "path", path, "err", err)
		}
	}()
}
