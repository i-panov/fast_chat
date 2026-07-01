package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"fast_chat/model"
)

var (
	ErrNicknameTaken = errors.New("nickname already taken")
	ErrEmailTaken    = errors.New("email already taken")
)

func GenerateID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

func (s *Store) CreateUser(ctx context.Context, email, nick, serverDomain string, tokenExpiry time.Duration) (*model.User, error) {
	fullID := nick + ":" + serverDomain
	now := time.Now()

	user := &model.User{
		ID:             fullID,
		Email:          email,
		Nick:           nick,
		Token:          GenerateID(),
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

	return user, nil
}

func (s *Store) GetUserByToken(ctx context.Context, token string) (*model.User, bool) {
	var user model.User
	if err := s.db.WithContext(ctx).Where("token = ?", token).First(&user).Error; err != nil {
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

func (s *Store) RefreshUserToken(ctx context.Context, userID string, tokenExpiry time.Duration) (*model.User, error) {
	user, ok := s.GetUserByID(ctx, userID)
	if !ok {
		return nil, errors.New("user not found")
	}

	user.Token = GenerateID()
	user.TokenExpiresAt = time.Now().Add(tokenExpiry)

	if err := s.db.WithContext(ctx).Save(user).Error; err != nil {
		return nil, err
	}

	return user, nil
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

func (s *Store) SearchUsers(ctx context.Context, query, excludeID string) []model.PublicUser {
	q := strings.ToLower(query)

	var users []model.User
	s.db.WithContext(ctx).Where("LOWER(nick) LIKE ? AND id != ?", "%"+q+"%", excludeID).Find(&users)

	if len(users) == 0 {
		return []model.PublicUser{}
	}

	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	out := make([]model.PublicUser, 0, len(users))
	for _, u := range users {
		_, online := s.online[u.ID]
		out = append(out, model.PublicUser{ID: u.ID, Nick: u.Nick, Email: u.Email, Online: online})
	}

	return out
}
