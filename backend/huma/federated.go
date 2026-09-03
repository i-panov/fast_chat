package huma

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

// RegisterFederated adds the server-to-server federation operations. They are
// guarded by the federation signature security scheme instead of a Bearer
// token.
func RegisterFederated(api huma.API, st *store.Store, svc *service.Service, fm *federation.Manager, cfg *config.Config) {
	registerFederatedUsers(api, st, svc, cfg)
	registerFederatedChats(api, st, svc, fm, cfg)
	registerFederatedSync(api, svc)
}

// fedSecurity is the security declaration for federation operations.
var fedSecurity = []map[string][]string{{federationScheme: {}}}

// registerFederatedUsers registers a subset of the operations.
func registerFederatedUsers(api huma.API, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-search-users",
		Method:      http.MethodGet,
		Path:        "/api/federated/users/search",
		Summary:     "Search local users on behalf of a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedSearchInput) (*federatedUsersOutput, error) {
		var out federatedUsersOutput
		out.Body.Users = svc.SearchFederatedUsers(ctx, input.Q)

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-user-public-key",
		Method:      http.MethodGet,
		Path:        "/api/federated/users/{userId}/public-key",
		Summary:     "Serve a local user's public key to a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedPublicKeyInput) (*publicKeyOutput, error) {
		if service.RemoteServerFromID(input.UserID) != cfg.Server.Domain {
			return nil, &statusError{ErrorMessage: "user does not belong to this server", code: http.StatusBadRequest}
		}

		key, exists := st.GetUserPublicKey(ctx, input.UserID)
		if !exists {
			return nil, &statusError{ErrorMessage: "user has no public key", code: http.StatusNotFound}
		}

		return publicKeyResponseBody(key), nil
	})
}

// registerFederatedChats registers a subset of the operations.
func registerFederatedChats(api huma.API, st *store.Store, svc *service.Service, fm *federation.Manager, cfg *config.Config) {
	registerFederatedChatMessages(api, st, svc, fm, cfg)
	registerFederatedChatMutations(api, st, svc, cfg)
}

// registerFederatedChatMessages registers chat create/send operations.
func registerFederatedChatMessages(api huma.API, st *store.Store, svc *service.Service, fm *federation.Manager, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-create-chat",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats",
		Summary:     "Create a federated chat on behalf of a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCreateChatInput) (*federatedCreateChatOutput, error) {
		server := federatedServerFromContext(ctx)

		if len(input.Body.Members) != 2 {
			return nil, &statusError{ErrorMessage: "federated chat must have exactly 2 members", code: http.StatusBadRequest}
		}

		if server == "" || input.Body.RemoteServer != server {
			return nil, &statusError{ErrorMessage: "remote server mismatch", code: http.StatusForbidden}
		}

		view, alreadyExists, err := svc.CreateFederatedChat(ctx, input.Body.ChatID, input.Body.Members, server, fm.ServerDomain())
		if err != nil {
			return nil, federatedOrInternalError(err)
		}

		if alreadyExists {
			var out federatedCreateChatOutput
			out.Status = http.StatusOK
			out.Body.Status = "already exists"

			return &out, nil
		}

		var out federatedCreateChatOutput
		out.Status = http.StatusCreated
		out.Body.Chat = &view

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-send-message",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/messages",
		Summary:     "Receive a message from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedSendMessageInput) (*federatedMessageOutput, error) {
		chat, err := federatedChatForSource(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		maxLen := service.MaxMessageLen
		if input.Body.Encrypted {
			maxLen = service.EncryptedMaxLen
		}

		msg, err := svc.SendFederatedMessage(ctx, chat, &service.FederatedInboundMessage{
			ID:               input.Body.ID,
			FromID:           input.Body.FromID,
			FromNick:         input.Body.FromNick,
			Text:             input.Body.Text,
			ReplyToID:        input.Body.ReplyToID,
			Location:         input.Body.Location,
			Encrypted:        input.Body.Encrypted,
			EncryptedPayload: input.Body.EncryptedPayload,
		}, maxLen)
		if err != nil {
			return nil, federatedOrInternalError(err)
		}

		var out federatedMessageOutput
		out.Status = http.StatusCreated
		out.Body.Message = msg

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-edit-message",
		Method:      http.MethodPatch,
		Path:        "/api/federated/chats/{id}/messages/{messageId}",
		Summary:     "Receive a message edit from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedEditMessageInput) (*federatedMessageOutput, error) {
		return federatedEdit(ctx, svc, st, cfg, input.ID, "", input.MessageID, &input.Body.DecodedEditRequest)
	})
}

// registerFederatedChatMutations registers edit/delete/typing operations.
func registerFederatedChatMutations(api huma.API, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-edit-thread-message",
		Method:      http.MethodPatch,
		Path:        "/api/federated/chats/{id}/threads/{threadId}/messages/{messageId}",
		Summary:     "Receive a thread message edit from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedEditThreadMessageInput) (*federatedMessageOutput, error) {
		return federatedEdit(ctx, svc, st, cfg, input.ID, input.ThreadID, input.MessageID, &input.Body.DecodedEditRequest)
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-delete-message",
		Method:      http.MethodDelete,
		Path:        "/api/federated/chats/{id}/messages/{messageId}",
		Summary:     "Receive a message deletion from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedDeleteMessageInput) (*statusOutput, error) {
		chat, err := federatedChatForSource(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		if err := svc.DeleteFederatedMessage(ctx, chat, input.MessageID, cfg.MessageDeleteTTL); err != nil {
			return nil, federatedOrInternalError(err)
		}

		return deletedStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-typing",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/typing",
		Summary:     "Receive a typing indicator from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedTypingInput) (*statusOutput, error) {
		chat, err := federatedChatForSource(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		svc.HandleFederatedTyping(ctx, chat, input.Body.UserID, input.Body.Nick, input.Body.Active)

		return okStatus(), nil
	})
}

// registerFederatedSync registers a subset of the operations.
func registerFederatedSync(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-sync",
		Method:      http.MethodGet,
		Path:        "/api/federated/sync",
		Summary:     "Serve a catch-up delta to a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedSyncInput) (*federatedSyncOutput, error) {
		since, err := service.ParseSince(input.Since)
		if err != nil {
			return nil, &statusError{ErrorMessage: "invalid since timestamp", code: http.StatusBadRequest}
		}

		serverDomain := federatedServerFromContext(ctx)
		if serverDomain == "" {
			return nil, &statusError{ErrorMessage: "missing federation server", code: http.StatusForbidden}
		}

		var out federatedSyncOutput
		out.Body = svc.SyncFederated(ctx, serverDomain, since)

		return &out, nil
	})
}

// federatedChatForSource loads the chat and verifies the request originates
// from the server that owns it (legacy authorizeFederatedSource).
func federatedChatForSource(ctx context.Context, st *store.Store, chatID string) (*model.Chat, error) {
	chat, ok := st.GetChat(ctx, chatID)
	if !ok {
		return nil, &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound}
	}

	remoteServer := federatedServerFromContext(ctx)
	if remoteServer == "" || chat.RemoteServer != remoteServer {
		return nil, &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
	}

	return chat, nil
}

// federatedEdit performs the shared federated edit flow for chat and thread
// messages.
func federatedEdit(
	ctx context.Context,
	svc *service.Service,
	st *store.Store,
	cfg *config.Config,
	chatID, threadID, messageID string,
	req *service.DecodedEditRequest,
) (*federatedMessageOutput, error) {

	chat, err := federatedChatForSource(ctx, st, chatID)
	if err != nil {
		return nil, err
	}

	lookupID := chatID
	if threadID != "" {
		lookupID = threadID
	}

	updated, err := svc.EditFederatedMessage(ctx, chat, lookupID, messageID, threadID, req, cfg.MessageEditTTL)
	if err != nil {
		return nil, federatedOrInternalError(err)
	}

	var out federatedMessageOutput
	out.Status = http.StatusOK
	out.Body.Message = updated

	return &out, nil
}

// federatedOrInternalError maps federation-domain errors, logging and
// converting unmapped ones to a 500 (legacy parity).
func federatedOrInternalError(err error) error {
	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("federated operation failed", "err", err)

	return errInternal
}

// --- Input/output types ---

type federatedSearchInput struct {
	Q string `query:"q"`
}

type federatedUsersOutput struct {
	Body struct {
		Users []model.PublicUser `json:"users"`
	}
}

type federatedPublicKeyInput struct {
	UserID string `path:"userId"`
}

type federatedCreateChatInput struct {
	Body struct {
		ChatID       string   `json:"chatId,omitempty"`
		Members      []string `json:"members,omitempty"`
		RemoteServer string   `json:"remoteServer,omitempty"`
	}
}

type federatedCreateChatOutput struct {
	Status int
	Body   struct {
		Status string            `json:"status,omitempty"`
		Chat   *service.ChatView `json:"chat,omitempty"`
	}
}

func (o *federatedCreateChatOutput) GetStatus() int {
	return o.Status
}

type federatedMessageBody struct {
	ID               string          `json:"id,omitempty"`
	FromID           string          `json:"fromId,omitempty"`
	FromNick         string          `json:"fromNick,omitempty"`
	Text             string          `json:"text,omitempty"`
	ReplyToID        string          `json:"replyToId,omitempty"`
	Location         *model.Location `json:"location,omitempty"`
	Encrypted        bool            `json:"encrypted,omitempty"`
	EncryptedPayload string          `json:"encryptedPayload,omitempty"`
}

type federatedSendMessageInput struct {
	ID   string `path:"id"`
	Body federatedMessageBody
}

type federatedMessageOutput struct {
	Status int
	Body   struct {
		Message *model.Message `json:"message"`
	}
}

func (o *federatedMessageOutput) GetStatus() int {
	return o.Status
}

type federatedEditMessageInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
	Body      struct {
		service.DecodedEditRequest
	}
}

type federatedEditThreadMessageInput struct {
	ID        string `path:"id"`
	ThreadID  string `path:"threadId"`
	MessageID string `path:"messageId"`
	Body      struct {
		service.DecodedEditRequest
	}
}

type federatedDeleteMessageInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
}

type federatedTypingInput struct {
	ID   string `path:"id"`
	Body struct {
		UserID string `json:"userId,omitempty"`
		Nick   string `json:"nick,omitempty"`
		Active bool   `json:"active,omitempty"`
	}
}

type federatedSyncInput struct {
	Since string `query:"since"`
}

type federatedSyncOutput struct {
	Body service.SyncFederatedResponse
}
