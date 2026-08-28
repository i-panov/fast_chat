package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

type VerificationCode struct {
	Email     string
	Code      string
	ExpiresAt time.Time
}

type SetupToken struct {
	Email     string
	Token     string
	ExpiresAt time.Time
}

type CodeStore struct {
	mu          sync.RWMutex
	codes       map[string]*VerificationCode // email -> code
	setupTokens map[string]*SetupToken       // token -> SetupToken
}

func NewCodeStore() *CodeStore {
	return &CodeStore{
		codes:       make(map[string]*VerificationCode),
		setupTokens: make(map[string]*SetupToken),
	}
}

func (s *CodeStore) StoreCode(email, code string, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.codes[email] = &VerificationCode{
		Email:     email,
		Code:      code,
		ExpiresAt: time.Now().Add(ttl),
	}
}

func (s *CodeStore) VerifyCode(email, code string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	vc, ok := s.codes[email]
	if !ok {
		return false
	}

	if time.Now().After(vc.ExpiresAt) {
		delete(s.codes, email)
		return false
	}

	if vc.Code != code {
		return false
	}

	delete(s.codes, email)

	return true
}

func (s *CodeStore) CreateSetupToken(email string, ttl time.Duration) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	token, err := generateSetupToken()
	if err != nil {
		return ""
	}

	s.setupTokens[token] = &SetupToken{
		Email:     email,
		Token:     token,
		ExpiresAt: time.Now().Add(ttl),
	}

	return token
}

func (s *CodeStore) VerifySetupToken(token string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	st, ok := s.setupTokens[token]
	if !ok {
		return "", false
	}

	if time.Now().After(st.ExpiresAt) {
		delete(s.setupTokens, token)
		return "", false
	}

	email := st.Email

	delete(s.setupTokens, token)

	return email, true
}

func (s *CodeStore) Cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()

	for email, vc := range s.codes {
		if now.After(vc.ExpiresAt) {
			delete(s.codes, email)
		}
	}

	for token, st := range s.setupTokens {
		if now.After(st.ExpiresAt) {
			delete(s.setupTokens, token)
		}
	}
}

// StartCleanup is an explicit background-loop entrypoint by design.
// nosemgrep: hidden-goroutine
func (s *CodeStore) StartCleanup(ctx context.Context, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				s.Cleanup()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func generateSetupToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate setup token: %w", err)
	}

	return hex.EncodeToString(buf), nil
}
