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

// Store is a thread-safe in-memory storage for users, chats, messages, and threads.
type Store struct {
	mu              sync.RWMutex
	users           map[string]*model.User
	tokens          map[string]*model.User
	nicks           map[string]string
	chats           map[string]*model.Chat
	messages        map[string][]model.Message
	conns           map[string]int
	threads         map[string]*model.Thread
	threadMessages  map[string][]model.Message
	messageToThread map[string]string // key: "chatID:messageID", value: threadID
}

// New creates a new empty Store.
func New() *Store {
	return &Store{
		users:           make(map[string]*model.User),
		tokens:          make(map[string]*model.User),
		nicks:           make(map[string]string),
		chats:           make(map[string]*model.Chat),
		messages:        make(map[string][]model.Message),
		conns:           make(map[string]int),
		threads:         make(map[string]*model.Thread),
		threadMessages:  make(map[string][]model.Message),
		messageToThread: make(map[string]string),
	}
}

// CreateUser registers a new user with the given full ID and display nickname.
// fullID should be in "nick:domain" format, nick is the display name without domain.
func (s *Store) CreateUser(fullID, nick string) (*model.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.nicks[fullID]; exists {
		return nil, errors.New("nickname already taken")
	}

	user := &model.User{
		ID:     fullID,
		Nick:   nick,
		Token:  generateID(),
		Online: true,
	}

	s.users[user.ID] = user
	s.tokens[user.Token] = user
	s.nicks[fullID] = user.ID

	return user, nil
}

// GetUserByToken looks up a user by their auth token.
func (s *Store) GetUserByToken(token string) (*model.User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	u, ok := s.tokens[token]

	return u, ok
}

// GetUserByID looks up a user by their ID.
func (s *Store) GetUserByID(id string) (*model.User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	u, ok := s.users[id]

	return u, ok
}

// SearchUsers finds users whose nickname contains the query string,
// excluding the user with the given excludeID. Returns copies to avoid data races.
func (s *Store) SearchUsers(query, excludeID string) []model.User {
	s.mu.RLock()
	defer s.mu.RUnlock()

	q := strings.ToLower(query)

	result := make([]model.User, 0)

	for _, u := range s.users {
		if u.ID != excludeID && strings.Contains(strings.ToLower(u.Nick), q) {
			result = append(result, *u)
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

// GetMessage returns a single message by its ID.
func (s *Store) GetMessage(chatID, messageID string) (*model.Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	msgs := s.messages[chatID]
	for idx := range msgs {
		if msgs[idx].ID == messageID {
			return &msgs[idx], nil
		}
	}

	return nil, errors.New("message not found")
}

// EditMessage updates the text of an existing message.
func (s *Store) EditMessage(chatID, messageID, userID, newText string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[chatID]

	for idx := range msgs {
		if msgs[idx].ID != messageID {
			continue
		}

		if msgs[idx].FromID != userID {
			return nil, errors.New("not your message")
		}

		msgs[idx].Text = newText
		now := time.Now()
		msgs[idx].EditedAt = &now

		return &msgs[idx], nil
	}

	return nil, errors.New("message not found")
}

// AddMessage stores a new message in the given chat.
// If messageID is non-empty, it is used as the message ID; otherwise one is generated.
func (s *Store) AddMessage(chatID, fromID, fromNick, text, messageID string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.chats[chatID]; !ok {
		return nil, errors.New("chat not found")
	}

	id := messageID
	if id == "" {
		id = generateID()
	}

	msg := model.Message{
		ID:        id,
		ChatID:    chatID,
		FromID:    fromID,
		FromNick:  fromNick,
		Text:      text,
		CreatedAt: time.Now(),
	}

	s.messages[chatID] = append(s.messages[chatID], msg)

	return &msg, nil
}

// AddRawMessage appends a pre-built message to a chat (used by federated endpoints).
func (s *Store) AddRawMessage(msg *model.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.chats[msg.ChatID]; !ok {
		return errors.New("chat not found")
	}

	s.messages[msg.ChatID] = append(s.messages[msg.ChatID], *msg)

	return nil
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

// paginateMessages returns up to limit messages older than the given cursor from the given slice.
// If before is empty, returns the most recent messages.
// Returns messages in chronological order, nextCursor for the next page (oldest message ID), and hasMore.
func paginateMessages(all []model.Message, limit int, before string) ([]model.Message, string, bool) {
	end := len(all)
	if before != "" {
		for idx := range all {
			if all[idx].ID == before {
				end = idx
				break
			}
		}
	}

	if end <= 0 {
		return nil, "", false
	}

	start := end - limit
	if start < 0 {
		start = 0
	}

	result := make([]model.Message, end-start)
	copy(result, all[start:end])

	var nextCursor string

	var hasMore bool

	if start > 0 {
		nextCursor = all[start].ID
		hasMore = true
	}

	return result, nextCursor, hasMore
}

// GetMessagesPaginated returns paginated messages for a chat.
func (s *Store) GetMessagesPaginated(chatID string, limit int, before string) ([]model.Message, string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return paginateMessages(s.messages[chatID], limit, before)
}

// DeleteMessage removes a message if it belongs to the requesting user.
func (s *Store) DeleteMessage(chatID, messageID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[chatID]

	for idx, msg := range msgs {
		if msg.ID == messageID {
			if msg.FromID != userID {
				return errors.New("not your message")
			}

			s.messages[chatID] = append(msgs[:idx], msgs[idx+1:]...)

			return nil
		}
	}

	return errors.New("message not found")
}

// CreateRemoteChat stores a chat with a pre-generated ID (used by federated endpoints).
func (s *Store) CreateRemoteChat(chat *model.Chat) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.chats[chat.ID] = chat
	if _, ok := s.messages[chat.ID]; !ok {
		s.messages[chat.ID] = []model.Message{}
	}
}

// EditRawMessage updates a message's text without ownership check (used by federated endpoints).
func (s *Store) EditRawMessage(chatID, messageID, text string, editedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[chatID]
	for idx := range msgs {
		if msgs[idx].ID == messageID {
			msgs[idx].Text = text
			msgs[idx].EditedAt = &editedAt

			return nil
		}
	}

	return errors.New("message not found")
}

// DeleteRawMessage removes a message without ownership check (used by federated endpoints).
func (s *Store) DeleteRawMessage(chatID, messageID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[chatID]
	for idx, msg := range msgs {
		if msg.ID == messageID {
			s.messages[chatID] = append(msgs[:idx], msgs[idx+1:]...)

			return nil
		}
	}

	return errors.New("message not found")
}

// CreateThread creates a new thread for a parent message in a chat.
// The creator is automatically subscribed to the thread.
func (s *Store) CreateThread(chatID, parentMessageID, parentText, parentFrom string) (*model.Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.chats[chatID]; !ok {
		return nil, errors.New("chat not found")
	}

	key := chatID + ":" + parentMessageID
	if _, exists := s.messageToThread[key]; exists {
		return nil, errors.New("thread already exists for this message")
	}

	id := generateID()
	thread := &model.Thread{
		ID:                id,
		ChatID:            chatID,
		ParentMessageID:   parentMessageID,
		ParentMessageText: parentText,
		ParentMessageFrom: parentFrom,
		CreatedAt:         time.Now(),
		MessageCount:      0,
	}

	s.threads[id] = thread
	s.threadMessages[id] = []model.Message{}
	s.messageToThread[key] = id

	return thread, nil
}

// GetThread returns a thread by its ID.
func (s *Store) GetThread(threadID string) (*model.Thread, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	t, ok := s.threads[threadID]

	return t, ok
}

// GetThreadByParentMessage returns a thread for a given chat and parent message, if one exists.
func (s *Store) GetThreadByParentMessage(chatID, parentMessageID string) (*model.Thread, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	key := chatID + ":" + parentMessageID
	threadID, ok := s.messageToThread[key]

	if !ok {
		return nil, false
	}

	t, ok := s.threads[threadID]

	return t, ok
}

// GetThreadsForChat returns all threads for a given chat.
func (s *Store) GetThreadsForChat(chatID string) []*model.Thread {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*model.Thread

	for _, t := range s.threads {
		if t.ChatID == chatID {
			result = append(result, t)
		}
	}

	if result == nil {
		return []*model.Thread{}
	}

	return result
}

// GetThreadMessagesPaginated returns messages in a thread with pagination.
func (s *Store) GetThreadMessagesPaginated(threadID string, limit int, before string) ([]model.Message, string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return paginateMessages(s.threadMessages[threadID], limit, before)
}

// AddThreadMessage stores a new message in a thread.
// If messageID is non-empty, it is used as the message ID; otherwise one is generated.
func (s *Store) AddThreadMessage(threadID, fromID, fromNick, text, messageID string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	thread, ok := s.threads[threadID]
	if !ok {
		return nil, errors.New("thread not found")
	}

	id := messageID
	if id == "" {
		id = generateID()
	}

	msg := model.Message{
		ID:        id,
		ChatID:    threadID,
		FromID:    fromID,
		FromNick:  fromNick,
		Text:      text,
		CreatedAt: time.Now(),
	}

	s.threadMessages[threadID] = append(s.threadMessages[threadID], msg)
	thread.MessageCount++

	return &msg, nil
}

// AddConnection increments the connection count for a user and marks them online.
func (s *Store) AddConnection(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.conns[userID]++
	if u, ok := s.users[userID]; ok {
		u.Online = true
	}
}

// RemoveConnection decrements the connection count and marks the user offline
// when no connections remain.
func (s *Store) RemoveConnection(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.conns[userID]--
	if s.conns[userID] <= 0 {
		s.conns[userID] = 0

		if u, ok := s.users[userID]; ok {
			u.Online = false
		}
	}
}
