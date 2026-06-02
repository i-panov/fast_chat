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

// ReplyToInfo holds a snapshot of the message being replied to.
type ReplyToInfo struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
	FromNick  string `json:"fromNick"`
}

// Message represents a single message within a chat.
type Message struct {
	ID        string       `json:"id"`
	ChatID    string       `json:"chatId"`
	FromID    string       `json:"fromId"`
	FromNick  string       `json:"fromNick"`
	Text      string       `json:"text"`
	CreatedAt time.Time    `json:"createdAt"`
	EditedAt  *time.Time   `json:"editedAt,omitempty"`
	ReplyTo   *ReplyToInfo `json:"replyTo,omitempty"`
}

// Thread represents a discussion thread attached to a specific message in a chat.
type Thread struct {
	ID                string    `json:"id"`
	ChatID            string    `json:"chatId"`
	ParentMessageID   string    `json:"parentMessageId"`
	ParentMessageText string    `json:"parentMessageText"`
	ParentMessageFrom string    `json:"parentMessageFrom"`
	CreatedAt         time.Time `json:"createdAt"`
	MessageCount      int       `json:"messageCount"`
}
