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
	// usernameMaxRunes is the maximum total username length.
	usernameMaxRunes = 32
	usernameMinRunes = 3
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
	ErrUserBanned        = errors.New("account banned")
	ErrInvalidSetupToken = errors.New("invalid setup token")
	ErrNickInvalid       = errors.New("username must be 3-32 characters")
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

	// Store only after the mail is accepted: a code for an undelivered mail
	// would otherwise stay valid for 10 minutes without ever reaching the user.
	if err := s.email.SendCode(email, code); err != nil {
		log().Error("failed to send email", "err", err)
		return nil, ErrEmailSendFailed
	}

	s.store.Codes().StoreCode(email, code, emailCodeTTL)

	return &SendCodeResult{DebugCode: code}, nil
}

// VerifyCodeResult is the outcome of confirming a code: either an existing
// user logs back in on a new device session or a setup token is issued to
// complete registration.
type VerifyCodeResult struct {
	IsNew      bool
	User       *model.User
	Session    *model.Session
	Token      string
	SetupToken string
}

// VerifyCode checks the code and returns a new session for an existing user
// or a setup token for a brand new one.
func (s *Service) VerifyCode(ctx context.Context, input, code string, device DeviceInfo) (*VerifyCodeResult, error) {
	email := normalizeEmail(input)
	code = strings.TrimSpace(code)

	if !s.store.Codes().VerifyCode(email, code) {
		return nil, ErrInvalidCode
	}

	user, exists := s.store.GetUserByEmail(ctx, email)
	if exists {
		// A banned account must not obtain a new session: deleting the old
		// sessions alone would let it log straight back in.
		if user.Banned {
			return nil, ErrUserBanned
		}

		device = normalizeDevice(device)

		// Serialize login + trim per process: the cap is enforced after the
		// new session exists, and two concurrent logins must not both pass it
		// or race the same-device select/insert.
		s.authMu.Lock()
		defer s.authMu.Unlock()

		session, token, err := s.store.CreateSession(
			ctx, user.ID, device.ID, device.Name, device.UserAgent, s.sessionTTL(),
		)
		if err != nil {
			log().Error("failed to create session", "err", err)
			return nil, err
		}

		// A re-login on the same device rotates the token and extends the
		// expiry of the session row; an SSE stream already bound to it must
		// learn the new deadline instead of expiring at the old one.
		if s.hub != nil {
			s.hub.UpdateSessionExpiry(session.ID, session.ExpiresAt)
		}

		s.trimSessions(ctx, user.ID, session.ID)

		return &VerifyCodeResult{User: user, Session: session, Token: token}, nil
	}

	setupToken := s.store.Codes().CreateSetupToken(email, emailCodeTTL)
	return &VerifyCodeResult{IsNew: true, SetupToken: setupToken}, nil
}

// RegistrationResult is the outcome of a completed registration: the new
// account, its first device session and the session token.
type RegistrationResult struct {
	User    *model.User
	Session *model.Session
	Token   string
}

// CompleteRegistration validates the nick and setup token, then creates the
// user, their first session and their private self-chat.
func (s *Service) CompleteRegistration(
	ctx context.Context, setupToken, username, displayName string, device DeviceInfo,
) (*RegistrationResult, error) {

	username, ok := NormalizeUsername(username)
	if !ok || strings.HasSuffix(username, "_bot") {
		return nil, ErrNickInvalid
	}
	displayName = strings.TrimSpace(displayName)
	if utf8.RuneCountInString(displayName) > 64 {
		return nil, ErrNickInvalid
	}
	if displayName == "" {
		displayName = username
	}

	email, ok := s.store.Codes().PeekSetupToken(setupToken)
	if !ok {
		return nil, ErrInvalidSetupToken
	}

	device = normalizeDevice(device)

	user, session, token, err := s.store.CreateUserWithSession(
		ctx, email, username, displayName, s.cfg.Server.Domain,
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

	// The account exists now; the token's job is done. Consuming it earlier
	// would strand a registration whose nickname was rejected.
	_, _ = s.store.Codes().VerifySetupToken(setupToken)

	if _, err := s.store.EnsureSelfChat(ctx, user.ID); err != nil {
		log().Error("failed to ensure self-chat", "err", err)
		return nil, err
	}

	return &RegistrationResult{User: user, Session: session, Token: token}, nil
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
