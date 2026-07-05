package store

import (
	"log/slog"
	"sync"

	"gorm.io/gorm"
)

type Store struct {
	db       *gorm.DB
	codes    *CodeStore
	connMu   sync.Mutex
	conns    map[string]int
	onlineMu sync.RWMutex
	online   map[string]struct{}
}

func New(db *gorm.DB) *Store {
	return &Store{
		db:     db,
		codes:  NewCodeStore(),
		conns:  make(map[string]int),
		online: make(map[string]struct{}),
	}
}

func (s *Store) DB() *gorm.DB {
	return s.db
}

func (s *Store) Codes() *CodeStore {
	return s.codes
}

func (s *Store) AddConnection(userID string) bool {
	s.connMu.Lock()
	s.conns[userID]++
	prev := s.conns[userID] - 1
	s.connMu.Unlock()

	if prev == 0 {
		s.onlineMu.Lock()
		s.online[userID] = struct{}{}
		s.onlineMu.Unlock()
		return true
	}
	return false
}

func (s *Store) RemoveConnection(userID string) bool {
	s.connMu.Lock()
	s.conns[userID]--
	remaining := s.conns[userID]

	if remaining <= 0 {
		s.conns[userID] = 0
	}

	s.connMu.Unlock()

	if remaining <= 0 {
		s.onlineMu.Lock()
		delete(s.online, userID)
		s.onlineMu.Unlock()
		return true
	}
	return false
}

func (s *Store) IsOnline(userID string) bool {
	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	_, ok := s.online[userID]

	return ok
}

func (s *Store) Close() {
	s.onlineMu.Lock()
	s.online = make(map[string]struct{})
	s.onlineMu.Unlock()

	sqlDB, err := s.db.DB()
	if err == nil {
		if closeErr := sqlDB.Close(); closeErr != nil {
			slog.Warn("failed to close database connection", "err", closeErr)
		}
	}
}
