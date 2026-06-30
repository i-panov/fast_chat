// Package store provides data persistence using SQLite via GORM.
package store

import (
	"log/slog"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"fast_chat/model"
)

type ChatMember struct {
	ChatID string `gorm:"primaryKey"`
	UserID string `gorm:"primaryKey"`
}

func InitDB(dsn string) (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, err
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}); err != nil {
		return nil, err
	}

	if err := createIndexes(db); err != nil {
		return nil, err
	}

	// Migration: delete users without email (from old registration system).
	if err := db.Where("email = '' OR email IS NULL").Delete(&model.User{}).Error; err != nil {
		slog.Warn("failed to migrate users without email", "err", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	sqlDB.SetMaxOpenConns(4)

	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, err
	}

	if _, err := sqlDB.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return nil, err
	}

	return db, nil
}
