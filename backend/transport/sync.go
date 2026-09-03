package transport

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/service"
)

// RegisterSync adds the client catch-up operation.
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

		var out syncOutput
		out.Body = svc.Sync(ctx, user.ID, since)

		return &out, nil
	})
}

type syncInput struct {
	Since string `query:"since"`
}

type syncOutput struct {
	Body service.SyncResponse
}
