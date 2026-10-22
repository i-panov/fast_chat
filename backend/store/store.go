package store

import (
	"log/slog"
	"sync"
	"time"

	"gorm.io/gorm"
)

type Store struct {
	db     *gorm.DB
	codes  *CodeStore
	connMu sync.Mutex
	conns  map[string]int

	onlineMu sync.RWMutex
	online   map[string]struct{}
	// offlineSince is when a user lost the last connection. A short gap is
	// a network drop, and a call survives it; a client that is gone for
	// good holds no call, so the call domain needs the time and not only
	// the flag.
	offlineSince map[string]time.Time
}

func New(db *gorm.DB) *Store {
	return &Store{
		db:           db,
		codes:        NewCodeStore(),
		conns:        make(map[string]int),
		online:       make(map[string]struct{}),
		offlineSince: make(map[string]time.Time),
	}
}

func (s *Store) DB() *gorm.DB {
	return s.db
}

// Ping verifies the underlying database connection is alive.
func (s *Store) Ping() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}

	return sqlDB.Ping()
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
		delete(s.offlineSince, userID)
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
		s.offlineSince[userID] = time.Now()
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

// OfflineSince reports when the user lost the last connection. The zero time
// means the user is online, or was not connected since the start.
func (s *Store) OfflineSince(userID string) time.Time {
	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	return s.offlineSince[userID]
}

func (s *Store) Close() {
	s.onlineMu.Lock()
	s.online = make(map[string]struct{})
	s.offlineSince = make(map[string]time.Time)
	s.onlineMu.Unlock()

	sqlDB, err := s.db.DB()
	if err == nil {
		if closeErr := sqlDB.Close(); closeErr != nil {
			slog.Warn("failed to close database connection", "err", closeErr)
		}
	}
}
