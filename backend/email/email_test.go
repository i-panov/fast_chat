package email

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestDebugSenderSendCode(t *testing.T) {
	var buf bytes.Buffer
	orig := slog.Default()
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	slog.SetDefault(logger)
	defer slog.SetDefault(orig)

	s := NewDebugSender()
	if err := s.SendCode("user@test.local", "123456"); err != nil {
		t.Fatalf("SendCode: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "123456") {
		t.Errorf("debug output should contain the code, got: %s", out)
	}
	if !strings.Contains(out, "user@test.local") {
		t.Errorf("debug output should contain the recipient, got: %s", out)
	}
}

func TestSMTPSenderUnreachableReturnsError(t *testing.T) {
	// A closed port should make DialAndSend fail fast, proving the
	// error path and constructor wiring.
	s := NewSMTPSender("127.0.0.1", 1, "user", "pass", "from@test.local")
	if err := s.SendCode("to@test.local", "000000"); err == nil {
		t.Fatal("expected an error dialing an unreachable SMTP server")
	}
}

func TestNewSMTPSenderFields(t *testing.T) {
	s := NewSMTPSender("smtp.example.com", 587, "u", "p", "f@x.test")
	if s.host != "smtp.example.com" || s.port != 587 || s.username != "u" || s.password != "p" || s.from != "f@x.test" {
		t.Errorf("NewSMTPSender did not capture fields: %+v", s)
	}
}
