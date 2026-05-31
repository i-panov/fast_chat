// Package model defines the core data structures for the chat application.
package model

import "time"

// User represents a chat participant.
type User struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Token  string `json:"token,omitempty"`
	Online bool   `json:"online"`
}

// Chat represents a private conversation between two users.
type Chat struct {
	ID        string    `json:"id"`
	Members   []string  `json:"-"`
	CreatedAt time.Time `json:"created_at"`
}

// Message represents a single message within a chat.
type Message struct {
	ID        string    `json:"id"`
	ChatID    string    `json:"chat_id"`
	FromID    string    `json:"from_id"`
	FromNick  string    `json:"from_nick"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"created_at"`
}
