// Package model provides data types shared across the application.
package model

import "time"

type User struct {
	ID     string `gorm:"primaryKey"           json:"id"`
	Nick   string `gorm:"not null"             json:"nick"`
	Token  string `gorm:"uniqueIndex;not null" json:"token,omitempty"`
	Online bool   `gorm:"default:false"        json:"online"`
}

type Chat struct {
	ID           string    `gorm:"primaryKey" json:"id"`
	Members      []string  `gorm:"-"          json:"-"`
	CreatedAt    time.Time `gorm:"not null"   json:"createdAt"`
	RemoteServer string    `gorm:"default:''" json:"-"`
}

type ReplyToInfo struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
	FromNick  string `json:"fromNick"`
}

type Message struct {
	ID        string       `gorm:"primaryKey"         json:"id"`
	ChatID    string       `gorm:"index;not null"     json:"chatId"`
	FromID    string       `gorm:"not null"           json:"fromId"`
	FromNick  string       `gorm:"not null"           json:"fromNick"`
	Text      string       `gorm:"not null"           json:"text"`
	CreatedAt time.Time    `gorm:"not null"           json:"createdAt"`
	EditedAt  *time.Time   `json:"editedAt,omitempty"`
	ReplyTo   *ReplyToInfo `gorm:"serializer:json"    json:"replyTo,omitempty"`
}

type Thread struct {
	ID                string    `gorm:"primaryKey"     json:"id"`
	ChatID            string    `gorm:"index;not null" json:"chatId"`
	ParentMessageID   string    `gorm:"not null"       json:"parentMessageId"`
	ParentMessageText string    `gorm:"not null"       json:"parentMessageText"`
	ParentMessageFrom string    `gorm:"not null"       json:"parentMessageFrom"`
	CreatedAt         time.Time `gorm:"not null"       json:"createdAt"`
	MessageCount      int       `gorm:"default:0"      json:"messageCount"`
}
