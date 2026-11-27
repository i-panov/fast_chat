package model

import "time"

// AdminAuditLog records a moderation action. It is append-only: entries are
// never edited or deleted by the application, so a compromised admin session
// still leaves a trail.
type AdminAuditLog struct {
	ID         string `gorm:"primaryKey"          json:"id"`
	ActorID    string `gorm:"index;not null"      json:"actorId"`
	Action     string `gorm:"not null"            json:"action"`
	TargetType string `gorm:"not null"            json:"targetType"`
	TargetID   string `gorm:"not null"            json:"targetId"`
	Detail     string `gorm:"not null;default:''" json:"detail,omitempty"`
	// IP and UserAgent identify the device that performed the action. The
	// account alone does not tell a stolen session from the owner.
	IP        string    `gorm:"not null;default:''" json:"ip,omitempty"`
	UserAgent string    `gorm:"not null;default:''" json:"userAgent,omitempty"`
	CreatedAt time.Time `gorm:"index;not null"      json:"createdAt"`
}
