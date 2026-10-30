package transport

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/calls"
	"fast_chat/service"
	"fast_chat/store"
)

// statusError implements huma.StatusError using the pre-migration error
// shape. Huma serializes errors via reflection on exported fields, so the
// JSON output is `{"error": "<msg>"}` — matching the old writeError format.
type statusError struct {
	ErrorMessage string `doc:"Human-readable error message" json:"error"` //nolint:tagliatelle // pre-migration `error` key required
	// ErrorCode is the machine-readable reason of the error. It is set only
	// where the status is not enough to tell two errors apart, and it is
	// left empty everywhere else, so the other bodies stay as they were.
	ErrorCode string `doc:"Machine-readable reason" json:"code,omitempty"` //nolint:tagliatelle // the key is the contract with the client
	code      int
}

func (e *statusError) Error() string {
	return e.ErrorMessage
}

func (e *statusError) GetStatus() int {
	return e.code
}

func init() {
	// Override Huma's default RFC 9457 error model with the pre-migration shape.
	huma.NewError = func(status int, message string, _ ...error) huma.StatusError {
		return &statusError{ErrorMessage: message, code: status}
	}
}

// newHumaConfig builds a Huma config that mirrors the pre-migration transport: the
// default `$schema` link transformer is disabled so JSON responses are
// byte-identical to the old handler output (no `$schema` field).
func newHumaConfig(title, version string) huma.Config {
	cfg := huma.DefaultConfig(title, version)

	// DefaultConfig registers a create-hook that appends the JSON Schema link
	// transformer when the API is constructed. Dropping the hooks prevents
	// exactly that transformer; anything added later to cfg.Transformers is
	// still honored. (If a future huma version ships important default hooks,
	// revisit this.)
	cfg.CreateHooks = nil

	// The OpenAPI spec is served publicly: the server is open source, so the
	// API surface is public knowledge anyway, and self-documentation is a
	// feature for client developers.
	//
	// DocsPath stays empty — huma's renderer hardcodes a third-party CDN; the
	// UI is served by registerDocs with vendored assets instead. SchemasPath
	// stays empty too: it only serves $schema references produced by the link
	// transformer, which is disabled (pre-migration byte-parity), so the route would
	// answer null for unknown names and nothing links to it. The Stoplight UI
	// reads the self-contained /openapi.json.
	cfg.DocsPath = ""
	cfg.SchemasPath = ""

	return cfg
}

// MapError maps a service sentinel error to a Huma status error, mirroring the
// pre-migration handler error mappers (chatError, messageError, federateError,
// writeAuthError). Returns nil for unrecognized errors so the caller can log
// and return a generic 500.
func MapError(err error) huma.StatusError { //nolint:ireturn // huma.StatusError is the required interface
	if err == nil {
		return nil
	}

	// Struct-based errors first (errors.As).
	mnf, _ := errors.AsType[*service.GroupMemberNotFoundError](err)
	if mnf != nil {
		return &statusError{ErrorMessage: mnf.Error(), code: http.StatusNotFound}
	}

	// E2E payload validation errors (share the same status/message pattern).
	if isEncryptedPayloadError(err) {
		return &statusError{ErrorMessage: err.Error(), code: http.StatusBadRequest}
	}

	// Sentinel errors by domain, matched via errors.Is so wrapped sentinels
	// (fmt.Errorf("ctx: %w", err)) are handled correctly.
	for _, pair := range sentinelErrors {
		if errors.Is(err, pair.sentinel) {
			return pair.target
		}
	}

	return nil
}

// mapServerError translates a service error to a Huma status error, defaulting
// to a generic 500 for unmapped errors (mirroring the pre-migration transport, which
// logged and wrote 500 "internal error").
func mapServerError(err error) huma.StatusError { //nolint:ireturn // huma.StatusError is the required interface
	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("huma: unmapped service error", "err", err)

	return &statusError{ErrorMessage: "internal error", code: http.StatusInternalServerError}
}

func isEncryptedPayloadError(err error) bool {
	return errors.Is(err, service.ErrMissingEncryptedPayload) ||
		errors.Is(err, service.ErrEncryptedPayloadTooLarge) ||
		errors.Is(err, service.ErrInvalidEncryptedPayload) ||
		errors.Is(err, service.ErrUnsupportedPayloadVersion) ||
		errors.Is(err, service.ErrInvalidNonce) ||
		errors.Is(err, service.ErrMissingEnvelopes) ||
		errors.Is(err, service.ErrEmptyKeyID) ||
		errors.Is(err, service.ErrInvalidBox)
}

// sentinelErrPair links a service sentinel to its Huma status error.
type sentinelErrPair struct {
	sentinel error
	target   *statusError
}

// errThreadNotFound is shared by the sentinel mapping and the handlers that
// reject a thread id directly, so the wire message stays identical.
var errThreadNotFound = &statusError{ErrorMessage: "thread not found", code: http.StatusNotFound}

var sentinelErrors = []sentinelErrPair{
	// Auth domain.
	{
		sentinel: service.ErrInvalidEmail,
		target:   &statusError{ErrorMessage: "invalid email", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrEmailNotAllowed,
		target:   &statusError{ErrorMessage: "email not allowed", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrEmailSendFailed,
		target:   &statusError{ErrorMessage: "failed to send email", code: http.StatusInternalServerError},
	},
	{
		sentinel: service.ErrInvalidCode,
		target:   &statusError{ErrorMessage: "invalid code", code: http.StatusUnauthorized},
	},
	{
		sentinel: service.ErrInvalidSetupToken,
		target:   &statusError{ErrorMessage: "invalid setup token", code: http.StatusUnauthorized},
	},
	{
		sentinel: service.ErrNickInvalid,
		target:   &statusError{ErrorMessage: "nick must be 1-20 characters", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrNickColon,
		target:   &statusError{ErrorMessage: "nick must not contain ':'", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrNicknameTaken,
		target:   &statusError{ErrorMessage: "nickname already taken", code: http.StatusConflict},
	},
	{
		sentinel: service.ErrEmailAlreadyTaken,
		target:   &statusError{ErrorMessage: "email already registered", code: http.StatusConflict},
	},

	// Chat domain.
	{
		sentinel: service.ErrChatNotFound,
		target:   &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound},
	},
	{
		sentinel: service.ErrUserNotFound,
		target:   &statusError{ErrorMessage: "user not found", code: http.StatusNotFound},
	},
	{
		sentinel: service.ErrWithUserRequired,
		target:   &statusError{ErrorMessage: "withUserId required for private chat", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrChatWithSelf,
		target:   &statusError{ErrorMessage: "cannot chat with yourself", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrGroupNameInvalid,
		target:   &statusError{ErrorMessage: "group name must be 1-60 characters", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrTooManyMembers,
		target:   &statusError{ErrorMessage: "too many members", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrGroupRemoteMemb,
		target:   &statusError{ErrorMessage: "group chat members must be on the same server", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrUserIDRequired,
		target:   &statusError{ErrorMessage: "userId required", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrRemoteMember,
		target:   &statusError{ErrorMessage: "members must be on the same server", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrFileIDRequired,
		target:   &statusError{ErrorMessage: "fileId required", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrFileNotFound,
		target:   &statusError{ErrorMessage: "file not found", code: http.StatusNotFound},
	},

	// Message domain.
	{
		sentinel: service.ErrThreadNotFound,
		target:   errThreadNotFound,
	},
	{
		sentinel: service.ErrMessageNotFound,
		target:   &statusError{ErrorMessage: "message not found", code: http.StatusNotFound},
	},
	{
		sentinel: service.ErrEmptyMessage,
		target:   &statusError{ErrorMessage: "empty message", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrMessageTooLong,
		target:   &statusError{ErrorMessage: "message too long", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrInvalidCoordinates,
		target:   &statusError{ErrorMessage: "invalid coordinates", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrTooManyFiles,
		target:   &statusError{ErrorMessage: msgTooManyFiles, code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrNotYourMessage,
		target:   &statusError{ErrorMessage: "not your message", code: http.StatusForbidden},
	},
	{
		sentinel: store.ErrMessageIDConflict,
		target:   &statusError{ErrorMessage: "message id already used", code: http.StatusConflict},
	},
	{
		sentinel: service.ErrEditingNotAllowed,
		target:   &statusError{ErrorMessage: "editing not allowed", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrEditWindowExpired,
		target:   &statusError{ErrorMessage: "edit window expired", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrDeletingNotAllowed,
		target:   &statusError{ErrorMessage: "deleting not allowed", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrDeleteWindowExpired,
		target:   &statusError{ErrorMessage: "delete window expired", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrDeleteForbidden,
		target:   &statusError{ErrorMessage: "forbidden", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrThreadOnThread,
		target:   &statusError{ErrorMessage: "cannot create thread on a thread message", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrThreadAlreadyExists,
		target:   &statusError{ErrorMessage: "thread already exists", code: http.StatusConflict},
	},
	{
		sentinel: service.ErrReadInputRequired,
		target:   &statusError{ErrorMessage: "messageIds and chatId are required", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrTooManyReadIDs,
		target:   &statusError{ErrorMessage: msgTooManyMessageIDs, code: http.StatusBadRequest},
	},

	// Federation domain.
	{
		sentinel: service.ErrFederatedChatMembers,
		target:   &statusError{ErrorMessage: "federated chat must have exactly 2 members", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrFederatedMembersNotValid,
		target:   &statusError{ErrorMessage: "members must belong to federation endpoints", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrFederatedFromNotRemote,
		target:   &statusError{ErrorMessage: "fromId does not belong to remote server", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrFederatedAuthorNotRemote,
		target:   &statusError{ErrorMessage: "message author does not belong to remote server", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrFederatedIDRequired,
		target:   &statusError{ErrorMessage: "id is required", code: http.StatusBadRequest},
	},

	// Key domain.
	{
		sentinel: service.ErrInvalidPublicKey,
		target:   &statusError{ErrorMessage: "invalid public key", code: http.StatusBadRequest},
	},

	// Call domain.
	{
		sentinel: service.ErrCallNotFound,
		target:   errCallNotFound,
	},
	{
		sentinel: service.ErrNotParticipant,
		target:   &statusError{ErrorMessage: "not a participant of the call", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrNotPrivateChat,
		target:   &statusError{ErrorMessage: "calls are only possible in a private chat", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrCallWithSelf,
		target:   &statusError{ErrorMessage: "cannot call yourself", code: http.StatusBadRequest},
	},
	{
		sentinel: service.ErrRemoteCallee,
		target:   &statusError{ErrorMessage: "calls between servers are not supported", code: http.StatusForbidden},
	},
	{
		sentinel: service.ErrEmptyOffer,
		target:   &statusError{ErrorMessage: "the offer of a call is empty", code: http.StatusBadRequest},
	},
	{
		sentinel: calls.ErrEmptyAnswer,
		target:   &statusError{ErrorMessage: "the answer of a call is empty", code: http.StatusBadRequest},
	},

	// Call registry.
	{
		sentinel: calls.ErrBusyCaller,
		target: &statusError{
			ErrorMessage: "you are already in a call",
			ErrorCode:    "busy-caller",
			code:         http.StatusConflict,
		},
	},
	{
		sentinel: calls.ErrBusyCallee,
		target: &statusError{
			ErrorMessage: "the callee is already in a call",
			ErrorCode:    "busy-callee",
			code:         http.StatusConflict,
		},
	},
	{
		sentinel: calls.ErrBusy,
		target:   &statusError{ErrorMessage: "user is already in a call", code: http.StatusConflict},
	},
	{
		sentinel: calls.ErrNotFound,
		target:   errCallNotFound,
	},
	{
		sentinel: calls.ErrNotRinging,
		target:   &statusError{ErrorMessage: "call is not ringing", code: http.StatusConflict},
	},
	{
		sentinel: calls.ErrEnded,
		target:   &statusError{ErrorMessage: "call is already ended", code: http.StatusConflict},
	},
	{
		sentinel: calls.ErrExpired,
		target:   &statusError{ErrorMessage: "call was not answered in time", code: http.StatusConflict},
	},
}
