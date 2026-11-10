# Мультидевайс Phase A — backend-сессии. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать одному аккаунту несколько независимых сессий на разных
устройствах, не ломая существующие токены и текущий frontend.

**Architecture:** Новая таблица `sessions` становится единственным
источником истины для Bearer-токенов. `users.token` временно остаётся для
backfill и отката. Сессия привязывается к `deviceId`, SSE/push/presence
учатся различать сессии, но presence и звонки остаются на уровне
пользователя.

**Tech Stack:** Go 1.26, Huma v2, GORM + SQLite, SSE, Web Push.

**Scope:** только backend. Frontend (deviceId, экран устройств, refresh
между вкладками) и E2EE guard — отдельные планы. Старый frontend
продолжает работать: старые токены бэкфиллятся в сессии.

**Commits:** по AGENTS.md коммиты запрещены без явного разрешения
пользователя. Шаги «Commit» в этом плане выполнять только после отдельной
команды.

**Порядок выполнения:** задачи 4–8 меняют один компилируемый кусок.
Рекомендуемый порядок: 1, 2, 3, 3b, 7 (store presence/push), 6 (SSE),
4 (service), 5 (transport), 8 (calls push), 9, 10. Если идти строго по
номерам, методы из 6/7 появятся позже, чем их вызовы в 4.

---

## File map

Создаются:

- `backend/model/session.go` — модель `Session`.
- `backend/store/sessions.go` — CRUD сессий, backfill, cleanup.
- `backend/store/sessions_test.go` — тесты store-слоя.
- `backend/service/sessions.go` — сервисные операции со сессиями, device
  info, trim.
- `backend/service/sessions_test.go` — тесты сервиса.
- `backend/transport/sessions.go` — API списка/отзыва сессий.
- `backend/transport/sessions_test.go` — тесты API и middleware.

Меняются:

- `backend/model/types.go` — `PushSubscription.SessionID`.
- `backend/store/db.go` — AutoMigrate `Session`, backfill.
- `backend/store/users.go` — `CreateUserWithSession`, `GetUserByToken`
  через сессию.
- `backend/store/push.go` — подписки на сессию, удаление по сессии.
- `backend/store/store.go` — presence по сессиям.
- `backend/service/auth.go` — verify/complete/refresh/logout через сессии.
- `backend/service/push.go` — push только offline-сессиям.
- `backend/service/calls.go` — push о звонке только offline-сессиям.
- `backend/service/service.go` — запуск cleanup сессий.
- `backend/transport/auth.go` — device info, новые ответы, middleware.
- `backend/transport/push.go` — привязка подписки к сессии.
- `backend/transport/transport.go` — heartbeat и SSE по сессии.
- `backend/sse/hub.go` — `SessionID`, `CloseSession`, `CloseUserSessions`,
  `UpdateSessionExpiry`.
- `backend/config/config.go` — `auth.max_sessions_per_user`.
- `backend/main.go` — запуск cleanup worker.
- `config/dev.yaml`, `config/prod.yaml.example` — новый параметр.
- `README.md` — API сессий.

---

## Task 1: модель Session и миграция

**Files:**
- Create: `backend/model/session.go`
- Modify: `backend/store/db.go`
- Test: `backend/store/sessions_test.go`

- [ ] **Step 1: Написать падающий тест backfill**

`backend/store/sessions_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
	"gorm.io/gorm"
)

func newSessionTestStore(t *testing.T) *Store {
	t.Helper()
	s := newTestStore(t)
	if err := s.DB().AutoMigrate(&model.Session{}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestBackfillSessionsFromUserToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	user, err := s.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Эмулируем базу до миграции: сессии нет, токен лежит в users.
	if err := s.DB().Where("1 = 1").Delete(&model.Session{}).Error; err != nil {
		t.Fatal(err)
	}

	if err := backfillSessions(s.DB()); err != nil {
		t.Fatal(err)
	}

	sess, gotUser, ok := s.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy token must resolve through the backfilled session")
	}
	if gotUser.ID != user.ID {
		t.Fatalf("user = %s, want %s", gotUser.ID, user.ID)
	}
	if sess.DeviceID != "legacy" {
		t.Fatalf("deviceID = %q, want legacy", sess.DeviceID)
	}
}

func TestBackfillSessionsIsIdempotent(t *testing.T) {
	db := newTestDBForMigration(t)
	if err := backfillSessions(db); err != nil {
		t.Fatal(err)
	}
	if err := backfillSessions(db); err != nil {
		t.Fatal(err)
	}

	var count int64
	if err := db.Model(&model.Session{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("session count = %d, want 1", count)
	}
}

func newTestDBForMigration(t *testing.T) *gorm.DB {
	t.Helper()
	s := newTestStore(t)
	if err := s.DB().AutoMigrate(&model.Session{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(context.Background(), "m@test.local", "m", "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	return s.DB()
}
```

- [ ] **Step 2: Запустить тест и увидеть падение**

Run:

```bash
cd backend && go test ./store -run 'TestBackfillSessions' -v
```

Expected: FAIL — `undefined: backfillSessions`, `undefined: (*Store).GetSessionByToken`.

- [ ] **Step 3: Добавить модель**

`backend/model/session.go`:

```go
package model

import "time"

// Session is one logged-in device of an account. The plaintext token is
// never stored: TokenHash is the SHA-256 digest of the bearer token.
type Session struct {
	ID         string     `gorm:"primaryKey"                    json:"id"`
	UserID     string     `gorm:"uniqueIndex:idx_sessions_user_device;not null" json:"-"`
	DeviceID   string     `gorm:"uniqueIndex:idx_sessions_user_device;not null" json:"deviceId"`
	DeviceName string     `gorm:"not null;default:''"          json:"deviceName"`
	TokenHash  string     `gorm:"uniqueIndex;not null"         json:"-"`
	UserAgent  string     `gorm:"not null;default:''"          json:"-"`
	CreatedAt  time.Time  `gorm:"not null"                     json:"createdAt"`
	LastSeenAt time.Time  `gorm:"not null"                     json:"lastSeenAt"`
	ExpiresAt  time.Time  `gorm:"index;not null"               json:"expiresAt"`
	RevokedAt  *time.Time `gorm:"index"                        json:"-"`
}

// Active reports whether the session may authenticate a request at now.
func (s *Session) Active(now time.Time) bool {
	return s.RevokedAt == nil && now.Before(s.ExpiresAt)
}
```

- [ ] **Step 4: Добавить backfill в store**

`backend/store/sessions.go` (пока только backfill):

```go
package store

import (
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

// backfillSessions gives every user that still has a token in users a legacy
// session, so tokens issued before the multi-device release keep working.
func backfillSessions(db *gorm.DB) error {
	var users []model.User
	if err := db.Where("token <> ''").Find(&users).Error; err != nil {
		return err
	}

	now := time.Now().UTC()
	for i := range users {
		u := &users[i]
		var existing int64
		if err := db.Model(&model.Session{}).
			Where("user_id = ? AND device_id = ?", u.ID, "legacy").
			Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			continue
		}

		session := model.Session{
			ID:         GenerateID(),
			UserID:     u.ID,
			DeviceID:   "legacy",
			DeviceName: "Legacy session",
			TokenHash:  u.Token,
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  u.TokenExpiresAt,
		}
		if err := db.Create(&session).Error; err != nil {
			return err
		}
	}

	return nil
}
```

- [ ] **Step 5: Подключить AutoMigrate и backfill**

В `backend/store/db.go`:

1. В список `AutoMigrate` добавить `&model.Session{}` после `&model.User{}`.
2. После `migrateLegacyTokens(db)` добавить:

```go
	if err := backfillSessions(db); err != nil {
		return nil, fmt.Errorf("backfill sessions: %w", err)
	}
```

- [ ] **Step 6: Добавить Store.GetSessionByToken (минимально для теста)**

`backend/store/sessions.go`:

```go
// GetSessionByToken resolves a bearer token to an active session and its user.
func (s *Store) GetSessionByToken(ctx context.Context, token string) (*model.Session, *model.User, bool) {
	var session model.Session
	err := s.db.WithContext(ctx).
		Where("token_hash = ? AND revoked_at IS NULL AND expires_at > ?", hashToken(token), time.Now().UTC()).
		First(&session).Error
	if err != nil {
		return nil, nil, false
	}

	var user model.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", session.UserID).Error; err != nil {
		return nil, nil, false
	}

	return &session, &user, true
}
```

Добавить импорт `context`.

- [ ] **Step 7: Прогнать тесты**

Run:

```bash
cd backend && go test ./store -run 'TestBackfillSessions' -v
```

Expected: PASS.

- [ ] **Step 8: Проверить, что старые store-тесты не сломались**

Run:

```bash
cd backend && go test ./store -count=1
```

Expected: PASS. Если `GetUserByToken` ещё смотрит в `users.token`, он
продолжает работать; позже заменим.

---

## Task 2: полноценный store-слой сессий

**Files:**
- Modify: `backend/store/sessions.go`
- Test: `backend/store/sessions_test.go`

- [ ] **Step 1: Написать падающие тесты store**

Добавить в `backend/store/sessions_test.go`:

```go
func TestCreateSessionTwiceSameDeviceReplacesToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	second, secondToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != second.ID {
		t.Fatalf("same device must reuse the session row: %s != %s", first.ID, second.ID)
	}
	if firstToken == secondToken {
		t.Fatal("token must rotate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("old token must stop working")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("new token must work")
	}
}

func TestCreateSessionForAnotherDeviceKeepsFirstSession(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	_, firstToken, err := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := s.GetSessionByToken(ctx, firstToken); !ok {
		t.Fatal("login on a second device must not invalidate the first session")
	}
}

func TestRevokeSessionOnlyRevokesOne(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, secondToken, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)

	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("revoked session must not authenticate")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("other session must survive")
	}
}

func TestRefreshSessionRotatesOnlyOne(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, firstToken, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, secondToken, _ := s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)

	_, newFirstToken, err := s.RefreshSession(ctx, first.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.GetSessionByToken(ctx, firstToken); ok {
		t.Fatal("old first token must be rotated")
	}
	if _, _, ok := s.GetSessionByToken(ctx, newFirstToken); !ok {
		t.Fatal("new first token must work")
	}
	if _, _, ok := s.GetSessionByToken(ctx, secondToken); !ok {
		t.Fatal("second session must survive")
	}
}

func TestListSessionsExcludesRevoked(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")

	first, _, _ := s.CreateSession(ctx, user.ID, "dev-1", "Chrome", "ua", time.Hour)
	_, _, _ = s.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	if err := s.RevokeSession(ctx, user.ID, first.ID); err != nil {
		t.Fatal(err)
	}

	sessions, err := s.ListSessions(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].DeviceID != "dev-2" {
		t.Fatalf("sessions = %+v, want only dev-2", sessions)
	}
}
```

- [ ] **Step 2: Запустить и увидеть падение**

Run:

```bash
cd backend && go test ./store -run 'Test(CreateSession|RevokeSession|RefreshSession|ListSessions)' -v
```

Expected: FAIL — методов ещё нет.

- [ ] **Step 3: Реализовать store-методы**

Добавить в `backend/store/sessions.go`:

```go
var (
	ErrSessionNotFound = errors.New("session not found")
)

// CreateSession creates or replaces the session of a device. It returns the
// session and the plaintext token, which is never stored.
func (s *Store) CreateSession(ctx context.Context, userID, deviceID, deviceName, userAgent string, ttl time.Duration) (*model.Session, string, error) {
	if userID == "" {
		return nil, "", ErrSessionNotFound
	}
	if ttl <= 0 {
		return nil, "", fmt.Errorf("session ttl must be positive")
	}
	if deviceID == "" {
		deviceID = "legacy-" + GenerateID()
	}

	token := GenerateID()
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	tokenHash := hashToken(token)

	var session model.Session
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND device_id = ?", userID, deviceID).
		First(&session).Error

	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		session = model.Session{
			ID:         GenerateID(),
			UserID:     userID,
			DeviceID:   deviceID,
			DeviceName: truncateDeviceName(deviceName),
			TokenHash:  tokenHash,
			UserAgent:  truncateUserAgent(userAgent),
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  expiresAt,
		}
		if err := s.db.WithContext(ctx).Create(&session).Error; err != nil {
			return nil, "", err
		}
	case err != nil:
		return nil, "", err
	default:
		if err := s.db.WithContext(ctx).Model(&model.Session{}).
			Where("id = ?", session.ID).
			Updates(map[string]any{
				"token_hash":  tokenHash,
				"device_name": truncateDeviceName(deviceName),
				"user_agent":  truncateUserAgent(userAgent),
				"expires_at":  expiresAt,
				"last_seen_at": now,
				"revoked_at":  nil,
			}).Error; err != nil {
			return nil, "", err
		}
		session.DeviceName = truncateDeviceName(deviceName)
		session.UserAgent = truncateUserAgent(userAgent)
		session.TokenHash = tokenHash
		session.ExpiresAt = expiresAt
		session.LastSeenAt = now
		session.RevokedAt = nil
	}

	return &session, token, nil
}

// GetSessionByID returns a session regardless of its state: SSE heartbeat
// needs to distinguish "revoked" from "not found".
func (s *Store) GetSessionByID(ctx context.Context, sessionID string) (*model.Session, bool) {
	var session model.Session
	if err := s.db.WithContext(ctx).First(&session, "id = ?", sessionID).Error; err != nil {
		return nil, false
	}
	return &session, true
}

// RefreshSession rotates the token of one session and extends its expiry.
func (s *Store) RefreshSession(ctx context.Context, sessionID string, ttl time.Duration) (*model.Session, string, error) {
	if ttl <= 0 {
		return nil, "", fmt.Errorf("session ttl must be positive")
	}

	now := time.Now().UTC()
	token := GenerateID()
	res := s.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND revoked_at IS NULL AND expires_at > ?", sessionID, now).
		Updates(map[string]any{
			"token_hash":  hashToken(token),
			"expires_at":  now.Add(ttl),
			"last_seen_at": now,
		})
	if res.Error != nil {
		return nil, "", res.Error
	}
	if res.RowsAffected == 0 {
		return nil, "", ErrSessionNotFound
	}

	var session model.Session
	if err := s.db.WithContext(ctx).First(&session, "id = ?", sessionID).Error; err != nil {
		return nil, "", err
	}

	return &session, token, nil
}

// RevokeSession invalidates one session of the user.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessionID, userID).
		Updates(map[string]any{
			"revoked_at":  now,
			"expires_at":  now,
			"token_hash":  hashToken(GenerateID()),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// RevokeAllSessions invalidates every active session of the user.
func (s *Store) RevokeAllSessions(ctx context.Context, userID string) (int64, error) {
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&model.Session{}).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Updates(map[string]any{
			"revoked_at":  now,
			"expires_at":  now,
			"token_hash":  hashToken(GenerateID()),
		})
	return res.RowsAffected, res.Error
}

// ListSessions returns active sessions, newest activity first.
func (s *Store) ListSessions(ctx context.Context, userID string) ([]model.Session, error) {
	var sessions []model.Session
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND revoked_at IS NULL AND expires_at > ?", userID, time.Now().UTC()).
		Order("last_seen_at DESC").
		Find(&sessions).Error
	return sessions, err
}

// TrimSessions revokes the oldest sessions above max, excluding keepID.
func (s *Store) TrimSessions(ctx context.Context, userID string, max int, keepID string) ([]string, error) {
	if max <= 0 {
		return nil, nil
	}

	var sessions []model.Session
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND revoked_at IS NULL AND expires_at > ?", userID, time.Now().UTC()).
		Order("last_seen_at ASC").
		Find(&sessions).Error; err != nil {
		return nil, err
	}
	if len(sessions) <= max {
		return nil, nil
	}

	excess := len(sessions) - max
	revoked := make([]string, 0, excess)
	for i := range sessions {
		if excess == 0 {
			break
		}
		if sessions[i].ID == keepID {
			continue
		}
		if err := s.RevokeSession(ctx, userID, sessions[i].ID); err != nil {
			return revoked, err
		}
		revoked = append(revoked, sessions[i].ID)
		excess--
	}
	return revoked, nil
}

// DeleteOldSessions removes sessions that expired or were revoked long ago.
func (s *Store) DeleteOldSessions(ctx context.Context, before time.Time) (int64, error) {
	res := s.db.WithContext(ctx).
		Where("(revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?", before, before).
		Delete(&model.Session{})
	return res.RowsAffected, res.Error
}

func truncateDeviceName(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 64 {
		return s[:64]
	}
	return s
}

func truncateUserAgent(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}
```

Добавить импорты `context`, `errors`, `fmt`, `strings`, `time`, `gorm.io/gorm`.

- [ ] **Step 4: Прогнать тесты**

Run:

```bash
cd backend && go test ./store -run 'Test(CreateSession|RevokeSession|RefreshSession|ListSessions|Backfill)' -v
```

Expected: PASS.

- [ ] **Step 5: Прогнать весь store-пакет**

Run:

```bash
cd backend && go test ./store -count=1
```

Expected: PASS.

---

## Task 3: создание пользователя сразу с сессией

**Files:**
- Modify: `backend/store/users.go`
- Test: `backend/store/sessions_test.go`

- [ ] **Step 1: Написать падающий тест**

```go
func TestCreateUserWithSessionReturnsWorkingToken(t *testing.T) {
	s := newSessionTestStore(t)
	ctx := context.Background()

	user, sess, token, err := s.CreateUserWithSession(ctx, "bob@test.local", "bob", "test", "dev-1", "Chrome", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != "bob:test" {
		t.Fatalf("user ID = %s", user.ID)
	}
	if sess.UserID != user.ID || sess.DeviceID != "dev-1" {
		t.Fatalf("session = %+v", sess)
	}
	if _, gotUser, ok := s.GetSessionByToken(ctx, token); !ok || gotUser.ID != user.ID {
		t.Fatal("token must resolve to the new user")
	}
}
```

- [ ] **Step 2: Запустить и увидеть падение**

Run:

```bash
cd backend && go test ./store -run TestCreateUserWithSession -v
```

Expected: FAIL — метода нет.

- [ ] **Step 3: Реализовать CreateUserWithSession**

В `backend/store/users.go` добавить:

```go
// CreateUserWithSession creates the account and its first session in one
// transaction. The returned token is plaintext and sent to the client once.
func (s *Store) CreateUserWithSession(ctx context.Context, email, nick, serverDomain, deviceID, deviceName, userAgent string, ttl time.Duration) (*model.User, *model.Session, string, error) {
	fullID := nick + ":" + serverDomain
	now := time.Now().UTC()
	token := GenerateID()

	user := &model.User{
		ID:             fullID,
		Email:          email,
		Nick:           nick,
		Token:          hashToken(token),
		TokenExpiresAt: now.Add(ttl),
	}
	session := &model.Session{
		ID:         GenerateID(),
		UserID:     fullID,
		DeviceID:   deviceID,
		DeviceName: truncateDeviceName(deviceName),
		TokenHash:  hashToken(token),
		UserAgent:  truncateUserAgent(userAgent),
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(ttl),
	}
	if session.DeviceID == "" {
		session.DeviceID = "legacy-" + GenerateID()
	}

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(user).Error; err != nil {
			return err
		}
		return tx.Create(session).Error
	})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "UNIQUE constraint failed") {
			switch {
			case strings.Contains(msg, ".email") || strings.Contains(msg, ": email"):
				return nil, nil, "", ErrEmailTaken
			case strings.Contains(msg, ".nick") || strings.Contains(msg, ": nick"):
				return nil, nil, "", ErrNicknameTaken
			}
		}
		return nil, nil, "", err
	}

	user.Token = token
	return user, session, token, nil
}
```

- [ ] **Step 4: Оставить CreateUser совместимым**

`CreateUser` оставить как обёртку над `CreateUserWithSession`:

```go
func (s *Store) CreateUser(ctx context.Context, email, nick, serverDomain string, tokenExpiry time.Duration) (*model.User, error) {
	user, _, _, err := s.CreateUserWithSession(ctx, email, nick, serverDomain, "legacy", "Legacy session", "", tokenExpiry)
	return user, err
}
```

Удалить старую реализацию `CreateUser` (вместе с её обработкой ошибок:
она уже есть в новой функции).

- [ ] **Step 5: Перевести GetUserByToken на сессии**

```go
func (s *Store) GetUserByToken(ctx context.Context, token string) (*model.User, bool) {
	_, user, ok := s.GetSessionByToken(ctx, token)
	return user, ok
}
```

- [ ] **Step 6: Прогнать тесты**

```bash
cd backend && go test ./store -count=1
```

Expected: PASS. `TestCreateUser` и `TestGetUserByToken` должны остаться
зелёными: `CreateUser` создаёт legacy-сессию, а `GetUserByToken` идёт
через неё.

---

## Task 3b: обновить тестовые БД

После того как `CreateUser` начал создавать сессию, каждый тестовый
`AutoMigrate` должен знать `model.Session`, иначе все тесты, создающие
пользователя, упадут на отсутствующей таблице.

**Files:**
- Modify: `backend/store/store_test.go`
- Modify: `backend/store/read_statuses_test.go`
- Modify: `backend/store/timestamps_test.go`
- Modify: `backend/service/files_test.go`
- Modify: `backend/service/federation_test.go`
- Modify: `backend/service/push_test.go`
- Modify: `backend/transport/test_helpers.go`
- Modify: `backend/transport/transport_test.go`
- Modify: `backend/main_test.go`

- [ ] **Step 1: Добавить `&model.Session{}` в каждый AutoMigrate**

Найти все вызовы:

```bash
cd backend && grep -rn "AutoMigrate(" --include='*_test.go' .
```

В каждый список добавить `&model.Session{}` (рядом с `&model.User{}`).
Если `model` не импортирован — добавить импорт `fast_chat/model`.

- [ ] **Step 2: Выставить Auth-конфиг в тестовых сервисах**

В `backend/service/files_test.go`, `backend/service/federation_test.go`,
`backend/service/push_test.go` и других тестовых конструкторах
`config.Config` добавить:

```go
Auth: config.AuthConfig{
	TokenExpiry:        24 * time.Hour,
	TokenExpiryWarning: 5 * time.Minute,
	MaxSessionsPerUser: 50,
},
```

Если `time` не импортирован — добавить.

- [ ] **Step 3: Прогнать тесты**

```bash
cd backend && go test ./store ./service ./transport -count=1
```

Expected: PASS (кроме тестов, которые ещё не обновлены под новые
сигнатуры; их исправим в следующих задачах).

---

## Task 4: сервис аутентификации на сессиях

**Files:**
- Create: `backend/service/sessions.go`
- Modify: `backend/service/auth.go`
- Test: `backend/service/sessions_test.go`

- [ ] **Step 1: Написать падающий сервисный тест**

`backend/service/sessions_test.go`:

```go
package service

import (
	"context"
	"testing"
	"time"
)

func TestVerifyCodeSecondDeviceKeepsFirstSession(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()
	user, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	s.store.Codes().StoreCode(user.Email, "123456", time.Minute)
	first, err := s.VerifyCode(ctx, user.Email, "123456", DeviceInfo{ID: "dev-1", Name: "Chrome"})
	if err != nil {
		t.Fatal(err)
	}
	s.store.Codes().StoreCode(user.Email, "123456", time.Minute)
	second, err := s.VerifyCode(ctx, user.Email, "123456", DeviceInfo{ID: "dev-2", Name: "Phone"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Token == second.Token {
		t.Fatal("tokens must differ")
	}
	if _, _, ok := s.store.GetSessionByToken(ctx, first.Token); !ok {
		t.Fatal("first session must survive the second login")
	}
}
```

Тест кладёт код в `CodeStore` перед каждым входом: после проверки код
удаляется.

- [ ] **Step 2: Запустить и увидеть падение**

```bash
cd backend && go test ./service -run TestVerifyCodeSecondDevice -v
```

Expected: FAIL — `DeviceInfo`/`VerifyCode` с новыми аргументами не
компилируются.

- [ ] **Step 3: Добавить поле конфига и DeviceInfo**

В `backend/config/config.go`:

```go
type AuthConfig struct {
	TokenExpiry        time.Duration `yaml:"token_expiry"`
	TokenExpiryWarning time.Duration `yaml:"token_expiry_warning"`
	MaxSessionsPerUser int           `yaml:"max_sessions_per_user"`
}
```

В `applyDefaults`:

```go
if cfg.Auth.MaxSessionsPerUser == 0 {
	cfg.Auth.MaxSessionsPerUser = 50
}
```

В `validateAuth`:

```go
if auth.MaxSessionsPerUser < 0 {
	return fmt.Errorf("%w: got %d", ErrInvalidTokenExpiry, auth.MaxSessionsPerUser)
}
```

(Точную ошибку можно назвать `ErrInvalidMaxSessions`; главное — не
пропускать отрицательное значение.)

Теперь `backend/service/sessions.go`:

```go
package service

import (
	"context"
	"time"

	"fast_chat/model"
	"fast_chat/store"
)

// DeviceInfo identifies the client that owns a session.
type DeviceInfo struct {
	ID        string
	Name      string
	UserAgent string
}

func normalizeDevice(in DeviceInfo) DeviceInfo {
	if in.ID == "" {
		in.ID = "legacy-" + store.GenerateID()
	}
	if len(in.Name) > 64 {
		in.Name = in.Name[:64]
	}
	if len(in.UserAgent) > 512 {
		in.UserAgent = in.UserAgent[:512]
	}
	return in
}

// sessionTTL keeps tests and partially configured servers from issuing
// sessions that expire immediately.
func (s *Service) sessionTTL() time.Duration {
	if s.cfg != nil && s.cfg.Auth.TokenExpiry > 0 {
		return s.cfg.Auth.TokenExpiry
	}
	return 24 * time.Hour
}

// Logout revokes only the given session and releases its realtime resources.
func (s *Service) Logout(ctx context.Context, sessionID string, userID string) error {
	if err := s.store.RevokeSession(ctx, userID, sessionID); err != nil {
		return err
	}
	if err := s.store.DeletePushSubscriptionsBySession(ctx, sessionID); err != nil {
		log().Warn("failed to delete push subscriptions", "sessionID", sessionID, "err", err)
	}
	if s.hub != nil {
		s.hub.CloseSession(sessionID)
	}
	return nil
}

// LogoutAll revokes every session of the user.
func (s *Service) LogoutAll(ctx context.Context, userID string) error {
	if _, err := s.store.RevokeAllSessions(ctx, userID); err != nil {
		return err
	}
	if err := s.store.DeleteAllPushSubscriptions(ctx, userID); err != nil {
		log().Warn("failed to delete push subscriptions", "userID", userID, "err", err)
	}
	if s.hub != nil {
		s.hub.CloseUserSessions(userID)
	}
	return nil
}

// RevokeSession revokes another device of the user.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID string) error {
	return s.Logout(ctx, sessionID, userID)
}

// ListSessions returns the active sessions of the user.
func (s *Service) ListSessions(ctx context.Context, userID string) ([]model.Session, error) {
	return s.store.ListSessions(ctx, userID)
}

// RefreshSession rotates the token of the current session.
func (s *Service) RefreshSession(ctx context.Context, sessionID string) (*model.Session, string, error) {
	session, token, err := s.store.RefreshSession(ctx, sessionID, s.sessionTTL())
	if err != nil {
		return nil, "", err
	}
	if s.hub != nil {
		s.hub.UpdateSessionExpiry(sessionID, session.ExpiresAt)
	}
	return session, token, nil
}

func (s *Service) trimSessions(ctx context.Context, userID, keepID string) {
	revoked, err := s.store.TrimSessions(ctx, userID, s.cfg.Auth.MaxSessionsPerUser, keepID)
	if err != nil {
		log().Warn("failed to trim sessions", "userID", userID, "err", err)
		return
	}
	for _, sessionID := range revoked {
		if s.hub != nil {
			s.hub.CloseSession(sessionID)
		}
		if err := s.store.DeletePushSubscriptionsBySession(ctx, sessionID); err != nil {
			log().Warn("failed to delete push subscriptions", "sessionID", sessionID, "err", err)
		}
	}
}

var _ = time.Second // keep time imported if the snippet above changes
```

Удалить `var _ = time.Second` и импорт `time`, если он не нужен.

- [ ] **Step 4: Переписать VerifyCode**

`backend/service/auth.go`:

```go
type VerifyCodeResult struct {
	IsNew      bool
	User       *model.User
	Session    *model.Session
	Token      string
	SetupToken string
}

func (s *Service) VerifyCode(ctx context.Context, input, code string, device DeviceInfo) (*VerifyCodeResult, error) {
	email := normalizeEmail(input)
	code = strings.TrimSpace(code)

	if !s.store.Codes().VerifyCode(email, code) {
		return nil, ErrInvalidCode
	}

	user, exists := s.store.GetUserByEmail(ctx, email)
	if exists {
		device = normalizeDevice(device)
		session, token, err := s.store.CreateSession(ctx, user.ID, device.ID, device.Name, device.UserAgent, s.sessionTTL())
		if err != nil {
			log().Error("failed to create session", "err", err)
			return nil, err
		}
		s.trimSessions(ctx, user.ID, session.ID)
		return &VerifyCodeResult{User: user, Session: session, Token: token}, nil
	}

	setupToken := s.store.Codes().CreateSetupToken(email, emailCodeTTL)
	return &VerifyCodeResult{IsNew: true, SetupToken: setupToken}, nil
}
```

- [ ] **Step 5: Переписать CompleteRegistration**

```go
type RegistrationResult struct {
	User    *model.User
	Session *model.Session
	Token   string
}

func (s *Service) CompleteRegistration(ctx context.Context, setupToken, nick string, device DeviceInfo) (*RegistrationResult, error) {
	nick = strings.TrimSpace(nick)
	if nick == "" || utf8.RuneCountInString(nick) > nickMaxRunes {
		return nil, ErrNickInvalid
	}

	if strings.Contains(nick, ":") {
		return nil, ErrNickColon
	}

	email, ok := s.store.Codes().VerifySetupToken(setupToken)
	if !ok {
		return nil, ErrInvalidSetupToken
	}

	device = normalizeDevice(device)
	user, session, token, err := s.store.CreateUserWithSession(
		ctx, email, nick, s.cfg.Server.Domain,
		device.ID, device.Name, device.UserAgent, s.sessionTTL(),
	)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNicknameTaken):
			return nil, ErrNicknameTaken
		case errors.Is(err, store.ErrEmailTaken):
			return nil, ErrEmailAlreadyTaken
		default:
			log().Error("failed to create user", "err", err)
			return nil, err
		}
	}

	if _, err := s.store.EnsureSelfChat(ctx, user.ID); err != nil {
		log().Error("failed to ensure self-chat", "err", err)
		return nil, err
	}

	return &RegistrationResult{User: user, Session: session, Token: token}, nil
}
```

- [ ] **Step 6: Удалить RefreshToken на пользователя**

Старую `RefreshToken(ctx, userID)` удалить; транспорт будет вызывать
`RefreshSession(ctx, sessionID)`.

- [ ] **Step 7: Прогнать сервисные тесты**

```bash
cd backend && go test ./service -run 'TestVerifyCodeSecondDevice|TestLogout|TestRefreshSession' -v
```

Expected: PASS.

- [ ] **Step 8: Прогнать весь service-пакет**

```bash
cd backend && go test ./service -count=1
```

Expected: PASS. Ошибки компиляции в тестах, которые вызывают старые
`VerifyCode`/`CompleteRegistration`, исправить сигнатурой с `DeviceInfo`.

---

## Task 5: транспорт — API входа, сессий и middleware

**Files:**
- Create: `backend/transport/sessions.go`
- Modify: `backend/transport/auth.go`
- Modify: `backend/transport/transport.go`
- Test: `backend/transport/sessions_test.go`

- [ ] **Step 1: Написать падающий тест API**

`backend/transport/sessions_test.go`:

```go
package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoginOnSecondDeviceKeepsFirstToken(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})
	ctx := context.Background()
	user := createTestUser(t, st)

	login := func(deviceID string) string {
		st.Codes().StoreCode(user.Email, "123456", time.Minute)
		body := `{"email":"` + user.Email + `","code":"123456","deviceId":"` + deviceID + `","deviceName":"` + deviceID + `"}`
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/auth/verify-code", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		api.Adapter().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("login %s: %d %s", deviceID, rec.Code, rec.Body.String())
		}
		var resp struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		return resp.Token
	}

	first := login("dev-1")
	second := login("dev-2")
	if first == second {
		t.Fatal("tokens must differ")
	}

	for _, token := range []string{first, second} {
		if _, _, ok := st.GetSessionByToken(ctx, token); !ok {
			t.Fatalf("token %q must be valid", token)
		}
	}
}

func TestListSessionsMarksCurrent(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})
	ctx := context.Background()
	user := createTestUser(t, st)
	token := user.Token

	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		CurrentSessionID string `json:"currentSessionId"`
		Sessions         []struct {
			ID      string `json:"id"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.CurrentSessionID == "" || len(resp.Sessions) != 1 || !resp.Sessions[0].Current {
		t.Fatalf("response = %+v", resp)
	}
}
```

Тест кладёт новый код перед каждым входом: `CodeStore.VerifyCode`
удаляет код после проверки.

- [ ] **Step 2: Запустить и увидеть падение**

```bash
cd backend && go test ./transport -run 'Test(LoginOnSecondDevice|ListSessions)' -v
```

Expected: FAIL — нет полей `deviceId`, нет `/api/sessions`.

- [ ] **Step 3: Расширить auth DTO**

`backend/transport/auth.go`:

```go
type verifyCodeInput struct {
	Body struct {
		Email      string `json:"email,omitempty"`
		Code       string `json:"code,omitempty"`
		DeviceID   string `json:"deviceId,omitempty"`
		DeviceName string `json:"deviceName,omitempty"`
	}
}

type verifyCodeOutput struct {
	Body struct {
		IsNew      bool              `json:"isNew"`
		SetupToken string            `json:"setupToken,omitempty"`
		User       *model.PublicUser `json:"user,omitempty"`
		Token      string            `json:"token,omitempty"`
		ExpiresAt  string            `json:"expiresAt,omitempty"`
		SessionID  string            `json:"sessionId,omitempty"`
		DeviceID   string            `json:"deviceId,omitempty"`
	}
}

type completeRegistrationInput struct {
	Body struct {
		SetupToken string `json:"setupToken,omitempty"`
		Nick       string `json:"nick,omitempty"`
		DeviceID   string `json:"deviceId,omitempty"`
		DeviceName string `json:"deviceName,omitempty"`
	}
}

type completeRegistrationOutput struct {
	Body struct {
		User      *model.PublicUser `json:"user"`
		Token     string            `json:"token"`
		ExpiresAt string            `json:"expiresAt"`
		SessionID string            `json:"sessionId"`
		DeviceID  string            `json:"deviceId"`
	}
}

type refreshTokenOutput struct {
	Body struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
		SessionID string `json:"sessionId"`
	}
}
```

- [ ] **Step 4: Обновить хендлеры входа**

В `verify-code` собрать device:

```go
device := service.DeviceInfo{
	ID:        input.Body.DeviceID,
	Name:      input.Body.DeviceName,
	UserAgent: userAgentFromContext(ctx),
}
res, err := svc.VerifyCode(ctx, input.Body.Email, input.Body.Code, device)
```

`userAgentFromContext` добавить в `backend/transport/auth.go`:

```go
func userAgentFromContext(ctx context.Context) string {
	if r, ok := requestFromContext(ctx); ok {
		return r.UserAgent()
	}
	return ""
}
```

В ответе, только для существующего пользователя:

```go
if res.Session != nil {
	out.Body.SessionID = res.Session.ID
	out.Body.DeviceID = res.Session.DeviceID
}
```

В `complete-registration` использовать `RegistrationResult` и вернуть
`SessionID`/`DeviceID`.

- [ ] **Step 5: Middleware на сессии**

Заменить в `AuthMiddleware`:

```go
session, user, ok := st.GetSessionByToken(ctx.Context(), token)
if !ok {
	ctx.SetHeader("Content-Type", "application/json")
	ctx.SetStatus(http.StatusUnauthorized)
	ctx.BodyWriter().Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck,gosec
	return
}

next(huma.WithValue(ctx, authContextKey{}, &authUser{
	ID:        user.ID,
	Nick:      user.Nick,
	SessionID: session.ID,
	DeviceID:  session.DeviceID,
}))
```

`authUser`:

```go
type authUser struct {
	ID        string
	Nick      string
	SessionID string
	DeviceID  string
}
```

Добавить:

```go
func sessionFromContext(ctx context.Context) (*authUser, bool) {
	u, ok := userFromContext(ctx)
	if !ok || u.SessionID == "" {
		return nil, false
	}
	return u, true
}
```

`WithAuthUser` оставить, но выставить `SessionID: ""`; если он нужен
тестам, они не проходят через middleware.

- [ ] **Step 6: Logout и logout-all**

`registerLogout` принимает `svc *service.Service`; текущая сессия:

```go
user, ok := sessionFromContext(ctx)
if !ok {
	return nil, errUnauthorized
}
if err := svc.Logout(ctx, user.SessionID, user.ID); err != nil {
	return nil, mapServerError(err)
}
```

Добавить `POST /api/auth/logout-all`:

```go
if err := svc.LogoutAll(ctx, user.ID); err != nil {
	return nil, mapServerError(err)
}
```

- [ ] **Step 7: Refresh**

`refresh-token` берёт session:

```go
user, ok := sessionFromContext(ctx)
if !ok {
	return nil, errUnauthorized
}
session, token, err := svc.RefreshSession(ctx, user.SessionID)
if err != nil {
	return nil, mapServerError(err)
}
return &refreshTokenOutput{Body: struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	SessionID string `json:"sessionId"`
}{
	Token:     token,
	ExpiresAt: session.ExpiresAt.Format(time.RFC3339),
	SessionID: session.ID,
}}, nil
```

- [ ] **Step 8: Добавить API сессий**

`backend/transport/sessions.go`:

```go
package transport

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
	"fast_chat/store"
)

type sessionView struct {
	ID         string `json:"id"`
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	UserAgent  string `json:"userAgent,omitempty"`
	CreatedAt  string `json:"createdAt"`
	LastSeenAt string `json:"lastSeenAt"`
	ExpiresAt  string `json:"expiresAt"`
	Current    bool   `json:"current"`
}

type listSessionsOutput struct {
	Body struct {
		CurrentSessionID string        `json:"currentSessionId"`
		Sessions         []sessionView `json:"sessions"`
	}
}

func RegisterSessions(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-sessions",
		Method:      http.MethodGet,
		Path:        "/api/sessions",
		Summary:     "List the devices of the account",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*listSessionsOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		sessions, err := svc.ListSessions(ctx, user.ID)
		if err != nil {
			return nil, mapServerError(err)
		}
		out := &listSessionsOutput{}
		out.Body.CurrentSessionID = user.SessionID
		out.Body.Sessions = make([]sessionView, 0, len(sessions))
		for _, s := range sessions {
			out.Body.Sessions = append(out.Body.Sessions, sessionView{
				ID:         s.ID,
				DeviceID:   s.DeviceID,
				DeviceName: s.DeviceName,
				UserAgent:  s.UserAgent,
				CreatedAt:  s.CreatedAt.Format(time.RFC3339),
				LastSeenAt: s.LastSeenAt.Format(time.RFC3339),
				ExpiresAt:  s.ExpiresAt.Format(time.RFC3339),
				Current:    s.ID == user.SessionID,
			})
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "revoke-session",
		Method:      http.MethodDelete,
		Path:        "/api/sessions/{id}",
		Summary:     "Revoke another device session",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *revokeSessionInput) (*statusOutput, error) {
		user, ok := sessionFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if err := svc.RevokeSession(ctx, user.ID, input.ID); err != nil {
			if errors.Is(err, store.ErrSessionNotFound) {
				return nil, &statusError{ErrorMessage: "session not found", code: http.StatusNotFound}
			}
			return nil, mapServerError(err)
		}
		return &statusOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

type revokeSessionInput struct {
	ID string `path:"id"`
}
```

Импортировать `errors`.

В конце `RegisterAuth` (после `registerLogout`) добавить:

```go
	RegisterSessions(api, svc)
```

Это нужно, чтобы `newAuthTestServer` в тестах регистрировал `/api/sessions`.

- [ ] **Step 9: Прогнать транспортные тесты**

```bash
cd backend && go test ./transport -run 'Test(LoginOnSecondDevice|ListSessions)' -v
```

Expected: PASS.

- [ ] **Step 10: Прогнать весь transport-пакет**

```bash
cd backend && go test ./transport -count=1
```

Expected: PASS. Исправить старые тесты, которые вызывают
`VerifyCode`/`CompleteRegistration` без `DeviceInfo`, и тесты, которые
ожидают точный JSON без `sessionId` (новые поля `omitempty`, старые
проверки не должны ломаться).

---

## Task 6: SSE по сессиям

**Files:**
- Modify: `backend/sse/hub.go`
- Modify: `backend/transport/auth.go`
- Modify: `backend/transport/transport.go`
- Test: `backend/sse/hub_test.go`
- Test: `backend/transport/auth_test.go`
- Test: `backend/transport/transport_test.go`

- [ ] **Step 1: Написать падающий тест hub**

Добавить в `backend/sse/hub_test.go`:

```go
func TestCloseSessionClosesOnlyItsConnections(t *testing.T) {
	h := NewHub(time.Minute)
	defer h.Close()

	first := h.Register("c1")
	second := h.Register("c2")
	if err := h.AuthenticateSession("c1", "u1", "s1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := h.AuthenticateSession("c2", "u1", "s2", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	h.CloseSession("s1")

	select {
	case _, ok := <-first.Channel:
		if ok {
			t.Fatal("first channel must be closed")
		}
	default:
		t.Fatal("first channel must be closed synchronously")
	}
	select {
	case _, ok := <-second.Channel:
		if !ok {
			t.Fatal("second channel must stay open")
		}
	default:
	}
}
```

- [ ] **Step 2: Запустить и увидеть падение**

```bash
cd backend && go test ./sse -run TestCloseSession -v
```

Expected: FAIL — `AuthenticateSession`/`CloseSession` нет.

- [ ] **Step 3: Добавить SessionID в Connection**

В `backend/sse/hub.go`:

```go
type Connection struct {
	mu         sync.Mutex
	ID         string
	UserID     string
	SessionID  string
	Token      string
	ExpiresAt  time.Time
	Authorized bool
	Warned     bool
	Channel    chan Event
	CreatedAt  time.Time
}
```

- [ ] **Step 4: Добавить AuthenticateSession и оставить старый Authenticate**

```go
// AuthenticateSession binds a connection to a user session.
func (h *Hub) AuthenticateSession(connectionID, userID, sessionID string, expiresAt time.Time) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.connections[connectionID]
	if !ok {
		return ErrConnectionNotFound
	}

	conn.mu.Lock()
	conn.UserID = userID
	conn.SessionID = sessionID
	conn.ExpiresAt = expiresAt
	conn.Authorized = true
	conn.Warned = false
	conn.mu.Unlock()

	if slices.Contains(h.userConns[userID], connectionID) {
		return nil
	}
	h.userConns[userID] = append(h.userConns[userID], connectionID)
	return nil
}

// Authenticate is kept for tests and pre-session callers.
func (h *Hub) Authenticate(connectionID, userID, token string, expiresAt time.Time) error {
	if err := h.AuthenticateSession(connectionID, userID, "", expiresAt); err != nil {
		return err
	}
	conn := h.GetConnection(connectionID)
	if conn != nil {
		conn.Lock()
		conn.Token = token
		conn.Unlock()
	}
	return nil
}
```

- [ ] **Step 5: CloseSession/CloseUserSessions/UpdateSessionExpiry**

```go
func (h *Hub) sessionConnectionIDs(sessionID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0)
	for id, conn := range h.connections {
		conn.mu.Lock()
		match := conn.SessionID == sessionID
		conn.mu.Unlock()
		if match {
			ids = append(ids, id)
		}
	}
	return ids
}

func (h *Hub) CloseSession(sessionID string) {
	if sessionID == "" {
		return
	}
	for _, id := range h.sessionConnectionIDs(sessionID) {
		if conn := h.GetConnection(id); conn != nil {
			h.Unregister(id, conn)
		}
	}
}

func (h *Hub) CloseUserSessions(userID string) {
	h.mu.RLock()
	ids := append([]string(nil), h.userConns[userID]...)
	h.mu.RUnlock()

	for _, id := range ids {
		if conn := h.GetConnection(id); conn != nil {
			h.Unregister(id, conn)
		}
	}
}

func (h *Hub) UpdateSessionExpiry(sessionID string, expiresAt time.Time) {
	if sessionID == "" {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conn := range h.connections {
		conn.mu.Lock()
		if conn.SessionID == sessionID {
			conn.ExpiresAt = expiresAt
		}
		conn.mu.Unlock()
	}
}
```

`Unregister` уже закрывает канал и удаляет из `userConns`; этого
достаточно. Не вызывать `Unregister` под `h.mu` — методы берут блокировку
сами.

- [ ] **Step 6: sse-auth на сессии**

`backend/transport/auth.go`:

```go
session, user, ok := st.GetSessionByToken(ctx, input.Body.Token)
if !ok {
	return nil, errUnauthorized
}
conn := hub.GetConnection(input.Body.ConnectionID)
if conn == nil {
	return nil, errConnectionNotFound
}
if err := hub.AuthenticateSession(input.Body.ConnectionID, user.ID, session.ID, session.ExpiresAt); err != nil {
	return nil, errConnectionNotFound
}
if st.AddConnectionForSession(user.ID, session.ID) {
	svc.BroadcastUserStatus(ctx, user.ID, true)
}
```

- [ ] **Step 7: heartbeat и runSSE**

В `transport.go`:

- `checkSSEHeartbeat` принимает `st`, смотрит `conn.SessionID`:

```go
conn.Lock()
sessionID := conn.SessionID
token := conn.Token
expiresAt := conn.ExpiresAt
conn.Unlock()

if sessionID != "" {
	session, ok := st.GetSessionByID(ctx, sessionID)
	if !ok || !session.Active(time.Now().UTC()) {
		expired = true
	}
} else if token != "" {
	// legacy path for tests
	user, ok := st.GetUserByToken(ctx, token)
	if !ok || time.Now().After(user.TokenExpiresAt) {
		expired = true
	}
}
```

- `runSSE` defer:

```go
conn.Lock()
uid := conn.UserID
sid := conn.SessionID
conn.Unlock()
if uid != "" && st != nil && svc != nil {
	if st.RemoveConnectionForSession(uid, sid) {
		svc.BroadcastUserStatus(context.Background(), uid, false)
	}
}
```

- `Store` должен получить `GetSessionByID`, `AddConnectionForSession`,
  `RemoveConnectionForSession` до компиляции. Их добавим в Task 7; для
  промежуточной компиляции можно сначала добавить заглушки, но лучше
  выполнять Task 6 и 7 вместе.

- [ ] **Step 8: Прогнать SSE-тесты**

```bash
cd backend && go test ./sse ./transport -run 'Test(CloseSession|SSE|Auth)' -v
```

Expected: PASS.

---

## Task 7: presence и push на сессию

**Files:**
- Modify: `backend/store/store.go`
- Modify: `backend/store/push.go`
- Modify: `backend/store/sessions.go`
- Modify: `backend/model/types.go`
- Modify: `backend/service/push.go`
- Modify: `backend/transport/push.go`
- Test: `backend/store/store_test.go`
- Test: `backend/store/push_test.go`
- Test: `backend/service/push_test.go`

- [ ] **Step 1: Написать падающий тест presence**

```go
func TestSessionPresenceIsIndependentOfUserPresence(t *testing.T) {
	s := newTestStore(t)
	s.AddConnectionForSession(testAlice, "s1")
	s.AddConnectionForSession(testAlice, "s2")

	if !s.IsOnline(testAlice) {
		t.Fatal("user must be online")
	}
	if !s.IsSessionOnline("s1") || !s.IsSessionOnline("s2") {
		t.Fatal("both sessions must be online")
	}

	s.RemoveConnectionForSession(testAlice, "s1")
	if s.IsSessionOnline("s1") {
		t.Fatal("s1 must be offline")
	}
	if !s.IsSessionOnline("s2") || !s.IsOnline(testAlice) {
		t.Fatal("s2 and the user must stay online")
	}
}
```

- [ ] **Step 2: Реализовать presence**

В `Store` добавить поле:

```go
sessionConns map[string]int
```

В `New` добавить в литерал:

```go
sessionConns: make(map[string]int),
```

В `Close` рядом с очисткой `conns`:

```go
s.sessionConns = make(map[string]int)
```

Затем методы:

```go
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

func (s *Store) RemoveConnectionForSession(userID, sessionID string) bool {
	s.connMu.Lock()
	connCount, ok := s.conns[userID]
	if !ok || connCount <= 0 {
		if ok {
			delete(s.conns, userID)
		}
		if sessionID != "" {
			delete(s.sessionConns, sessionID)
		}
		s.connMu.Unlock()
		return false
	}
	connCount--
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

	if connCount == 0 {
		s.onlineMu.Lock()
		delete(s.online, userID)
		s.offlineSince[userID] = time.Now()
		s.onlineMu.Unlock()
		return true
	}
	return false
}

func (s *Store) IsSessionOnline(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	s.connMu.Lock()
	defer s.connMu.Unlock()
	return s.sessionConns[sessionID] > 0
}
```

Старые `AddConnection`/`RemoveConnection` оставить обёртками:

```go
func (s *Store) AddConnection(userID string) bool {
	return s.AddConnectionForSession(userID, "")
}

func (s *Store) RemoveConnection(userID string) bool {
	return s.RemoveConnectionForSession(userID, "")
}
```

- [ ] **Step 3: Добавить SessionID в PushSubscription**

`backend/model/types.go`:

```go
type PushSubscription struct {
	ID        string    `gorm:"primaryKey"           json:"id"`
	UserID    string    `gorm:"index;not null"       json:"userId"`
	SessionID string    `gorm:"index;not null;default:''" json:"sessionId"`
	Endpoint  string    `gorm:"uniqueIndex;not null" json:"endpoint"`
	P256DH    string    `gorm:"not null"             json:"p256dh"`
	Auth      string    `gorm:"not null"             json:"auth"`
	CreatedAt time.Time `gorm:"not null"             json:"createdAt"`
}
```

- [ ] **Step 4: Store push-подписок**

Добавить:

```go
func (s *Store) AddPushSubscriptionForSession(ctx context.Context, userID, sessionID, endpoint, p256dh, auth string) (*model.PushSubscription, error) {
	sub := &model.PushSubscription{
		ID:        GenerateID(),
		UserID:    userID,
		SessionID: sessionID,
		Endpoint:  endpoint,
		P256DH:   p256dh,
		Auth:     auth,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.Assignments(map[string]any{
			"user_id":    userID,
			"session_id": sessionID,
			"p256_dh":    p256dh,
			"auth":       auth,
		}),
	}).Create(sub).Error; err != nil {
		return nil, err
	}

	var stored model.PushSubscription
	if err := s.db.WithContext(ctx).Where("endpoint = ?", endpoint).First(&stored).Error; err != nil {
		return nil, err
	}
	return &stored, nil
}

func (s *Store) DeletePushSubscriptionsBySession(ctx context.Context, sessionID string) error {
	return s.db.WithContext(ctx).Where("session_id = ?", sessionID).Delete(&model.PushSubscription{}).Error
}

func (s *Store) DeleteAllPushSubscriptions(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.PushSubscription{}).Error
}
```

Старую `AddPushSubscription` оставить как обёртку с `sessionID=""`.

- [ ] **Step 5: Сервис push-фильтра**

В `backend/service/push.go` добавить:

```go
func (s *Service) offlinePushSubscriptions(ctx context.Context, userID string) []model.PushSubscription {
	subs, err := s.store.GetPushSubscriptionsByUser(ctx, userID)
	if err != nil {
		return nil
	}

	out := make([]model.PushSubscription, 0, len(subs))
	for _, sub := range subs {
		if sub.SessionID == "" {
			if s.store.IsOnline(userID) {
				continue
			}
			out = append(out, sub)
			continue
		}
		if s.store.IsSessionOnline(sub.SessionID) {
			continue
		}
		out = append(out, sub)
	}
	return out
}
```

В `SendPushForMessage` удалить ранний `if s.push == nil || s.store.IsOnline(recipientID) { return }`
и заменить на:

```go
if s.push == nil {
	return
}
subs := s.offlinePushSubscriptions(ctx, recipientID)
if len(subs) == 0 {
	return
}
```

- [ ] **Step 6: Транспорт push-подписки**

В `backend/transport/push.go` в `subscribe-push`:

```go
user, ok := sessionFromContext(ctx)
if !ok {
	return nil, errUnauthorized
}

sub, err := st.AddPushSubscriptionForSession(ctx, user.ID, user.SessionID, input.Body.Endpoint, input.Body.P256DH, input.Body.Auth)
```

В `unsubscribe-push` использовать `sessionFromContext` и удалять только
endpoint текущей сессии; для legacy-подписок с пустым `session_id`
допустимо удалить по `user_id + endpoint`, как раньше.

- [ ] **Step 7: Прогнать тесты**

```bash
cd backend && go test ./store ./service ./transport -run 'Test(SessionPresence|Push|Subscribe)' -v
```

Expected: PASS.

---

## Task 8: звонки — push только offline-сессиям

**Files:**
- Modify: `backend/service/calls.go`
- Test: `backend/service/calls_test.go`
- Test: `backend/service/push_test.go`

- [ ] **Step 1: Написать падающий тест**

В `backend/service/push_test.go`:

```go
func TestOfflinePushSubscriptionsSkipsOnlineSession(t *testing.T) {
	s := newPushTestService(t)
	ctx := context.Background()
	alice := registerPushTestUser(t, s, "alice")

	if _, err := s.store.AddPushSubscriptionForSession(
		ctx, alice.ID, "s1", "https://fcm.googleapis.com/fcm/send/one", "dGVzdA==", "aHVl",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.AddPushSubscriptionForSession(
		ctx, alice.ID, "s2", "https://fcm.googleapis.com/fcm/send/two", "dGVzdA==", "aHVl",
	); err != nil {
		t.Fatal(err)
	}

	s.store.AddConnectionForSession(alice.ID, "s1")

	subs := s.offlinePushSubscriptions(ctx, alice.ID)
	if len(subs) != 1 {
		t.Fatalf("subscriptions = %+v, want only the offline s2", subs)
	}
	if subs[0].SessionID != "s2" {
		t.Fatalf("session = %q, want s2", subs[0].SessionID)
	}
}
```

- [ ] **Step 2: Запустить и увидеть падение**

```bash
cd backend && go test ./service -run TestOfflinePushSubscriptions -v
```

Expected: FAIL — `AddPushSubscriptionForSession`/`offlinePushSubscriptions`
ещё нет.

- [ ] **Step 3: Заменить проверку в sendCallPush**

`backend/service/calls.go`:

```go
func (s *Service) sendCallPush(ctx context.Context, call *calls.Call) {
	if s.push == nil {
		return
	}

	subs := s.offlinePushSubscriptions(ctx, call.CalleeID)
	if len(subs) == 0 {
		return
	}

	fromNick := s.nickOf(ctx, call.CallerID)

	payload, err := json.Marshal(callPushPayload{
		Title: fromNick,
		Tag:   "call-" + call.ID,
		Data: callPushData{
			CallID:   call.ID,
			ChatID:   call.ChatID,
			FromID:   call.CallerID,
			FromNick: fromNick,
		},
	})
	if err != nil {
		return
	}

	sendPushBounded(s.push, payload, subs)
}
```

Удалить `if s.store.IsOnline(call.CalleeID) { return }`.

- [ ] **Step 4: Прогнать тесты**

```bash
cd backend && go test ./service -run 'Test(Call|OfflinePushSubscriptions)' -v
```

Expected: PASS.

---

## Task 9: конфиг, cleanup, документация

**Files:**
- Modify: `backend/config/config.go`
- Modify: `backend/main.go`
- Modify: `backend/service/service.go`
- Modify: `config/dev.yaml`
- Modify: `config/prod.yaml.example`
- Modify: `README.md`
- Test: `backend/config/config_test.go`

- [ ] **Step 1: Добавить конфиг в примеры**

Поле `AuthConfig.MaxSessionsPerUser` уже добавлено в Task 4. Здесь
добавить его в `config/dev.yaml` и `config/prod.yaml.example`:

```yaml
auth:
    token_expiry: 24h
    token_expiry_warning: 5m
    max_sessions_per_user: 50
```

- [ ] **Step 2: Cleanup worker**

`Service`:

```go
// RunSessionCleanup removes sessions that expired or were revoked long ago.
func (s *Service) RunSessionCleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
			if removed, err := s.store.DeleteOldSessions(ctx, cutoff); err != nil {
				log().Warn("session cleanup failed", "err", err)
			} else if removed > 0 {
				log().Info("removed old sessions", "count", removed)
			}
		}
	}
}
```

В `startWorkers`:

```go
workers.Go(func() {
	svc.RunSessionCleanup(ctx, time.Hour)
})
```

- [ ] **Step 3: README**

Добавить в таблицу API:

- `GET /api/sessions` — список устройств;
- `DELETE /api/sessions/{id}` — отозвать устройство;
- `POST /api/auth/logout-all` — выйти на всех устройствах.

Обновить раздел «Сессии», убрать утверждение «у аккаунта одна сессия».

- [ ] **Step 4: Прогнать конфиг-тесты**

```bash
cd backend && go test ./config -count=1
```

Expected: PASS.

---

## Task 10: финальная проверка

- [ ] **Step 1: gofmt**

```bash
cd backend && gofmt -w ./...
```

- [ ] **Step 2: Backend lint**

```bash
make backend:lint
```

Expected: PASS или только задокументированные предупреждения.

- [ ] **Step 3: Backend tests**

```bash
make backend:test
```

Expected: PASS.

- [ ] **Step 4: Полный lint/test**

```bash
make lint
make test
```

Expected: PASS.

- [ ] **Step 5: Проверить старый сценарий вручную**

1. Запустить сервер на пустой БД.
2. Зарегистрировать пользователя, сохранить токен.
3. Выполнить `POST /api/auth/verify-code` с тем же email и другим
   `deviceId`.
4. Убедиться, что старый токен всё ещё проходит `GET /api/chats`, а новый
   тоже.
5. `GET /api/sessions` — два устройства.
6. `DELETE /api/sessions/{id}` — отозвать второе; первый токен работает.
7. `POST /api/auth/logout-all` — оба токена получают `401`.

---

## Self-review

- [ ] Каждый пункт спеки Phase A, относящийся к backend, покрыт задачей.
- [ ] Нет `TODO`/`TBD` и ссылок на несуществующие функции.
- [ ] `Session`, `DeviceInfo`, `authUser{SessionID}` одинаково названы во
      всех задачах.
- [ ] Старые тесты и старый frontend не ломаются благодаря backfill.
- [ ] Коммиты не выполняются без разрешения пользователя.
