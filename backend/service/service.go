// Package service holds the framework-independent business logic of the
// application. Handlers (the HTTP transport layer) delegate to service
// methods, which operate only on the store, the realtime hub, configuration
// and external senders — never on http.Request/ResponseWriter.
package service

import (
	"log/slog"

	"fast_chat/calls"
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
	// hub is the realtime hub. It stays concrete: the typing state and the
	// federation tests work with the connections themselves.
	hub *sse.Hub
	// events is the fan-out of the service. It is an interface, so the rules
	// can be tested without a hub: the real one satisfies it unchanged.
	events eventSender
	cfg    *config.Config
	email  email.Sender
	push   pushSender
	// fed is the signed server-to-server client. It is optional: without it
	// the federation catch-up does not run, and only the local server talks
	// to its peers.
	fed federationSender
	// calls is the registry of the ongoing calls. It is optional: without it
	// the call domain is disabled.
	calls *calls.Manager
}

// eventSender is the part of the SSE hub the service uses.
type eventSender interface {
	Send(userID string, event sse.Event)
}

// sendEvent delivers an event to the connections of a user. A service without
// a fan-out (some of the tests build one by hand) drops the events.
func (s *Service) sendEvent(userID string, event sse.Event) {
	if s.events == nil {
		return
	}

	s.events.Send(userID, event)
}

// New builds a Service bound to the given store, hub and config. The email
// sender is derived from the config each time so constructor callers never
// have to reason about SMTP vs debug mode.
func New(s *store.Store, cfg *config.Config, hub *sse.Hub, ps *push.Service) *Service {
	svc := &Service{
		store:  s,
		hub:    hub,
		events: hub,
		cfg:    cfg,
		email:  newEmailSender(cfg),
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
