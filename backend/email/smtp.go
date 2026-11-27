package email

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// smtpTimeout bounds the whole SMTP exchange, not only the connect. The
// delivery runs synchronously inside the login handler, so a server that
// accepts the connection and then stalls would hold the request forever. A
// var so tests can shrink it.
var smtpTimeout = 15 * time.Second

const subjectVerificationCode = "Fast Chat — verification code"

type SMTPSender struct {
	host     string
	port     int
	username string
	password string
	from     string
}

func NewSMTPSender(host string, port int, username, password, from string) *SMTPSender {
	return &SMTPSender{
		host:     host,
		port:     port,
		username: username,
		password: password,
		from:     from,
	}
}

func (s *SMTPSender) SendCode(recipient, code string) error {
	if err := checkHeaderValue(recipient); err != nil {
		return err
	}

	if err := checkHeaderValue(s.from); err != nil {
		return err
	}

	body := fmt.Sprintf("Your verification code: %s\r\n\r\nIt expires in 10 minutes.", code)
	message := buildMessage(s.from, recipient, subjectVerificationCode, body)

	return s.send(recipient, message)
}

// send performs the SMTP dialogue with a deadline covering every step after
// the dial. STARTTLS is used when the server advertises it; the deployment is
// expected to point at a relay that does, since credentials travel in the
// dialogue.
func (s *SMTPSender) send(recipient string, message []byte) error {
	addr := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	ctx := context.Background()

	dialer := &net.Dialer{Timeout: smtpTimeout}

	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	// Deadline for the whole exchange: read, write, TLS handshake and the
	// final QUIT. Without it a stalled server hangs the login flow.
	if deadlineErr := conn.SetDeadline(time.Now().Add(smtpTimeout)); deadlineErr != nil {
		conn.Close() //nolint:errcheck,gosec // already failing

		return fmt.Errorf("smtp deadline: %w", deadlineErr)
	}

	if s.port == 465 {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12})
		if handshakeErr := tlsConn.HandshakeContext(ctx); handshakeErr != nil {
			conn.Close() //nolint:errcheck,gosec // already failing

			return fmt.Errorf("smtp tls handshake: %w", handshakeErr)
		}
		conn = tlsConn
	}

	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close() //nolint:errcheck,gosec // already failing

		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close() //nolint:errcheck // best-effort: the message is already delivered

	if s.port != 465 {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if tlsErr := client.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); tlsErr != nil {
				return fmt.Errorf("smtp starttls: %w", tlsErr)
			}
		}
	}

	if s.username != "" {
		auth := smtp.PlainAuth("", s.username, s.password, s.host)
		if authErr := client.Auth(auth); authErr != nil {
			return fmt.Errorf("smtp auth: %w", authErr)
		}
	}

	if err := client.Mail(s.from); err != nil {
		return fmt.Errorf("smtp mail from: %w", err)
	}
	if err := client.Rcpt(recipient); err != nil {
		return fmt.Errorf("smtp rcpt to: %w", err)
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := writer.Write(message); err != nil {
		writer.Close() //nolint:errcheck,gosec // already failing

		return fmt.Errorf("smtp write: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("smtp close data: %w", err)
	}

	return client.Quit()
}

// buildMessage renders a single-part UTF-8 text message. The subject is
// encoded so a non-ASCII subject stays a valid header.
func buildMessage(from, to, subject, body string) []byte {
	var buf bytes.Buffer

	buf.WriteString("From: " + from + "\r\n")
	buf.WriteString("To: " + to + "\r\n")
	buf.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	buf.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	buf.WriteString("MIME-Version: 1.0\r\n")
	buf.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	buf.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	buf.WriteString("\r\n")
	buf.WriteString(body)
	buf.WriteString("\r\n")

	return buf.Bytes()
}

// checkHeaderValue rejects CR/LF in an address used as a mail header: a
// direct caller (bypassing isValidEmail-style validation) could otherwise
// inject extra headers through the recipient or the configured sender.
var (
	errEmailAddressEmpty          = errors.New("email address is empty")
	errEmailAddressForbiddenChars = errors.New("email address contains forbidden characters")
)

func checkHeaderValue(addr string) error {
	if addr == "" {
		return errEmailAddressEmpty
	}

	if strings.ContainsAny(addr, "\r\n") {
		return errEmailAddressForbiddenChars
	}

	return nil
}
