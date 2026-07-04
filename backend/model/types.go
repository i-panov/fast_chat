// Package model provides data types for the chat application.
package model

import "time"

type User struct {
	ID             string    `gorm:"primaryKey"           json:"id"`
	Email          string    `gorm:"uniqueIndex;not null" json:"email"`
	Nick           string    `gorm:"uniqueIndex;not null" json:"nick"`
	Token          string    `gorm:"uniqueIndex;not null" json:"-"`
	TokenExpiresAt time.Time `gorm:"not null"             json:"-"`
	Online         bool      `gorm:"default:false"        json:"online"`
}

type PublicUser struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Online bool   `json:"online"`
}

func (u *User) Public() PublicUser {
	return PublicUser{ID: u.ID, Nick: u.Nick, Online: u.Online}
}

func PublicUsers(users []User) []PublicUser {
	out := make([]PublicUser, len(users))
	for i := range users {
		out[i] = users[i].Public()
	}

	return out
}

type Chat struct {
	ID           string    `gorm:"primaryKey"              json:"id"`
	Type         string    `gorm:"default:'private';index" json:"type"`
	Name         string    `gorm:"default:''"              json:"name"`
	OwnerID      string    `gorm:"default:''"              json:"ownerId"`
	AvatarFileID string    `gorm:"default:''"              json:"-"`
	Members      []string  `gorm:"-"                       json:"-"`
	CreatedAt    time.Time `gorm:"not null"                json:"createdAt"`
	RemoteServer string    `gorm:"default:''"              json:"-"`
}

type ReplyToInfo struct {
	MessageID string     `json:"messageId"`
	Text      string     `json:"text"`
	FromNick  string     `json:"fromNick"`
	Files     []FileInfo `json:"files,omitempty"`
	Location  *Location  `json:"location,omitempty"`
}

type Location struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type File struct {
	ID           string    `gorm:"primaryKey;not null"  json:"id"`
	Hash         string    `gorm:"uniqueIndex;not null" json:"hash"`
	MimeType     string    `gorm:"not null"             json:"mimeType"`
	Size         int64     `gorm:"not null"             json:"size"`
	OriginalName string    `gorm:"not null"             json:"originalName"`
	StoragePath  string    `gorm:"not null"             json:"-"`
	CreatedAt    time.Time `gorm:"not null"             json:"createdAt"`
}

type MessageFile struct {
	MessageID string `gorm:"primaryKey"`
	FileID    string `gorm:"primaryKey"`
}

type FileInfo struct {
	ID           string `json:"id"`
	MimeType     string `json:"mimeType"`
	Size         int64  `json:"size"`
	OriginalName string `json:"originalName"`
	FileType     string `json:"fileType"`
	URL          string `json:"url"`
}

func (f *File) ToFileInfo() FileInfo {
	ft := "file"
	if len(f.MimeType) >= 6 && f.MimeType[:6] == "image/" {
		ft = "photo"
	} else if len(f.MimeType) >= 6 && f.MimeType[:6] == "video/" {
		ft = "video"
	} else if len(f.MimeType) >= 6 && f.MimeType[:6] == "audio/" {
		ft = "audio"
	}

	return FileInfo{
		ID:           f.ID,
		MimeType:     f.MimeType,
		Size:         f.Size,
		OriginalName: f.OriginalName,
		FileType:     ft,
		URL:          "/api/files/" + f.ID,
	}
}

type Message struct {
	ID        string       `gorm:"primaryKey"         json:"id"`
	ChatID    string       `gorm:"index;not null"     json:"chatId"`
	FromID    string       `gorm:"not null"           json:"fromId"`
	FromNick  string       `gorm:"not null"           json:"fromNick"`
	Text      string       `gorm:"not null"           json:"text"`
	CreatedAt time.Time    `gorm:"not null;default:0" json:"createdAt"`
	UpdatedAt time.Time    `gorm:"not null;default:0" json:"-"`
	EditedAt  *time.Time   `json:"editedAt,omitempty"`
	ReplyTo   *ReplyToInfo `gorm:"serializer:json"    json:"replyTo,omitempty"`
	Location  *Location    `gorm:"serializer:json"    json:"location,omitempty"`
	Files     []FileInfo   `gorm:"-"                  json:"files,omitempty"`
}

type DeletedMessage struct {
	ChatID    string    `gorm:"primaryKey"     json:"chatId"`
	MessageID string    `gorm:"primaryKey"     json:"messageId"`
	DeletedAt time.Time `gorm:"index;not null" json:"deletedAt"`
}

type DeletedChat struct {
	ChatID    string    `gorm:"primaryKey"     json:"chatId"`
	UserID    string    `gorm:"primaryKey"     json:"userId"`
	DeletedAt time.Time `gorm:"index;not null" json:"deletedAt"`
}

type PushSubscription struct {
	ID        string    `gorm:"primaryKey"           json:"id"`
	UserID    string    `gorm:"index;not null"       json:"userId"`
	Endpoint  string    `gorm:"uniqueIndex;not null" json:"endpoint"`
	P256DH    string    `gorm:"not null"             json:"p256dh"` //nolint:tagliatelle
	Auth      string    `gorm:"not null"             json:"auth"`
	CreatedAt time.Time `gorm:"not null"             json:"createdAt"`
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

type MessageReadStatus struct {
	MessageID string    `gorm:"primaryKey"          json:"messageId"`
	UserID    string    `gorm:"primaryKey"          json:"userId"`
	Status    string    `gorm:"default:'delivered'" json:"status"` // delivered | read
	ReadAt    time.Time `gorm:"not null"            json:"readAt"`
}
