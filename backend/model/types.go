package model

import "time"

type User struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Token  string `json:"token,omitempty"`
	Online bool   `json:"online"`
}

type Chat struct {
	ID        string    `json:"id"`
	Members   []string  `json:"-"`
	CreatedAt time.Time `json:"createdAt"`
}

type Message struct {
	ID        string    `json:"id"`
	ChatID    string    `json:"chatId"`
	FromID    string    `json:"fromId"`
	FromNick  string    `json:"fromNick"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}
