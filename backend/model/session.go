package model

import "time"

// Session is one logged-in device of an account. The plaintext token is
// never stored: TokenHash is the SHA-256 digest of the bearer token.
type Session struct {
	ID         string     `gorm:"primaryKey"                                    json:"id"`
	UserID     string     `gorm:"uniqueIndex:idx_sessions_user_device;not null" json:"-"`
	DeviceID   string     `gorm:"uniqueIndex:idx_sessions_user_device;not null" json:"deviceId"`
	DeviceName string     `gorm:"not null;default:''"                           json:"deviceName"`
	TokenHash  string     `gorm:"uniqueIndex;not null"                          json:"-"`
	UserAgent  string     `gorm:"not null;default:''"                           json:"-"`
	CreatedAt  time.Time  `gorm:"not null"                                      json:"createdAt"`
	LastSeenAt time.Time  `gorm:"not null"                                      json:"lastSeenAt"`
	ExpiresAt  time.Time  `gorm:"index;not null"                                json:"expiresAt"`
	RevokedAt  *time.Time `gorm:"index"                                         json:"-"`
	// PrevTokenHash keeps the token a rotation just replaced usable for a
	// short grace window. Two tabs of one device share the session, and
	// without the window a simultaneous refresh killed the token the other
	// tab had just received.
	PrevTokenHash string     `gorm:"not null;default:''" json:"-"`
	PrevExpiresAt *time.Time `json:"-"`
}

// Active reports whether the session may authenticate a request at now.
func (s *Session) Active(now time.Time) bool {
	return s.RevokedAt == nil && now.Before(s.ExpiresAt)
}
