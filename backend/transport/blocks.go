package transport

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/store"
)

func registerUserBlocks(api huma.API, st *store.Store) {
	huma.Register(api, huma.Operation{
		OperationID: "list-blocked-users",
		Method:      http.MethodGet,
		Path:        "/api/blocks",
		Summary:     "List users blocked by the caller",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*blocksOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		ids, err := st.BlockedIDs(ctx, user.ID)
		if err != nil {
			return nil, errInternal
		}
		users := make([]model.PublicUser, 0, len(ids))
		for _, id := range ids {
			if blocked, found := st.GetUserByID(ctx, id); found {
				users = append(users, blocked.Public())
			}
		}
		var out blocksOutput
		out.Body.Users = users
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "block-user",
		Method:      http.MethodPost,
		Path:        "/api/blocks/{userId}",
		Summary:     "Block a user",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *blockPathInput) (*blocksOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if input.UserID == user.ID {
			return nil, &statusError{ErrorMessage: "cannot block yourself", code: http.StatusBadRequest}
		}
		if err := st.BlockUser(ctx, user.ID, input.UserID); err != nil {
			return nil, errInternal
		}
		return listBlocks(ctx, st, user.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "unblock-user",
		Method:      http.MethodDelete,
		Path:        "/api/blocks/{userId}",
		Summary:     "Unblock a user",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *blockPathInput) (*blocksOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		if err := st.UnblockUser(ctx, user.ID, input.UserID); err != nil {
			return nil, errInternal
		}
		return listBlocks(ctx, st, user.ID)
	})
}

func listBlocks(ctx context.Context, st *store.Store, userID string) (*blocksOutput, error) {
	ids, err := st.BlockedIDs(ctx, userID)
	if err != nil {
		return nil, errInternal
	}
	users := make([]model.PublicUser, 0, len(ids))
	for _, id := range ids {
		if blocked, found := st.GetUserByID(ctx, id); found {
			users = append(users, blocked.Public())
		}
	}
	var out blocksOutput
	out.Body.Users = users
	return &out, nil
}

func filterBlockedUsers(ctx context.Context, st *store.Store, viewerID string, users []model.PublicUser) []model.PublicUser {
	if users == nil {
		return []model.PublicUser{}
	}
	blocked, err := st.BlockedIDs(ctx, viewerID)
	if err != nil {
		// Fail closed: showing blocked users because the database is busy is
		// worse than hiding the whole result for one request.
		return []model.PublicUser{}
	}
	blockedBy, err := st.BlockedByIDs(ctx, viewerID)
	if err != nil {
		return []model.PublicUser{}
	}
	hidden := make(map[string]struct{}, len(blocked)+len(blockedBy))
	for _, id := range blocked {
		hidden[id] = struct{}{}
	}
	for _, id := range blockedBy {
		hidden[id] = struct{}{}
	}
	if len(hidden) == 0 {
		return users
	}
	out := users[:0]
	for _, user := range users {
		if _, found := hidden[user.ID]; !found {
			out = append(out, user)
		}
	}
	return out
}

type blockPathInput struct {
	UserID string `path:"userId"`
}

type blocksOutput struct {
	Body struct {
		Users []model.PublicUser `json:"users"`
	}
}
