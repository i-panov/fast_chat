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
	mail := gomail.NewMessage()
	mail.SetHeader("From", s.from)
	mail.SetHeader("To", recipient)
	mail.SetHeader("Subject", "Fast Chat — verification code")
	mail.SetBody("text/plain", fmt.Sprintf("Your verification code: %s\n\nIt expires in 10 minutes.", code))

	d := gomail.NewDialer(s.host, s.port, s.username, s.password)

	return d.DialAndSend(mail)
}
