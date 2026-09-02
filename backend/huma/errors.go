package huma

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
)

// errorResponse matches the legacy {"error": "<msg>} shape so the frontend
// (which parses errors as `http ${status}: ${body}`) keeps working unchanged.
type errorResponse struct {
	Error string `doc:"Human-readable error message" json:"error"`
}

// statusError implements huma.StatusError using the legacy error shape.
type statusError struct {
	status int
	msg    string
}

func (e *statusError) Error() string {
	return e.msg
}

func (e *statusError) GetStatus() int {
	return e.status
}

func (e *statusError) MarshalJSON() ([]byte, error) {
	return json.Marshal(errorResponse{Error: e.msg})
}

func init() {
	// Override Huma's default RFC 9457 error model with the legacy shape.
	huma.NewError = func(status int, message string, _ ...error) huma.StatusError {
		return &statusError{status: status, msg: message}
	}
}

// MapError maps a service sentinel error to a Huma status error, mirroring the
// legacy handler error mappers (chatError, messageError, federateError,
// writeAuthError). Returns nil for unrecognized errors so the caller can log
// and return a generic 500.
func MapError(err error) huma.StatusError { //nolint:ireturn // huma.StatusError is the required interface
	if err == nil {
		return nil
	}

	// Struct-based errors first (errors.As).
	mnf, _ := errors.AsType[*service.GroupMemberNotFoundError](err)
	if mnf != nil {
		return &statusError{http.StatusNotFound, mnf.Error()}
	}

	// E2E payload validation errors (share the same status/message pattern).
	if isEncryptedPayloadError(err) {
		return &statusError{http.StatusBadRequest, err.Error()}
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

var sentinelErrors = []sentinelErrPair{
	// Auth domain.
	{
		sentinel: service.ErrInvalidEmail,
		target:   &statusError{http.StatusBadRequest, "invalid email"},
	},
	{
		sentinel: service.ErrEmailNotAllowed,
		target:   &statusError{http.StatusForbidden, "email not allowed"},
	},
	{
		sentinel: service.ErrEmailSendFailed,
		target:   &statusError{http.StatusInternalServerError, "failed to send email"},
	},
	{
		sentinel: service.ErrInvalidCode,
		target:   &statusError{http.StatusUnauthorized, "invalid code"},
	},
	{
		sentinel: service.ErrInvalidSetupToken,
		target:   &statusError{http.StatusUnauthorized, "invalid setup token"},
	},
	{
		sentinel: service.ErrNickInvalid,
		target:   &statusError{http.StatusBadRequest, "nick must be 1-20 characters"},
	},
	{
		sentinel: service.ErrNickColon,
		target:   &statusError{http.StatusBadRequest, "nick must not contain ':'"},
	},
	{
		sentinel: service.ErrNicknameTaken,
		target:   &statusError{http.StatusConflict, "nickname already taken"},
	},
	{
		sentinel: service.ErrEmailAlreadyTaken,
		target:   &statusError{http.StatusConflict, "email already registered"},
	},

	// Chat domain.
	{
		sentinel: service.ErrChatNotFound,
		target:   &statusError{http.StatusNotFound, "chat not found"},
	},
	{
		sentinel: service.ErrUserNotFound,
		target:   &statusError{http.StatusNotFound, "user not found"},
	},
	{
		sentinel: service.ErrWithUserRequired,
		target:   &statusError{http.StatusBadRequest, "withUserId required for private chat"},
	},
	{
		sentinel: service.ErrChatWithSelf,
		target:   &statusError{http.StatusBadRequest, "cannot chat with yourself"},
	},
	{
		sentinel: service.ErrGroupNameInvalid,
		target:   &statusError{http.StatusBadRequest, "group name must be 1-60 characters"},
	},
	{
		sentinel: service.ErrTooManyMembers,
		target:   &statusError{http.StatusBadRequest, "too many members"},
	},
	{
		sentinel: service.ErrGroupRemoteMemb,
		target:   &statusError{http.StatusBadRequest, "group chat members must be on the same server"},
	},
	{
		sentinel: service.ErrUserIDRequired,
		target:   &statusError{http.StatusBadRequest, "userId required"},
	},
	{
		sentinel: service.ErrRemoteMember,
		target:   &statusError{http.StatusBadRequest, "members must be on the same server"},
	},
	{
		sentinel: service.ErrFileIDRequired,
		target:   &statusError{http.StatusBadRequest, "fileId required"},
	},
	{
		sentinel: service.ErrFileNotFound,
		target:   &statusError{http.StatusNotFound, "file not found"},
	},

	// Message domain.
	{
		sentinel: service.ErrThreadNotFound,
		target:   &statusError{http.StatusNotFound, "thread not found"},
	},
	{
		sentinel: service.ErrMessageNotFound,
		target:   &statusError{http.StatusNotFound, "message not found"},
	},
	{
		sentinel: service.ErrEmptyMessage,
		target:   &statusError{http.StatusBadRequest, "empty message"},
	},
	{
		sentinel: service.ErrMessageTooLong,
		target:   &statusError{http.StatusBadRequest, "message too long"},
	},
	{
		sentinel: service.ErrInvalidCoordinates,
		target:   &statusError{http.StatusBadRequest, "invalid coordinates"},
	},
	{
		sentinel: service.ErrTooManyFiles,
		target:   &statusError{http.StatusBadRequest, "too many files"},
	},
	{
		sentinel: service.ErrNotYourMessage,
		target:   &statusError{http.StatusForbidden, "not your message"},
	},
	{
		sentinel: service.ErrEditingNotAllowed,
		target:   &statusError{http.StatusForbidden, "editing not allowed"},
	},
	{
		sentinel: service.ErrEditWindowExpired,
		target:   &statusError{http.StatusForbidden, "edit window expired"},
	},
	{
		sentinel: service.ErrDeletingNotAllowed,
		target:   &statusError{http.StatusForbidden, "deleting not allowed"},
	},
	{
		sentinel: service.ErrDeleteWindowExpired,
		target:   &statusError{http.StatusForbidden, "delete window expired"},
	},
	{
		sentinel: service.ErrDeleteForbidden,
		target:   &statusError{http.StatusForbidden, "forbidden"},
	},
	{
		sentinel: service.ErrThreadOnThread,
		target:   &statusError{http.StatusBadRequest, "cannot create thread on a thread message"},
	},
	{
		sentinel: service.ErrThreadAlreadyExists,
		target:   &statusError{http.StatusConflict, "thread already exists"},
	},
	{
		sentinel: service.ErrReadInputRequired,
		target:   &statusError{http.StatusBadRequest, "messageIds and chatId are required"},
	},
	{
		sentinel: service.ErrTooManyReadIDs,
		target:   &statusError{http.StatusBadRequest, "too many message IDs"},
	},

	// Federation domain.
	{
		sentinel: service.ErrFederatedChatMembers,
		target:   &statusError{http.StatusBadRequest, "federated chat must have exactly 2 members"},
	},
	{
		sentinel: service.ErrFederatedMembersNotValid,
		target:   &statusError{http.StatusBadRequest, "members must belong to federation endpoints"},
	},
	{
		sentinel: service.ErrFederatedFromNotRemote,
		target:   &statusError{http.StatusForbidden, "fromId does not belong to remote server"},
	},
	{
		sentinel: service.ErrFederatedAuthorNotRemote,
		target:   &statusError{http.StatusForbidden, "message author does not belong to remote server"},
	},
	{
		sentinel: service.ErrFederatedIDRequired,
		target:   &statusError{http.StatusBadRequest, "id is required"},
	},

	// Key domain.
	{
		sentinel: service.ErrInvalidPublicKey,
		target:   &statusError{http.StatusBadRequest, "invalid public key"},
	},
}
