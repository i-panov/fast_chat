package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"

	"fast_chat/model"
)

var (
	ErrNicknameTaken = errors.New("nickname already taken")
)

func generateID() string {
	buf := make([]byte, 16)

	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

func (s *Store) CreateUser(fullID, nick string) (*model.User, error) {
	var existing int64
	s.db.Model(&model.User{}).Where("id = ?", fullID).Count(&existing)

	if existing > 0 {
		return nil, ErrNicknameTaken
	}

	user := &model.User{
		ID:    fullID,
		Nick:  nick,
		Token: generateID(),
	}

	if err := s.db.Create(user).Error; err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, ErrNicknameTaken
		}

		return nil, err
	}

	return user, nil
}

func (s *Store) GetUserByToken(token string) (*model.User, bool) {
	var user model.User

	if err := s.db.Where("token = ?", token).First(&user).Error; err != nil {
		return nil, false
	}

	return &user, true
}

func (s *Store) GetUserByID(id string) (*model.User, bool) {
	var user model.User

	if err := s.db.First(&user, "id = ?", id).Error; err != nil {
		return nil, false
	}

	return &user, true
}

// GetUsersByIDs returns a map of user ID -> nick for the given IDs. IDs
// that don't resolve are simply absent from the map. Use this in hot paths
// (e.g. enrichChat over a list of chats) to avoid one query per member.
func (s *Store) GetUsersByIDs(ids []string) map[string]string {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out
	}

	var rows []struct {
		ID   string
		Nick string
	}

	s.db.Model(&model.User{}).Where("id IN ?", ids).Select("id, nick").Scan(&rows)

	for _, r := range rows {
		out[r.ID] = r.Nick
	}

	return out
}

func (s *Store) SearchUsers(query, excludeID string) []model.PublicUser {
	q := strings.ToLower(query)

	var users []model.User

	s.db.Where("LOWER(nick) LIKE ? AND id != ?", "%"+q+"%", excludeID).Find(&users)

	if len(users) == 0 {
		return []model.PublicUser{}
	}

	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()

	out := make([]model.PublicUser, 0, len(users))
	for _, u := range users {
		_, online := s.online[u.ID]
		out = append(out, model.PublicUser{ID: u.ID, Nick: u.Nick, Online: online})
	}

	return out
}
