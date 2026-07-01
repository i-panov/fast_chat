// Package email provides email sending via SMTP and debug mode.
package email

import "log/slog"

type DebugSender struct{}

func NewDebugSender() *DebugSender {
	return &DebugSender{}
}

func (s *DebugSender) SendCode(recipient, code string) error {
	slog.Info("debug email code",
		"recipient", recipient,
		"code", code,
	)

	return nil
}
