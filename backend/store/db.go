// Package store provides data persistence using SQLite via GORM.
package store

import (
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

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &ChatMember{}, &model.Message{}, &model.Thread{}); err != nil {
		return nil, err
	}

	// All users offline on start
	db.Model(&model.User{}).Where("1 = 1").Update("online", false)

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	sqlDB.SetMaxOpenConns(1)

	return db, nil
}
