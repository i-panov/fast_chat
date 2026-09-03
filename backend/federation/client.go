package federation

import (
	"bytes"
	"context"
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

// retryCount and the exponential backoff base mirror the pre-migration client.
const (
	retryCount     = 3
	retryBackoffMs = 1000
	backgroundTTL  = 30 * time.Second
)

// errFederatedStatus marks unexpected HTTP statuses from remote servers.
var errFederatedStatus = errors.New("federated request returned unexpected status")

// Client performs signed server-to-server requests against federation peers.
type Client struct {
	manager *Manager
	http    *http.Client
	scheme  string
	domain  string

	sem chan struct{}
	wg  sync.WaitGroup
}

// NewClient builds a client that signs requests with the manager's key and
// identifies itself as domain.
func NewClient(m *Manager, domain, scheme string, timeoutSec int) *Client {
	return &Client{
		manager: m,
		http:    NewSafeHTTPClient(time.Duration(timeoutSec) * time.Second),
		scheme:  scheme,
		domain:  domain,
		sem:     make(chan struct{}, maxConcurrentRequests),
	}
}

// URL builds a federation URL using the configured scheme.
func (c *Client) URL(remoteServer, path string) string {
	return fmt.Sprintf("%s://%s%s", c.scheme, remoteServer, path)
}

// Request performs a signed request with retries and returns the response
// body. The incoming request ID (if any) is propagated for log correlation.
func (c *Client) Request(ctx context.Context, method, urlStr string, body any) ([]byte, error) {
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

	timestamp := time.Now().Unix()

	signature, err := c.manager.Sign(method, parsedURL.RequestURI(), bodyBytes, timestamp)
	if err != nil {
		return nil, fmt.Errorf("federation sign: %w", err)
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

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Federation-Server", c.domain)
		req.Header.Set("X-Federation-Signature", signature)
		req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

		// Propagate the incoming request ID so the upstream server can
		// correlate logs with the originating request.
		if id := httputil.GetRequestID(ctx); id != "" {
			req.Header.Set(httputil.RequestIDHeader, id)
		}

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err

			if attempt < retryCount-1 {
				time.Sleep(time.Duration(1<<attempt) * time.Second)
			}

			continue
		}

		resp.Body = http.MaxBytesReader(nil, resp.Body, maxResponseBody)
		body, readErr := io.ReadAll(resp.Body)

		if closeErr := resp.Body.Close(); closeErr != nil {
			slog.Warn("failed to close response body", "err", closeErr)
		}

		if resp.StatusCode >= 400 {
			if readErr != nil {
				return nil, fmt.Errorf("%w: %d", errFederatedStatus, resp.StatusCode)
			}

			return nil, fmt.Errorf("%w: %d: %s", errFederatedStatus, resp.StatusCode, strings.TrimSpace(string(body)))
		}

		if readErr != nil {
			return nil, readErr
		}

		return body, nil
	}

	return nil, fmt.Errorf("federated request failed after retries: %w", lastErr)
}

// Post queues a fire-and-forget signed POST to remoteServer. Empty remote
// servers are a no-op.
func (c *Client) Post(ctx context.Context, remoteServer, path string, body any) {
	c.background(ctx, remoteServer, path, http.MethodPost, body)
}

// Patch queues a fire-and-forget signed PATCH.
func (c *Client) Patch(ctx context.Context, remoteServer, path string, body any) {
	c.background(ctx, remoteServer, path, http.MethodPatch, body)
}

// Delete queues a fire-and-forget signed DELETE.
func (c *Client) Delete(ctx context.Context, remoteServer, path string) {
	c.background(ctx, remoteServer, path, http.MethodDelete, nil)
}

// CloseWait blocks until all in-flight background requests have finished so
// they are not silently dropped on shutdown.
func (c *Client) CloseWait() {
	c.wg.Wait()
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
