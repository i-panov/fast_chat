package transport

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
)

func TestMapError_KnownSentinels(t *testing.T) {
	cases := []struct {
		err      error
		wantCode int
		wantMsg  string
	}{
		{service.ErrInvalidEmail, http.StatusBadRequest, "invalid email"},
		{service.ErrEmailNotAllowed, http.StatusForbidden, "email not allowed"},
		{service.ErrEmailSendFailed, http.StatusInternalServerError, "failed to send email"},
		{service.ErrInvalidCode, http.StatusUnauthorized, "invalid code"},
		{service.ErrInvalidSetupToken, http.StatusUnauthorized, "invalid setup token"},
		{service.ErrNickInvalid, http.StatusBadRequest, "nick must be 1-20 characters"},
		{service.ErrNickColon, http.StatusBadRequest, "nick must not contain ':'"},
		{service.ErrNicknameTaken, http.StatusConflict, "nickname already taken"},
		{service.ErrEmailAlreadyTaken, http.StatusConflict, "email already registered"},
		{service.ErrChatNotFound, http.StatusNotFound, "chat not found"},
		{service.ErrUserNotFound, http.StatusNotFound, "user not found"},
		{service.ErrWithUserRequired, http.StatusBadRequest, "withUserId required for private chat"},
		{service.ErrChatWithSelf, http.StatusBadRequest, "cannot chat with yourself"},
		{service.ErrGroupNameInvalid, http.StatusBadRequest, "group name must be 1-60 characters"},
		{service.ErrTooManyMembers, http.StatusBadRequest, "too many members"},
		{service.ErrGroupRemoteMemb, http.StatusBadRequest, "group chat members must be on the same server"},
		{service.ErrUserIDRequired, http.StatusBadRequest, "userId required"},
		{service.ErrRemoteMember, http.StatusBadRequest, "members must be on the same server"},
		{service.ErrFileIDRequired, http.StatusBadRequest, "fileId required"},
		{service.ErrFileNotFound, http.StatusNotFound, "file not found"},
		{service.ErrThreadNotFound, http.StatusNotFound, "thread not found"},
		{service.ErrMessageNotFound, http.StatusNotFound, "message not found"},
		{service.ErrEmptyMessage, http.StatusBadRequest, "empty message"},
		{service.ErrMessageTooLong, http.StatusBadRequest, "message too long"},
		{service.ErrInvalidCoordinates, http.StatusBadRequest, "invalid coordinates"},
		{service.ErrTooManyFiles, http.StatusBadRequest, "too many files"},
		{service.ErrNotYourMessage, http.StatusForbidden, "not your message"},
		{service.ErrEditingNotAllowed, http.StatusForbidden, "editing not allowed"},
		{service.ErrEditWindowExpired, http.StatusForbidden, "edit window expired"},
		{service.ErrDeletingNotAllowed, http.StatusForbidden, "deleting not allowed"},
		{service.ErrDeleteWindowExpired, http.StatusForbidden, "delete window expired"},
		{service.ErrDeleteForbidden, http.StatusForbidden, "forbidden"},
		{service.ErrThreadOnThread, http.StatusBadRequest, "cannot create thread on a thread message"},
		{service.ErrThreadAlreadyExists, http.StatusConflict, "thread already exists"},
		{service.ErrReadInputRequired, http.StatusBadRequest, "messageIds and chatId are required"},
		{service.ErrTooManyReadIDs, http.StatusBadRequest, "too many message IDs"},
		{service.ErrMissingEncryptedPayload, http.StatusBadRequest, "missing encrypted payload"},
		{service.ErrFederatedMembersNotValid, http.StatusBadRequest, "members must belong to federation endpoints"},
		{service.ErrFederatedFromNotRemote, http.StatusForbidden, "fromId does not belong to remote server"},
		{service.ErrFederatedAuthorNotRemote, http.StatusForbidden, "message author does not belong to remote server"},
		{service.ErrFederatedIDRequired, http.StatusBadRequest, "id is required"},
		{service.ErrInvalidPublicKey, http.StatusBadRequest, "invalid public key"},
	}

	for _, c := range cases {
		got := MapError(c.err)
		if got == nil {
			t.Errorf("MapError(%v) = nil, want status %d", c.err, c.wantCode)
			continue
		}

		if got.GetStatus() != c.wantCode {
			t.Errorf("MapError(%v) status = %d, want %d", c.err, got.GetStatus(), c.wantCode)
		}

		if got.Error() != c.wantMsg {
			t.Errorf("MapError(%v) msg = %q, want %q", c.err, got.Error(), c.wantMsg)
		}
	}
}

func TestMapError_GroupMemberNotFound(t *testing.T) {
	err := &service.GroupMemberNotFoundError{ID: "ghost:server"}
	got := MapError(err)
	if got == nil {
		t.Fatal("MapError(GroupMemberNotFoundError) = nil")
	}

	if got.GetStatus() != http.StatusNotFound {
		t.Errorf("status = %d, want 404", got.GetStatus())
	}

	if got.Error() != "user not found: ghost:server" {
		t.Errorf("msg = %q, want 'user not found: ghost:server'", got.Error())
	}
}

var errTestUnknown = errors.New("some random error")

func TestMapError_UnknownReturnsNil(t *testing.T) {
	if got := MapError(errTestUnknown); got != nil {
		t.Errorf("MapError(unknown) = %v, want nil", got)
	}
}

func TestMapError_WrappedSentinel(t *testing.T) {
	// Wrapped sentinels (via fmt.Errorf %w) should still resolve correctly
	// because MapError uses errors.Is, not identity comparison.
	wrapped := fmt.Errorf("context: %w", service.ErrChatNotFound)
	got := MapError(wrapped)
	if got == nil {
		t.Fatal("MapError(wrapped ErrChatNotFound) = nil")
	}

	if got.GetStatus() != http.StatusNotFound {
		t.Errorf("status = %d, want 404", got.GetStatus())
	}
}

func TestNewErrorOverride(t *testing.T) {
	// huma.NewError should produce the pre-migration error shape after init().
	err := huma.NewError(404, "chat not found")
	if err.GetStatus() != 404 {
		t.Errorf("status = %d, want 404", err.GetStatus())
	}

	if err.Error() != "chat not found" {
		t.Errorf("msg = %q, want 'chat not found'", err.Error())
	}
}
