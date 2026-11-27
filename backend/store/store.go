package store

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"gorm.io/gorm"
)

type Store struct {
	db     *gorm.DB
	codes  *CodeStore
	connMu sync.RWMutex
	conns  map[string]int
	// sessionConns counts the open connections of each session. A session is
	// online while it holds at least one connection, independently of the
	// other sessions of the same user.
	sessionConns map[string]int

	onlineMu sync.RWMutex
	online   map[string]struct{}
	// offlineSince is when a user lost the last connection. A short gap is
	// a network drop, and a call survives it; a client that is gone for
	// good holds no call, so the call domain needs the time and not only
	// the flag.
	offlineSince map[string]time.Time

	// refreshMu guards lastRotations: the token issued by the latest rotation
	// of a session, kept briefly so concurrent refreshes of one device do not
	// mint two different tokens and kill each other.
	refreshMu     sync.Mutex
	lastRotations map[string]cachedRotation
}

// cachedRotation is the token the last rotation of a session issued, and when.
type cachedRotation struct {
	token     string
	rotatedAt time.Time
}

func New(db *gorm.DB) *Store {
	return &Store{
		db:            db,
		codes:         NewCodeStore(),
		conns:         make(map[string]int),
		sessionConns:  make(map[string]int),
		online:        make(map[string]struct{}),
		offlineSince:  make(map[string]time.Time),
		lastRotations: make(map[string]cachedRotation),
	}
}

func (s *Store) DB() *gorm.DB {
	return s.db
}

// Ping verifies the underlying database connection is alive.
func (s *Store) Ping(ctx context.Context) error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}

	return sqlDB.PingContext(ctx)
}

func (s *Store) Codes() *CodeStore {
	return s.codes
}

// AddConnectionForSession records a connection of a session. It reports
// whether this connection made the user go online. An empty sessionID is a
// legacy connection that only tracks the user presence.
func (s *Store) AddConnectionForSession(userID, sessionID string) bool {
	s.connMu.Lock()
	s.conns[userID]++
	prev := s.conns[userID] - 1
	if sessionID != "" {
		s.sessionConns[sessionID]++
	}
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

// RemoveConnectionForSession drops a connection of a session. It reports
// whether this was the last connection of the user. An empty sessionID is a
// legacy connection that only tracks the user presence.
func (s *Store) RemoveConnectionForSession(userID, sessionID string) bool {
	s.connMu.Lock()
	connCount, ok := s.conns[userID]
	if !ok || connCount <= 0 {
		// A disconnect for a stranger (or a duplicate disconnect) is not
		// an offline transition: report false without stamping offline
		// and without growing the map.
		if ok {
			delete(s.conns, userID)
		}
		if sessionID != "" {
			// A duplicate disconnect is still one connection of this
			// session gone: decrement instead of clearing the count, or
			// the remaining connections would look offline.
			if s.sessionConns[sessionID] <= 1 {
				delete(s.sessionConns, sessionID)
			} else {
				s.sessionConns[sessionID]--
			}
		}
		s.connMu.Unlock()
		return false
	}

	connCount--
	remaining := connCount
	if connCount == 0 {
		delete(s.conns, userID)
	} else {
		s.conns[userID] = connCount
	}

	if sessionID != "" {
		if s.sessionConns[sessionID] <= 1 {
			delete(s.sessionConns, sessionID)
		} else {
			s.sessionConns[sessionID]--
		}
	}

	s.connMu.Unlock()

	if remaining == 0 {
		s.onlineMu.Lock()
		delete(s.online, userID)
		s.offlineSince[userID] = time.Now()
		s.onlineMu.Unlock()
		return true
	}
	return false
}

// IsSessionOnline reports whether the session holds an open connection. An
// empty session id is never online: it does not identify a session.
func (s *Store) IsSessionOnline(sessionID string) bool {
	if sessionID == "" {
		return false
	}

	s.connMu.RLock()
	defer s.connMu.RUnlock()

	return s.sessionConns[sessionID] > 0
}

// SetPresence marks a bot online or offline. Bots have no SSE connection of
// their own, so the connection counters cannot drive their status. It
// reports whether the state changed, so the caller only broadcasts a
// transition.
func (s *Store) SetPresence(userID string, online bool) bool {
	s.onlineMu.Lock()
	defer s.onlineMu.Unlock()

	_, exists := s.online[userID]
	if exists == online {
		return false
	}
	if online {
		s.online[userID] = struct{}{}
	} else {
		delete(s.online, userID)
	}

	return true
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
	s.connMu.Lock()
	s.conns = make(map[string]int)
	s.sessionConns = make(map[string]int)
	s.connMu.Unlock()

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
