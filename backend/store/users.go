package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"fast_chat/model"
)

const (
	fieldKeyBackup   = "key_backup"
	fieldKeyBackupAt = "key_backup_at"
)

var (
	ErrNicknameTaken = errors.New("nickname already taken")
	ErrEmailTaken    = errors.New("email already taken")
	ErrUserNotFound  = errors.New("user not found")
)

func GenerateID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

// hashToken returns the SHA-256 hex digest of a bearer token. Tokens are
// stored hashed so that a leaked database does not expose live sessions.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))

	return hex.EncodeToString(sum[:])
}

// escapeLike escapes LIKE wildcards so user input cannot turn a search
// into a wildcard match (e.g. "%" matching every user).
func escapeLike(value string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)

	return r.Replace(value)
}

func (s *Store) CreateUser(ctx context.Context, email, nick, serverDomain string, tokenExpiry time.Duration) (*model.User, error) {
	fullID := nick + ":" + serverDomain
	now := time.Now().UTC()
	token := GenerateID()

	user := &model.User{
		ID:             fullID,
		Email:          email,
		Nick:           nick,
		Token:          hashToken(token),
		TokenExpiresAt: now.Add(tokenExpiry),
	}

	if err := s.db.WithContext(ctx).Create(user).Error; err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			if strings.Contains(err.Error(), "email") {
				return nil, ErrEmailTaken
			}

			return nil, ErrNicknameTaken
		}

		return nil, err
	}

	// Return the plaintext token to the caller (it is sent to the client
	// exactly once); only the hash is persisted.
	user.Token = token

	return user, nil
}

func (s *Store) GetUserByToken(ctx context.Context, token string) (*model.User, bool) {
	var user model.User
	if err := s.db.WithContext(ctx).Where("token = ?", hashToken(token)).First(&user).Error; err != nil {
		return nil, false
	}

	return &user, true
}

func (s *Store) GetUserByID(ctx context.Context, id string) (*model.User, bool) {
	var user model.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", id).Error; err != nil {
		return nil, false
	}

	return &user, true
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*model.User, bool) {
	var user model.User
	if err := s.db.WithContext(ctx).Where("email = ?", email).First(&user).Error; err != nil {
		return nil, false
	}

	return &user, true
}

// UpdateUserPublicKey stores the user's E2E X25519 public key (base64).
func (s *Store) UpdateUserPublicKey(ctx context.Context, userID, publicKey string) error {
	return s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Update("public_key", publicKey).Error
}

// GetUserPublicKey returns the user's E2E public key; ok=false when the
// user has no key yet (they have not completed E2E setup).
func (s *Store) GetUserPublicKey(ctx context.Context, userID string) (string, bool) {
	var key string
	if err := s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Select("public_key").Scan(&key).Error; err != nil || key == "" {
		return "", false
	}

	return key, true
}

// SetKeyBackup stores the client-encrypted private key backup blob for a
// user. The server never decrypts it; it only stores and returns it.
func (s *Store) SetKeyBackup(ctx context.Context, userID, blob string) error {
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{fieldKeyBackup: blob, fieldKeyBackupAt: now}).Error
}

// GetKeyBackup returns the stored backup blob; ok=false when none exists.
func (s *Store) GetKeyBackup(ctx context.Context, userID string) (string, bool) {
	var blob string
	if err := s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Select(fieldKeyBackup).Scan(&blob).Error; err != nil || blob == "" {
		return "", false
	}

	return blob, true
}

// DeleteKeyBackup removes a user's backup blob (key revocation).
func (s *Store) DeleteKeyBackup(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{fieldKeyBackup: "", fieldKeyBackupAt: nil}).Error
}

func (s *Store) RefreshUserToken(ctx context.Context, userID string, tokenExpiry time.Duration) (*model.User, error) {
	user, ok := s.GetUserByID(ctx, userID)
	if !ok {
		return nil, ErrUserNotFound
	}

	token := GenerateID()
	user.Token = hashToken(token)
	user.TokenExpiresAt = time.Now().UTC().Add(tokenExpiry)

	if err := s.db.WithContext(ctx).Save(user).Error; err != nil {
		return nil, err
	}

	// Return the plaintext token to the caller; only the hash is persisted.
	user.Token = token

	return user, nil
}

// RevokeUserToken invalidates the session of the user. The stored token is
// replaced with the hash of a fresh random value, so the token the client
// holds stops working immediately instead of at the end of its lifetime.
func (s *Store) RevokeUserToken(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{
			"token":            hashToken(GenerateID()),
			"token_expires_at": time.Now().UTC(),
		}).Error
}

func (s *Store) GetUsersByIDs(ctx context.Context, ids []string) map[string]string {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out
	}

	var rows []struct {
		ID   string
		Nick string
	}

	s.db.WithContext(ctx).Model(&model.User{}).Where("id IN ?", ids).Select("id, nick").Scan(&rows)

	for _, r := range rows {
		out[r.ID] = r.Nick
	}

	return out
}

// SearchUsers returns users whose nick contains the query (case-insensitive),
// excluding excludeID. NOTE: LIKE '%...%' prevents index usage in SQLite.
// Acceptable for the expected user base (<10K users). If performance becomes
// an issue, add a FTS5 virtual table and migrate SearchUsers to MATCH.
func (s *Store) SearchUsers(ctx context.Context, query, excludeID string) []model.PublicUser {
	q := escapeLike(strings.ToLower(query))

	var users []model.User
	s.db.WithContext(ctx).Where("LOWER(nick) LIKE ? ESCAPE '\\' AND id != ?", "%"+q+"%", excludeID).Find(&users)

	if len(users) == 0 {
		return []model.PublicUser{}
	}

	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	out := make([]model.PublicUser, 0, len(users))
	for i := range users {
		_, online := s.online[users[i].ID]
		out = append(out, model.PublicUser{ID: users[i].ID, Nick: users[i].Nick, Online: online})
	}

	return out
}
