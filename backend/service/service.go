// Package service holds the framework-independent business logic of the
// application. Handlers (the HTTP transport layer) delegate to service
// methods, which operate only on the store, the realtime hub, configuration
// and external senders — never on http.Request/ResponseWriter.
package service

import (
	"log/slog"

	"fast_chat/config"
	"fast_chat/email"
	"fast_chat/model"
	"fast_chat/push"
	"fast_chat/sse"
	"fast_chat/store"
)

// log returns the process default logger at call time, so a logger configured
// later via slog.SetDefault (e.g. request-context tracing in main) is picked
// up instead of being captured once at package init.
func log() *slog.Logger {
	return slog.Default()
}

// pushSender abstracts the web-push delivery service so the service can be
// tested without network access.
type pushSender interface {
	SendToUser(payload []byte, subscriptions []model.PushSubscription)
}

// Service aggregates every external dependency required by the business
// logic so a handler (or any future transport, e.g. Huma operations) only
// has to hold a single reference. Fields are unexported: they are wired once
// by New and cannot be swapped afterwards.
type Service struct {
	store *store.Store
	// hub is wired now but unused by the auth domain; it will be consumed by
	// the realtime fan-out (chat/user-status) work in later migration steps.
	hub   *sse.Hub
	cfg   *config.Config
	email email.Sender
	push  pushSender
}

// New builds a Service bound to the given store, hub and config. The email
// sender is derived from the config each time so constructor callers never
// have to reason about SMTP vs debug mode.
func New(s *store.Store, cfg *config.Config, hub *sse.Hub, ps *push.Service) *Service {
	svc := &Service{
		store: s,
		hub:   hub,
		cfg:   cfg,
		email: newEmailSender(cfg),
	}
	// Guard against a nil *push.Service being wrapped in a non-nil pushSender
	// interface, which would defeat the `s.push == nil` check in SendPushForMessage.
	if ps != nil {
		svc.push = ps
	}

	return svc
}

//nolint:ireturn // the two concrete senders are interchangeable; callers hold email.Sender
func newEmailSender(cfg *config.Config) email.Sender {
	if cfg.Email.DebugMode {
		return email.NewDebugSender()
	}

	if cfg.Email.SMTP.Host != "" {
		return email.NewSMTPSender(
			cfg.Email.SMTP.Host,
			cfg.Email.SMTP.Port,
			cfg.Email.SMTP.Username,
			cfg.Email.SMTP.Password,
			cfg.Email.SMTP.From,
		)
	}

	return email.NewDebugSender()
}
