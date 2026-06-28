package email

import (
	"fmt"

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
	m := gomail.NewMessage()
	m.SetHeader("From", s.from)
	m.SetHeader("To", recipient)
	m.SetHeader("Subject", "Fast Chat — verification code")
	m.SetBody("text/plain", fmt.Sprintf("Your verification code: %s\n\nIt expires in 10 minutes.", code))

	d := gomail.NewDialer(s.host, s.port, s.username, s.password)

	return d.DialAndSend(m)
}
