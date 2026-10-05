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
	PublicKey      string    `gorm:"not null;default:''"  json:"-"` // E2E X25519 public key (base64)
	KeyBackup      string    `gorm:"not null;default:''"  json:"-"` // client-encrypted private key backup blob (base64)
	KeyBackupAt    time.Time `gorm:"default:null"         json:"-"` // when the backup blob was last written
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
	ID           string    `gorm:"primaryKey;not null" json:"id"`
	Hash         string    `gorm:"not null"            json:"hash"`
	MimeType     string    `gorm:"not null"            json:"mimeType"`
	Size         int64     `gorm:"not null"            json:"size"`
	OriginalName string    `gorm:"not null"            json:"originalName"`
	StoragePath  string    `gorm:"not null"            json:"-"`
	CreatedAt    time.Time `gorm:"not null"            json:"createdAt"`
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
	// Hash is the SHA-256 hex digest of the plaintext file content. Used by the
	// client to match decryption keys to files (keys are indexed by hash, not
	// file ID, because IDs differ between sender and receiver).
	Hash string `json:"hash"`
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
		Hash:         f.Hash,
	}
}

// Message is a single chat message.
//
// CreatedAt and UpdatedAt deliberately carry no column default. GORM resolves
// a `default:` tag into a concrete time.Time while parsing the schema and
// renders it as a literal column DEFAULT. Because that resolved value is
// non-nil, the create callback substitutes it into every INSERT that omits
// the field, in preference to GORM's own autoCreateTime/autoUpdateTime
// tracking. An insert that omits them therefore stores midnight of the first
// AutoMigrate run and then fails the `updated_at >= since` filter of the sync
// delta. See store.repairFrozenUpdatedAt.
type Message struct {
	ID string `gorm:"primaryKey" json:"id"`
	// ChatID is always the chat the message belongs to, including for thread
	// messages; ThreadID carries the thread and is empty for chat messages.
	// Overloading ChatID with the thread id would hide thread messages from
	// every chat-scoped query (deletion, read receipts, file access).
	ChatID string `gorm:"index;not null" json:"chatId"`
	// ThreadID stays nullable on purpose. AutoMigrate adds a new column as
	// NULL for existing rows, and the pass that normalises those NULLs to the
	// empty string runs after it; declaring NOT NULL would fail on the rows
	// that exist at that moment. Queries therefore use threadIDIsEmpty, which
	// treats NULL as chat level. No index tag is needed because
	// idx_messages_thread_created already leads with this column.
	ThreadID         string       `json:"-"`
	FromID           string       `gorm:"not null"               json:"fromId"`
	FromNick         string       `gorm:"not null"               json:"fromNick"`
	Text             string       `gorm:"not null"               json:"text"`
	Encrypted        bool         `gorm:"not null;default:false" json:"encrypted"`
	EncryptedPayload string       `gorm:"not null;default:''"    json:"encryptedPayload"`
	CreatedAt        time.Time    `gorm:"not null"               json:"createdAt"`
	UpdatedAt        time.Time    `gorm:"not null"               json:"-"`
	EditedAt         *time.Time   `json:"editedAt,omitempty"`
	ReplyTo          *ReplyToInfo `gorm:"serializer:json"        json:"replyTo,omitempty"`
	Location         *Location    `gorm:"serializer:json"        json:"location,omitempty"`
	Files            []FileInfo   `gorm:"-"                      json:"files,omitempty"`
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
	P256DH    string    `gorm:"not null"             json:"p256dh"` //nolint:tagliatelle // field names fixed by the Web Push protocol
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
