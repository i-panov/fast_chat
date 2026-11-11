package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

func TestMigrateLegacyUserColumns(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user, err := s.CreateUser(ctx, "legacy@test.local", "legacy", "test", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DB().Where("user_id = ?", user.ID).Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

	// Recreate the pre-sessions shape on top of the current schema.
	if err := s.DB().Exec("ALTER TABLE users ADD COLUMN token text NOT NULL DEFAULT ''").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.DB().Exec("ALTER TABLE users ADD COLUMN token_expires_at datetime").Error; err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().UTC().Add(time.Hour)
	if err := s.DB().Exec("UPDATE users SET token = ?, token_expires_at = ? WHERE id = ?", hashToken("legacy-token"), expiry, user.ID).Error; err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyUserColumns(s.DB()); err != nil {
		t.Fatal(err)
	}
	if s.DB().Migrator().HasColumn(&model.User{}, "token") {
		t.Fatal("legacy token column was not dropped")
	}
	if _, gotUser, ok := s.GetSessionByToken(ctx, "legacy-token"); !ok || gotUser.ID != user.ID {
		t.Fatal("legacy token did not migrate to a session")
	}
}
