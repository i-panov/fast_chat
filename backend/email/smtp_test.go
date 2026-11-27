package email

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// startFakeSMTP runs a minimal SMTP responder on a loopback port. The returned
// channels receive the DATA body of the first message and its MAIL FROM line.
func startFakeSMTP(t *testing.T) (string, int, <-chan string, <-chan string) {
	t.Helper()

	var listenCfg net.ListenConfig

	listener, err := listenCfg.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	delivered := make(chan string, 1)
	mailFrom := make(chan string, 1)

	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		writer := bufio.NewWriter(conn)
		reader := bufio.NewReader(conn)

		write := func(line string) {
			_, _ = writer.WriteString(line + "\r\n")
			_ = writer.Flush()
		}

		write("220 fake ESMTP")

		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			command := strings.ToUpper(strings.TrimSpace(line))

			switch {
			case strings.HasPrefix(command, "EHLO"), strings.HasPrefix(command, "HELO"):
				write("250-fake")
				write("250 8BITMIME")
			case strings.HasPrefix(command, "MAIL FROM"):
				mailFrom <- strings.TrimSpace(line)
				write("250 OK")
			case strings.HasPrefix(command, "RCPT TO"):
				write("250 OK")
			case strings.HasPrefix(command, "DATA"):
				write("354 go ahead")

				var body strings.Builder
				for {
					dataLine, dataErr := reader.ReadString('\n')
					if dataErr != nil {
						return
					}
					if dataLine == ".\r\n" {
						break
					}
					body.WriteString(dataLine)
				}
				delivered <- body.String()
				write("250 queued")
			case strings.HasPrefix(command, "QUIT"):
				write("221 bye")

				return
			default:
				write("250 OK")
			}
		}
	}()

	addr := listener.Addr().(*net.TCPAddr)

	return "127.0.0.1", addr.Port, delivered, mailFrom
}

func TestSendCodeDeliversTheCode(t *testing.T) {
	host, port, messages, _ := startFakeSMTP(t)

	sender := NewSMTPSender(host, port, "", "", "no-reply@example.test")
	if err := sender.SendCode("alice@example.test", "123456"); err != nil {
		t.Fatalf("SendCode: %v", err)
	}

	select {
	case body := <-messages:
		if !strings.Contains(body, "123456") {
			t.Fatalf("delivered body has no code: %q", body)
		}
		if !strings.Contains(body, "To: alice@example.test") {
			t.Fatalf("delivered body has no recipient: %q", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the message was not delivered")
	}
}

// A display name in the configured sender belongs in the From header only:
// net/smtp sends MAIL FROM verbatim inside angle brackets, so the envelope
// must carry the bare address or the server rejects it (501 5.1.8).
func TestSendCodeUsesBareAddressInMailFrom(t *testing.T) {
	host, port, messages, mailFrom := startFakeSMTP(t)

	sender := NewSMTPSender(host, port, "", "", "Fast Chat <fast_chat@example.test>")
	if err := sender.SendCode("alice@example.test", "654321"); err != nil {
		t.Fatalf("SendCode: %v", err)
	}

	select {
	case got := <-mailFrom:
		// net/smtp appends ESMTP parameters (BODY=8BITMIME) after the address.
		want := "MAIL FROM:<fast_chat@example.test>"
		if !strings.HasPrefix(got, want) {
			t.Fatalf("MAIL FROM = %q, want prefix %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no MAIL FROM was sent")
	}

	select {
	case body := <-messages:
		if !strings.Contains(body, "From: Fast Chat <fast_chat@example.test>") {
			t.Fatalf("delivered body lost the display name: %q", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the message was not delivered")
	}
}

// A server that accepts the connection and then stalls must not hang the
// login flow: the exchange has a deadline.
func TestSendCodeGivesUpOnAStalledServer(t *testing.T) {
	var listenCfg net.ListenConfig

	listener, err := listenCfg.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	stalled := make(chan struct{})
	defer close(stalled)

	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		// Accept and say nothing.
		<-stalled
		_ = conn.Close()
	}()

	previous := smtpTimeout
	smtpTimeout = 100 * time.Millisecond
	t.Cleanup(func() { smtpTimeout = previous })

	addr := listener.Addr().(*net.TCPAddr)
	sender := NewSMTPSender("127.0.0.1", addr.Port, "", "", "no-reply@example.test")

	started := time.Now()

	err = sender.SendCode("alice@example.test", "123456")
	if err == nil {
		t.Fatal("a stalled server must fail the send")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("SendCode blocked for %v", elapsed)
	}
}

// The message headers are composed by hand: a header injection through the
// recipient or the sender must be refused before anything is written.
func TestSendCodeRejectsHeaderInjection(t *testing.T) {
	host, port, _, _ := startFakeSMTP(t)
	sender := NewSMTPSender(host, port, "", "", "no-reply@example.test")

	if err := sender.SendCode("alice@example.test\r\nBcc: victim@example.test", "1"); err == nil {
		t.Fatal("a CRLF in the recipient must be rejected")
	}
}
