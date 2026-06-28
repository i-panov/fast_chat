package email

type Sender interface {
	SendCode(recipient, code string) error
}
