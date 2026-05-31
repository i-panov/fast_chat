// Package store provides an in-memory data store for the chat application.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"fast_chat/model"
)

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)

	return hex.EncodeToString(b)
}

// Store is a thread-safe in-memory storage for users, chats, and messages.
type Store struct {
	mu       sync.RWMutex
	users    map[string]*model.User
	nicks    map[string]string
	chats    map[string]*model.Chat
	messages map[string][]model.Message
}

// New creates a new empty Store.
func New() *Store {
	return &Store{
		users:    make(map[string]*model.User),
		nicks:    make(map[string]string),
		chats:    make(map[string]*model.Chat),
		messages: make(map[string][]model.Message),
	}
}

// CreateUser registers a new user with the given nickname.
// Returns an error if the nickname is already taken.
func (s *Store) CreateUser(nick string) (*model.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.nicks[nick]; exists {
		return nil, errors.New("nickname already taken")
	}

	user := &model.User{
		ID:     generateID(),
		Nick:   nick,
		Token:  generateID(),
		Online: true,
	}

	s.users[user.ID] = user
	s.nicks[nick] = user.ID

	return user, nil
}

// GetUserByToken looks up a user by their auth token.
func (s *Store) GetUserByToken(token string) (*model.User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, u := range s.users {
		if u.Token == token {
			return u, true
		}
	}

	return nil, false
}

// GetUserByID looks up a user by their ID.
func (s *Store) GetUserByID(id string) (*model.User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	u, ok := s.users[id]

	return u, ok
}

// SearchUsers finds users whose nickname contains the query string,
// excluding the user with the given excludeID.
func (s *Store) SearchUsers(query, excludeID string) []*model.User {
	s.mu.RLock()
	defer s.mu.RUnlock()

	q := strings.ToLower(query)

	var result []*model.User

	for _, u := range s.users {
		if u.ID != excludeID && strings.Contains(strings.ToLower(u.Nick), q) {
			result = append(result, u)
		}
	}

	return result
}

// CreateChat creates a new chat between two users, or returns an existing one.
func (s *Store) CreateChat(member1, member2 string) (*model.Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, chat := range s.chats {
		if len(chat.Members) != 2 {
			continue
		}

		if chat.Members[0] == member1 && chat.Members[1] == member2 {
			return chat, nil
		}

		if chat.Members[0] == member2 && chat.Members[1] == member1 {
			return chat, nil
		}
	}

	id := generateID()
	chat := &model.Chat{
		ID:        id,
		Members:   []string{member1, member2},
		CreatedAt: time.Now(),
	}

	s.chats[id] = chat
	s.messages[id] = []model.Message{}

	return chat, nil
}

// GetUserChats returns all chats that the given user is a member of.
func (s *Store) GetUserChats(userID string) []*model.Chat {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*model.Chat

	for _, c := range s.chats {
		for _, m := range c.Members {
			if m == userID {
				result = append(result, c)

				break
			}
		}
	}

	return result
}

// GetChat returns a chat by its ID.
func (s *Store) GetChat(chatID string) (*model.Chat, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	c, ok := s.chats[chatID]

	return c, ok
}

// AddMessage stores a new message in the given chat.
func (s *Store) AddMessage(chatID, fromID, fromNick, text string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.chats[chatID]; !ok {
		return nil, errors.New("chat not found")
	}

	msg := model.Message{
		ID:        generateID(),
		ChatID:    chatID,
		FromID:    fromID,
		FromNick:  fromNick,
		Text:      text,
		CreatedAt: time.Now(),
	}

	s.messages[chatID] = append(s.messages[chatID], msg)

	return &msg, nil
}

// GetMessages returns all messages for a given chat.
func (s *Store) GetMessages(chatID string) []model.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()

	msgs := s.messages[chatID]
	result := make([]model.Message, len(msgs))
	copy(result, msgs)

	return result
}

// SetUserOnline updates the online status of a user.
func (s *Store) SetUserOnline(userID string, online bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if u, ok := s.users[userID]; ok {
		u.Online = online
	}
}
