package email

import (
	"errors"
	"fmt"
	"strings"

	gomail "gopkg.in/gomail.v2"
)

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

	mail := gomail.NewMessage()
	mail.SetHeader("From", s.from)
	mail.SetHeader("To", recipient)
	mail.SetHeader("Subject", "Fast Chat — verification code")
	mail.SetBody("text/plain", fmt.Sprintf("Your verification code: %s\n\nIt expires in 10 minutes.", code))

	d := gomail.NewDialer(s.host, s.port, s.username, s.password)

	return d.DialAndSend(mail)
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
