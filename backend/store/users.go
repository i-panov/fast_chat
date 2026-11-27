package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"time"

	"gorm.io/gorm"

	"fast_chat/internal/ids"
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

// GenerateID returns a random 128-bit identifier. It is a wrapper over
// internal/ids so that packages without a database dependency can generate
// identifiers too.
func GenerateID() string {
	return ids.Generate()
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

// CreateUserWithSession creates the account and its first session in one
// transaction. The returned token is plaintext and sent to the client once.
func (s *Store) CreateUserWithSession(
	ctx context.Context, email, username, displayName, serverDomain, deviceID, deviceName, userAgent string, ttl time.Duration,
) (*model.User, *model.Session, string, error) {

	if ttl <= 0 {
		return nil, nil, "", errInvalidTTL
	}

	fullID := username + ":" + serverDomain
	now := time.Now().UTC()
	token := GenerateID()

	user := &model.User{
		ID:          fullID,
		Email:       email,
		Username:    username,
		DisplayName: displayName,
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
		// Match the column with or without table qualification
		// ("users.email" and bare "email" both occur across sqlite driver
		// versions): an unqualified Contains("email") would also misclassify
		// id/token collisions, and any other UNIQUE failure must stay a
		// raw error.
		msg := err.Error()
		if strings.Contains(msg, "UNIQUE constraint failed") {
			switch {
			case strings.Contains(msg, ".email") || strings.Contains(msg, ": email"):
				return nil, nil, "", ErrEmailTaken
			case strings.Contains(msg, ".username") || strings.Contains(msg, ": username"):
				return nil, nil, "", ErrNicknameTaken
			}
		}

		return nil, nil, "", err
	}

	// Return the plaintext token to the caller (it is sent to the client
	// exactly once); only the hash is persisted.
	user.Token = token

	return user, session, token, nil
}

// CreateUser keeps the pre-session signature working for callers that do not
// have device information: it creates the account with a legacy session.
func (s *Store) CreateUser(ctx context.Context, email, username, serverDomain string, tokenExpiry time.Duration) (*model.User, error) {
	if tokenExpiry <= 0 {
		tokenExpiry = 24 * time.Hour
	}
	user, _, _, err := s.CreateUserWithSession(ctx, email, username, username, serverDomain, legacyDeviceID, "Legacy session", "", tokenExpiry)
	return user, err
}

// UpdateUserAvatar points the user at an uploaded file. An empty fileID
// clears the avatar.
func (s *Store) UpdateUserAvatar(ctx context.Context, userID, fileID string) (*model.User, error) {
	var user model.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", userID).Error; err != nil {
		return nil, err
	}
	if err := s.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Update("avatar_file_id", fileID).Error; err != nil {
		return nil, err
	}
	user.AvatarFileID = fileID
	return &user, nil
}

// GetUsersByAvatarFileID returns the users who use fileID as their avatar.
func (s *Store) GetUsersByAvatarFileID(ctx context.Context, fileID string) ([]string, error) {
	if fileID == "" {
		return nil, nil
	}
	var userIDs []string
	err := s.db.WithContext(ctx).Model(&model.User{}).
		Where("avatar_file_id = ?", fileID).
		Pluck("id", &userIDs).Error
	return userIDs, err
}

// GetUserByToken resolves a bearer token through the sessions table, so only
// active, unexpired sessions authenticate.
func (s *Store) GetUserByToken(ctx context.Context, token string) (*model.User, bool) {
	_, user, ok := s.GetSessionByToken(ctx, token)
	return user, ok
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

const fieldPublicKey = "public_key"

// ErrStaleMasterKey reports a key upload older than the stored version.
var ErrStaleMasterKey = errors.New("stale E2EE key version")

// UpdateUserMasterKey stores the account's master public key pair and its
// version. The private halves never reach the server.
func (s *Store) UpdateUserMasterKey(ctx context.Context, userID, publicKey, identityPublicKey string, version int) error {
	version = max(version, 1)
	// An upload may advance the version, or repeat the exact same key (a
	// lost response retry). A different key or identity under an old/equal
	// version is a rollback: it would leave the server handing out a key
	// that the rotating device cannot read or peers cannot verify.
	result := s.db.WithContext(ctx).Model(&model.User{}).
		Where(
			`id = ? AND (
				key_version < ?
				OR (key_version = ? AND identity_public_key = '')
				OR (key_version = ? AND (public_key = ? OR public_key = '')
					AND (identity_public_key = ? OR identity_public_key = ''))
			)`,
			userID, version, version, version, publicKey, identityPublicKey,
		).
		Updates(map[string]any{
			fieldPublicKey:        publicKey,
			"identity_public_key": identityPublicKey,
			"key_version":         version,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrStaleMasterKey
	}
	return nil
}

// GetUserMasterKey returns the account's master public keys and version.
func (s *Store) GetUserMasterKey(ctx context.Context, userID string) (string, string, int, bool) {
	var user model.User
	if err := s.db.WithContext(ctx).Select("public_key", "identity_public_key", "key_version").
		Where("id = ?", userID).First(&user).Error; err != nil || user.PublicKey == "" {
		return "", "", 0, false
	}
	version := user.KeyVersion
	version = max(version, 1)
	return user.PublicKey, user.IdentityPublicKey, version, true
}

// ErrStaleKeyBackup reports a backup whose version does not match the
// published master key. Without this guard a device that missed a rotation
// could overwrite the backup of the current key with an older private key.
var ErrStaleKeyBackup = errors.New("stale E2EE key backup")

// SetKeyBackup stores the client-encrypted private key backup blob for a
// user. The server never decrypts it; it only stores and returns it.
func (s *Store) SetKeyBackup(ctx context.Context, userID, blob string, version int) error {
	now := time.Now().UTC()
	result := s.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ? AND key_version = ?", userID, max(version, 1)).
		Updates(map[string]any{fieldKeyBackup: blob, fieldKeyBackupAt: now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrStaleKeyBackup
	}
	return nil
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
func (s *Store) DeleteKeyBackup(ctx context.Context, userID string, version int) error {
	result := s.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ? AND key_version = ?", userID, max(version, 1)).
		Updates(map[string]any{fieldKeyBackup: "", fieldKeyBackupAt: nil})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrStaleKeyBackup
	}
	return nil
}

func (s *Store) GetUsersByIDs(ctx context.Context, userIDs []string) map[string]string {
	out := make(map[string]string, len(userIDs))
	if len(userIDs) == 0 {
		return out
	}

	var rows []struct {
		ID       string
		Username string
	}

	for start := 0; start < len(userIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(userIDs))

		var chunk []struct {
			ID       string
			Username string
		}
		query := s.db.WithContext(ctx).Model(&model.User{}).
			Where("id IN ?", userIDs[start:end]).
			Select(`id, COALESCE(NULLIF(display_name, ''), username) AS username`)
		if err := query.Scan(&chunk).Error; err != nil {
			slog.Warn("GetUsersByIDs failed", "err", err)
			return map[string]string{}
		}

		rows = append(rows, chunk...)
	}

	for _, r := range rows {
		out[r.ID] = r.Username
	}

	return out
}

const maxLocalSearchResults = 50

// SearchUsers returns users whose username or display name contains the query (case-insensitive),
// excluding excludeID. NOTE: LIKE '%...%' prevents index usage in SQLite.
// Acceptable for the expected user base (<10K users). If performance becomes
// an issue, add a FTS5 virtual table and migrate SearchUsers to MATCH.
func (s *Store) SearchUsers(ctx context.Context, query, excludeID string) []model.PublicUser {
	pattern := escapeLike(strings.ToLower(query))

	var users []model.User
	// A bounded result set: the search box has no pagination, and an
	// unbounded LIKE scan over every account is both a privacy leak and a
	// cheap way to load the server.
	if err := s.db.WithContext(ctx).
		Where(`(LOWER(username) LIKE ? ESCAPE '\' OR LOWER(display_name) LIKE ? ESCAPE '\') AND id != ?`, "%"+pattern+"%", "%"+pattern+"%", excludeID).
		Limit(maxLocalSearchResults).
		Find(&users).Error; err != nil {
		slog.Warn("SearchUsers failed", "err", err)
		return []model.PublicUser{}
	}

	if len(users) == 0 {
		return []model.PublicUser{}
	}

	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	out := make([]model.PublicUser, 0, len(users))
	for i := range users {
		_, online := s.online[users[i].ID]
		users[i].Online = online
		out = append(out, users[i].Public())
	}

	return out
}

// GetUsersFullByIDs returns users keyed by id in bounded chunks, for callers
// that render many members at once.
func (s *Store) GetUsersFullByIDs(ctx context.Context, userIDs []string) map[string]*model.User {
	out := make(map[string]*model.User, len(userIDs))
	for start := 0; start < len(userIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(userIDs))
		var users []model.User
		if err := s.db.WithContext(ctx).Where("id IN ?", userIDs[start:end]).Find(&users).Error; err != nil {
			slog.Warn("GetUsersFullByIDs failed", "err", err)
			continue
		}
		for idx := range users {
			out[users[idx].ID] = &users[idx]
		}
	}
	return out
}
