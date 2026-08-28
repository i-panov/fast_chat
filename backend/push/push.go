// Package push provides WebPush notification sending via VAPID.
package push

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"fast_chat/model"
)

// VAPIDKeys holds the ECDSA keypair for VAPID authentication.
type VAPIDKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// Service sends WebPush notifications.
type Service struct {
	vapidKeys  VAPIDKeys
	subject    string
	httpClient *http.Client
	onExpired  func(endpoint string)
}

// NewService creates a Service, loading or generating VAPID keys.
func NewService(subject, keysDir string, onExpired func(endpoint string)) (*Service, error) {
	keys, err := loadOrGenerateVAPIDKeys(keysDir)
	if err != nil {
		return nil, err
	}

	slog.Info("VAPID keys loaded", "public_key", keys.PublicKey)

	return &Service{
		vapidKeys: keys,
		subject:   subject,
		// Endpoints are validated against a strict allowlist of push
		// services (handler.isValidPushEndpoint), so a safe dialer is
		// not required here.
		// nosemgrep: fast-chat-inline-http-client
		httpClient: &http.Client{Timeout: 10 * time.Second},
		onExpired:  onExpired,
	}, nil
}

// PublicKey returns the VAPID public key for client subscriptions.
func (s *Service) PublicKey() string {
	return s.vapidKeys.PublicKey
}

// SendToUser sends a payload to all push subscriptions.
func (s *Service) SendToUser(payload []byte, subscriptions []model.PushSubscription) {
	for _, sub := range subscriptions {
		err := s.sendOne(payload, sub.Endpoint, sub.P256DH, sub.Auth)
		if err != nil {
			if errors.Is(err, errSubscriptionExpired) {
				slog.Info("push subscription expired, removing", "endpoint", truncate(sub.Endpoint, 40))

				if s.onExpired != nil {
					s.onExpired(sub.Endpoint)
				}
			} else {
				slog.Warn("push send failed", "endpoint", truncate(sub.Endpoint, 40), "err", err)
			}
		}
	}
}

var (
	errSubscriptionExpired = errors.New("subscription expired")
	errPushService         = errors.New("push service returned an error")
)

func (s *Service) sendOne(payload []byte, endpoint, p256dh, auth string) error {
	sub := &webpush.Subscription{
		Endpoint: endpoint,
		Keys: webpush.Keys{
			P256dh: p256dh,
			Auth:   auth,
		},
	}

	opts := &webpush.Options{
		Subscriber:      s.subject,
		VAPIDPublicKey:  s.vapidKeys.PublicKey,
		VAPIDPrivateKey: s.vapidKeys.PrivateKey,
		TTL:             86400,
	}

	resp, err := webpush.SendNotification(payload, sub, opts)
	if err != nil {
		return err
	}

	if err := resp.Body.Close(); err != nil {
		slog.Warn("close push response body", "err", err)
	}

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("%w: %d", errSubscriptionExpired, resp.StatusCode)
	}

	if resp.StatusCode >= 400 {
		return fmt.Errorf("%w: %d", errPushService, resp.StatusCode)
	}

	return nil
}

func loadOrGenerateVAPIDKeys(keysDir string) (VAPIDKeys, error) {
	keysPath := filepath.Clean(filepath.Join(keysDir, "vapid_keys.json"))

	if data, err := os.ReadFile(keysPath); err == nil {
		var keys VAPIDKeys
		if err := json.Unmarshal(data, &keys); err == nil && keys.PublicKey != "" && keys.PrivateKey != "" {
			return keys, nil
		}
	}

	slog.Info("generating new VAPID keys")

	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return VAPIDKeys{}, err
	}

	keys := VAPIDKeys{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
	}

	if err := os.MkdirAll(keysDir, 0o700); err != nil {
		return VAPIDKeys{}, err
	}

	data, err := json.MarshalIndent(keys, "", "  ") //nolint:gosec // VAPID key export must match the web-push JSON format
	if err != nil {
		return VAPIDKeys{}, err
	}

	if err := os.WriteFile(keysPath, data, 0o600); err != nil {
		return VAPIDKeys{}, err
	}

	slog.Info("VAPID keys saved", "path", keysPath)

	return keys, nil
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}

	return s[:maxLen] + "..."
}
