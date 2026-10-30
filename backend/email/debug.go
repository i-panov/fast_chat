// Package email provides email sending via SMTP and debug mode.
package email

import "log/slog"

type DebugSender struct{}

func NewDebugSender() *DebugSender {
	return &DebugSender{}
}

func (s *DebugSender) SendCode(recipient, code string) error {
	// The code is never logged: a debug sender enabled in production by
	// accident would otherwise leak OTPs into the logs. The argument is
	// kept (and explicitly ignored) so the call sites stay unchanged.
	_ = code

	slog.Info("debug email code requested",
		"recipient", recipient,
	)

	return nil
}
