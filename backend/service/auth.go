package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/mail"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/store"
)

const (
	// nickMaxRunes is the maximum allowed length of a display nick.
	nickMaxRunes = 20
	// emailCodeTTL is the lifetime of both the verification code and the
	// setup token issued to finish registration.
	emailCodeTTL = 10 * time.Minute
)

// Auth domain errors. Handlers map a specific error to an HTTP status and a
// stable user-facing message; the service never depends on the transport.
var (
	ErrInvalidEmail      = errors.New("invalid email")
	ErrEmailNotAllowed   = errors.New("email not allowed")
	ErrEmailSendFailed   = errors.New("failed to send email")
	ErrInvalidCode       = errors.New("invalid code")
	ErrInvalidSetupToken = errors.New("invalid setup token")
	ErrNickInvalid       = errors.New("nick must be 1-20 characters")
	ErrNickColon         = errors.New("nick must not contain ':'")
	ErrNicknameTaken     = errors.New("nickname already taken")
	ErrEmailAlreadyTaken = errors.New("email already registered")
)

// SendCodeResult carries the outcome of requesting a verification code.
type SendCodeResult struct {
	// DebugCode is the generated code, exposed only by the transport when
	// email debug mode is enabled.
	DebugCode string
}

// SendCode normalizes the email, validates it and the allow-list, then
// generates, stores and mails a one-time verification code.
func (s *Service) SendCode(input string) (*SendCodeResult, error) {
	email := normalizeEmail(input)
	if !isValidEmail(email) {
		return nil, ErrInvalidEmail
	}

	if len(s.cfg.Email.AllowedEmails) > 0 && !slices.Contains(s.cfg.Email.AllowedEmails, email) {
		return nil, ErrEmailNotAllowed
	}

	code, err := generateCode()
	if err != nil {
		return nil, err
	}

	s.store.Codes().StoreCode(email, code, emailCodeTTL)

	if err := s.email.SendCode(email, code); err != nil {
		log().Error("failed to send email", "err", err)
		return nil, ErrEmailSendFailed
	}

	return &SendCodeResult{DebugCode: code}, nil
}

// VerifyCodeResult is the outcome of confirming a code: either an existing
// user logs back in (with a freshly refreshed token) or a setup token is
// issued to complete registration.
type VerifyCodeResult struct {
	IsNew      bool
	User       *model.User
	SetupToken string
}

// VerifyCode checks the code and returns a refreshed session for an existing
// user or a setup token for a brand new one.
func (s *Service) VerifyCode(ctx context.Context, input, code string) (*VerifyCodeResult, error) {
	email := normalizeEmail(input)
	code = strings.TrimSpace(code)

	if !s.store.Codes().VerifyCode(email, code) {
		return nil, ErrInvalidCode
	}

	user, exists := s.store.GetUserByEmail(ctx, email)
	if exists {
		user, err := s.store.RefreshUserToken(ctx, user.ID, s.cfg.Auth.TokenExpiry)
		if err != nil {
			log().Error("failed to refresh token", "err", err)
			return nil, err
		}

		return &VerifyCodeResult{User: user}, nil
	}

	setupToken := s.store.Codes().CreateSetupToken(email, emailCodeTTL)
	return &VerifyCodeResult{IsNew: true, SetupToken: setupToken}, nil
}

// CompleteRegistration validates the nick and setup token, then creates the
// user and their private self-chat.
func (s *Service) CompleteRegistration(ctx context.Context, setupToken, nick string) (*model.User, error) {
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

	user, err := s.store.CreateUser(ctx, email, nick, s.cfg.Server.Domain, s.cfg.Auth.TokenExpiry)
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

	return user, nil
}

// RefreshToken issues a fresh token for the given user.
func (s *Service) RefreshToken(ctx context.Context, userID string) (*model.User, error) {
	user, err := s.store.RefreshUserToken(ctx, userID, s.cfg.Auth.TokenExpiry)
	if err != nil {
		log().Error("failed to refresh token", "err", err)
		return nil, err
	}

	return user, nil
}

func normalizeEmail(email string) string {
	return strings.TrimSpace(strings.ToLower(email))
}

func isValidEmail(email string) bool {
	addr, err := mail.ParseAddress(email)
	if err != nil {
		return false
	}

	// mail.ParseAddress accepts "Name <email>" forms; require a bare
	// address so names/whitespace cannot slip into the stored email.
	return addr.Address == email
}

func generateCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}

	return fmt.Sprintf("%06d", n.Int64()), nil
}
