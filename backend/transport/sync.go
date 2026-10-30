package transport

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
)

// syncDefaultPageLimit bounds one delta page per list; syncMaxPageLimit
// caps a client-requested page so one request cannot ask for everything.
const (
	syncDefaultPageLimit = 500
	syncMaxPageLimit     = 1000
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
// The since cursor is validated here (RFC3339, 400 otherwise), but the size
// of the delta itself is a store contract: since="" replays from the epoch,
// so the store must paginate/bound the delta (limit+cursor or truncated with
// nextSince) instead of loading the whole history into one response. Until
// that contract exists the transport cannot cap the delta without breaking
// long-offline clients.
func RegisterSync(api huma.API, svc *service.Service) {
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
