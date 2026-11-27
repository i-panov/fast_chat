package transport

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/ratelimit"
	"fast_chat/service"
)

// syncDefaultPageLimit bounds one delta page per list; syncMaxPageLimit
// caps a client-requested page so one request cannot ask for everything.
const (
	syncDefaultPageLimit = 500
	syncMaxPageLimit     = 1000

	// syncRequestsPerMinute bounds the catch-up endpoint per account: every
	// call runs five queries and sends the whole chat list, so a client that
	// loops on since=epoch must not keep the small SQLite pool busy for
	// everyone else.
	syncRequestsPerMinute = 60
	// syncLimiterEntries bounds the per-account buckets held in memory.
	syncLimiterEntries = 10000
)

// syncPageLimit clamps the client limit into [1, syncMaxPageLimit],
// defaulting to syncDefaultPageLimit when unset.
func syncPageLimit(limit int) int {
	if limit <= 0 {
		return syncDefaultPageLimit
	}
	if limit > syncMaxPageLimit {
		return syncMaxPageLimit
	}
	return limit
}

// RegisterSync adds the client catch-up operation.
//
// The since cursor is validated here (RFC3339, 400 otherwise); the size of the
// delta is a store contract: the delta is paginated with nextSince (see
// store.DeltaPage), and the per-request page is clamped to syncMaxPageLimit.
func RegisterSync(api huma.API, svc *service.Service) {
	// Per-account throttle: the endpoint is authenticated, so the bucket key
	// is the user id, not the address.
	syncLimiter := ratelimit.New(syncRequestsPerMinute, time.Minute, syncLimiterEntries)

	huma.Register(api, huma.Operation{
		OperationID: "sync",
		Method:      http.MethodGet,
		Path:        "/api/sync",
		Summary:     "Fetch the change delta since a timestamp",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *syncInput) (*syncOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if !syncLimiter.Allow(user.ID) {
			return nil, &statusError{ErrorMessage: "too many sync requests", code: http.StatusTooManyRequests}
		}

		since, err := service.ParseSince(input.Since)
		if err != nil {
			return nil, &statusError{ErrorMessage: "invalid since timestamp", code: http.StatusBadRequest}
		}

		body, err := svc.Sync(ctx, user.ID, since, input.SinceID, syncPageLimit(input.Limit))
		if err != nil {
			return nil, errInternal
		}

		var out syncOutput
		out.Body = body

		return &out, nil
	})
}

type syncInput struct {
	Since   string `query:"since"`
	SinceID string `query:"sinceId"`
	Limit   int    `query:"limit"`
}

type syncOutput struct {
	Body service.SyncResponse
}
