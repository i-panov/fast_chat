// Package model provides data types for the chat application.
package model

import "time"

// User represents a chat user.
type User struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Token  string `json:"token,omitempty"`
	Online bool   `json:"online"`
}

// Chat represents a private conversation between users.
type Chat struct {
	ID           string    `json:"id"`
	Members      []string  `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
	RemoteServer string    `json:"-"` // empty = local chat, "host:port" = federated
}

// Message represents a single message within a chat.
type Message struct {
	ID        string     `json:"id"`
	ChatID    string     `json:"chatId"`
	FromID    string     `json:"fromId"`
	FromNick  string     `json:"fromNick"`
	Text      string     `json:"text"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
}
