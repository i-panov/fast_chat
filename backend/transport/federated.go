package transport

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/filestage"
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
	registerFederatedCalls(api, st, svc)
	registerFederatedSync(api, svc)
	registerFederatedFiles(api, st, svc, cfg)
}

const msgUserNotRemote = "user does not belong to remote server"

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
		if service.RemoteServerFromIDFor(input.UserID, cfg.Federation.AllowPrivateAddresses) != cfg.Server.Domain {
			return nil, &statusError{ErrorMessage: "user does not belong to this server", code: http.StatusBadRequest}
		}

		key, identityKey, version, exists := st.GetUserMasterKey(ctx, input.UserID)
		if !exists {
			return nil, &statusError{ErrorMessage: "user has no public key", code: http.StatusNotFound}
		}

		out := publicKeyResponseBody(key, identityKey, version)
		if bot, ok := st.GetBot(ctx, input.UserID); ok {
			out.Body.EncryptionMode = bot.EncryptionMode
		}
		return out, nil
	})
}

// registerFederatedChats registers a subset of the operations.
func registerFederatedChats(api huma.API, st *store.Store, svc *service.Service, fm *federation.Manager, cfg *config.Config) {
	registerFederatedChatMessages(api, st, svc, fm, cfg)
	registerFederatedThreadOps(api, st, svc)
	registerFederatedGroupMemberOps(api, st, svc)
	registerFederatedChatMutations(api, st, svc, cfg)
}

// registerFederatedChatMessages registers chat create/send operations.
//
//nolint:funlen // one function registers the closely coupled chat operations.
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
			return nil, &statusError{ErrorMessage: msgRemoteServerMismatch, code: http.StatusForbidden}
		}

		view, alreadyExists, err := svc.CreateFederatedChat(ctx, input.Body.ChatID, input.Body.Members, server, fm.ServerDomain(), input.Body.BotID)
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
		OperationID: "federated-create-group",
		Method:      http.MethodPost,
		Path:        "/api/federated/groups",
		Summary:     "Create a federated group replica on behalf of its owner",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCreateGroupInput) (*federatedCreateGroupOutput, error) {
		server := federatedServerFromContext(ctx)
		if server == "" || input.Body.ChatID == "" || input.Body.OwnerID == "" {
			return nil, &statusError{ErrorMessage: "invalid federated group", code: http.StatusBadRequest}
		}
		view, alreadyExists, err := svc.CreateFederatedGroup(
			ctx, input.Body.ChatID, input.Body.Name, input.Body.OwnerID,
			input.Body.Members, server, fm.ServerDomain(),
		)
		if err != nil {
			return nil, federatedOrInternalError(err)
		}
		var out federatedCreateGroupOutput
		if alreadyExists {
			out.Status = http.StatusOK
			out.Body.Status = "already exists"
			return &out, nil
		}
		out.Status = http.StatusCreated
		out.Body.Chat = &view
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-rename-group",
		Method:      http.MethodPatch,
		Path:        "/api/federated/groups/{id}",
		Summary:     "Apply an owner rename to a group replica",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedRenameGroupInput) (*federatedCreateGroupOutput, error) {
		chat, err := federatedChatForMutation(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}
		if chat.Type != chatTypeGroup {
			return nil, &statusError{ErrorMessage: msgNotGroup, code: http.StatusBadRequest}
		}
		view, err := svc.RenameFederatedGroup(ctx, input.ID, input.Body.Name)
		if err != nil {
			return nil, federatedOrInternalError(err)
		}
		var out federatedCreateGroupOutput
		out.Status = http.StatusOK
		out.Body.Chat = &view
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-delete-group",
		Method:      http.MethodDelete,
		Path:        "/api/federated/groups/{id}",
		Summary:     "Delete a group replica",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedGroupIDInput) (*statusOutput, error) {
		chat, err := federatedChatForMutation(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}
		if chat.Type != chatTypeGroup {
			return nil, &statusError{ErrorMessage: msgNotGroup, code: http.StatusBadRequest}
		}
		if err := svc.DeleteFederatedGroup(ctx, chat); err != nil {
			return nil, federatedOrInternalError(err)
		}
		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-remove-group-member",
		Method:      http.MethodDelete,
		Path:        "/api/federated/groups/{id}/members/{userId}",
		Summary:     "Remove a member from a federated group replica",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedGroupMemberInput) (*statusOutput, error) {
		if err := federatedGroupForMemberChange(ctx, st, input.ID, input.UserID); err != nil {
			return nil, err
		}
		if _, err := svc.RemoveChatMember(ctx, input.ID, input.UserID, ""); err != nil {
			return nil, federatedOrInternalError(err)
		}
		return okStatus(), nil
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
			Peer:             federatedServerFromContext(ctx),
			ID:               input.Body.ID,
			FromID:           input.Body.FromID,
			FromNick:         input.Body.FromNick,
			Text:             input.Body.Text,
			ReplyToID:        input.Body.ReplyToID,
			Location:         input.Body.Location,
			Encrypted:        input.Body.Encrypted,
			EncryptedPayload: input.Body.EncryptedPayload,
			Files:            input.Body.Files,
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

// registerFederatedThreadOps registers thread creation and live thread message
// delivery. Separated from registerFederatedChatMessages to keep both
// registration functions within the cyclomatic budget.
func registerFederatedThreadOps(api huma.API, st *store.Store, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-create-thread",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/threads",
		Summary:     "Create a thread replica on behalf of a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedCreateThreadInput) (*statusOutput, error) {
		chat, err := federatedChatForPeerAction(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		_, err = svc.ApplyFederatedThread(ctx, chat, &service.FederatedThread{
			Peer:              federatedServerFromContext(ctx),
			ID:                input.Body.ID,
			ParentMessageID:   input.Body.ParentMessageID,
			ParentMessageText: input.Body.ParentMessageText,
			ParentMessageFrom: input.Body.ParentMessageFrom,
			CreatedAt:         input.Body.CreatedAt,
		})
		if err != nil {
			return nil, federatedOrInternalError(err)
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-send-thread-message",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/threads/{threadId}/messages",
		Summary:     "Receive a thread message from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedSendThreadMessageInput) (*federatedMessageOutput, error) {
		chat, err := federatedChatForSource(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		maxLen := service.MaxMessageLen
		if input.Body.Encrypted {
			maxLen = service.EncryptedMaxLen
		}

		msg, err := svc.SendFederatedMessage(ctx, chat, &service.FederatedInboundMessage{
			Peer:             federatedServerFromContext(ctx),
			ID:               input.Body.ID,
			FromID:           input.Body.FromID,
			FromNick:         input.Body.FromNick,
			Text:             input.Body.Text,
			ReplyToID:        input.Body.ReplyToID,
			ThreadID:         input.ThreadID,
			ThreadParentID:   input.Body.ThreadParentID,
			Location:         input.Body.Location,
			Encrypted:        input.Body.Encrypted,
			EncryptedPayload: input.Body.EncryptedPayload,
			Files:            input.Body.Files,
		}, maxLen)
		if err != nil {
			return nil, federatedOrInternalError(err)
		}

		var out federatedMessageOutput
		out.Status = http.StatusCreated
		out.Body.Message = msg

		return &out, nil
	})
}

// registerFederatedGroupMemberOps registers the add-member relay that a
// replica sends to its owner when it invites a local user.
func registerFederatedGroupMemberOps(api huma.API, st *store.Store, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-add-group-member",
		Method:      http.MethodPost,
		Path:        "/api/federated/groups/{id}/members",
		Summary:     "Add a member reported by a participant server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedAddGroupMemberInput) (*statusOutput, error) {
		if err := federatedGroupForMemberChange(ctx, st, input.ID, input.Body.UserID); err != nil {
			return nil, err
		}
		if _, err := svc.AddChatMember(ctx, input.ID, input.Body.UserID); err != nil {
			return nil, federatedOrInternalError(err)
		}
		return okStatus(), nil
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
		chat, err := federatedChatForPeerAction(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		if err := svc.DeleteFederatedMessage(ctx, chat, input.MessageID, cfg.MessageDeleteTTL); err != nil {
			return nil, federatedOrInternalError(err)
		}

		return deletedStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-reaction",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/messages/{messageId}/reactions",
		Summary:     "Receive a reaction change from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedReactionInput) (*statusOutput, error) {
		chat, err := federatedChatForPeerAction(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		body := input.Body
		if body.UserID == "" || body.Emoji == "" {
			return nil, &statusError{ErrorMessage: "userId and emoji are required", code: http.StatusBadRequest}
		}
		// The acting user must be a member. On a locally owned chat the peer
		// may only speak for its own users; a replica accepts a relayed
		// reaction from any member because its owner is the relay.
		peer := federatedServerFromContext(ctx)
		if !slices.Contains(chat.Members, body.UserID) {
			return nil, &statusError{ErrorMessage: "user is not a chat member", code: http.StatusForbidden}
		}
		if original, ok := st.GetChat(ctx, input.ID); ok &&
			original.RemoteServer == "" &&
			!service.UserIDBelongsToServer(body.UserID, peer) {

			return nil, &statusError{ErrorMessage: msgUserNotRemote, code: http.StatusForbidden}
		}

		at := body.At
		if at.IsZero() {
			at = time.Now().UTC()
		}

		if _, err := svc.ApplyFederatedReaction(ctx, chat, input.MessageID, body.UserID, body.Emoji, body.Add, at); err != nil {
			return nil, federatedOrInternalError(err)
		}

		// On the owner server the change must reach the other member
		// servers too. A replica does not relay: its owner already does.
		if original, ok := st.GetChat(ctx, input.ID); ok {
			svc.RelayReaction(ctx, original, input.MessageID, body.UserID, body.Emoji, body.Add, at, peer)
		}

		return okStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "federated-typing",
		Method:      http.MethodPost,
		Path:        "/api/federated/chats/{id}/typing",
		Summary:     "Receive a typing indicator from a remote server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedTypingInput) (*statusOutput, error) {
		chat, err := federatedChatForPeerAction(ctx, st, input.ID)
		if err != nil {
			return nil, err
		}

		// On a locally owned chat the peer may only speak for its own users.
		// A replica accepts a typing relayed by its owner for any member.
		if input.Body.UserID == "" || !slices.Contains(chat.Members, input.Body.UserID) {
			return nil, &statusError{ErrorMessage: "user is not a chat member", code: http.StatusForbidden}
		}
		if original, ok := st.GetChat(ctx, input.ID); ok &&
			original.RemoteServer == "" &&
			!service.UserIDBelongsToServer(input.Body.UserID, federatedServerFromContext(ctx)) {

			return nil, &statusError{ErrorMessage: msgUserNotRemote, code: http.StatusForbidden}
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

		limit := syncPageLimit(input.Limit)

		body, err := svc.SyncFederated(ctx, serverDomain, since, input.SinceID, limit)
		if err != nil {
			return nil, errInternal
		}

		var out federatedSyncOutput
		out.Body = body

		return &out, nil
	})
}

// federatedChatForMutation requires the authenticated peer to own the chat.
// Group renames/deletes/member removals must never be accepted from a mere
// member server.
func federatedChatForMutation(ctx context.Context, st *store.Store, chatID string) (*model.Chat, error) {
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

// federatedGroupForMemberChange authorises a membership change reported by a
// participant server. The owner is authoritative for a replica; the owner
// itself accepts changes only for users that belong to the authenticated
// peer. Without the second rule a member server could remove third-party
// users from the group.
func federatedGroupForMemberChange(ctx context.Context, st *store.Store, chatID, targetUserID string) error {
	chat, ok := st.GetChat(ctx, chatID)
	if !ok {
		return &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound}
	}
	peer := federatedServerFromContext(ctx)
	if peer == "" {
		return &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
	}
	if chat.Type != chatTypeGroup {
		return &statusError{ErrorMessage: msgNotGroup, code: http.StatusBadRequest}
	}

	switch chat.RemoteServer {
	case peer:
		// The owner is authoritative for its replica.
		return nil
	case "":
		if !service.UserIDBelongsToServer(targetUserID, peer) {
			return &statusError{ErrorMessage: msgUserNotRemote, code: http.StatusForbidden}
		}
		return nil
	default:
		return &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
	}
}

// federatedChatForSource loads the chat and verifies the request originates
// from the server that owns it (pre-migration authorizeFederatedSource).
func federatedChatForSource(ctx context.Context, st *store.Store, chatID string) (*model.Chat, error) {
	chat, ok := st.GetChat(ctx, chatID)
	if !ok {
		return nil, &statusError{ErrorMessage: msgChatNotFound, code: http.StatusNotFound}
	}

	remoteServer := federatedServerFromContext(ctx)
	if remoteServer == "" {
		return nil, &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
	}
	if chat.RemoteServer == remoteServer {
		return chat, nil
	}
	// A locally owned group accepts messages from any server that has a
	// member in it; the sender itself is validated against that peer.
	if chat.RemoteServer == "" {
		for _, member := range chat.Members {
			if service.UserIDBelongsToServer(member, remoteServer) {
				return chat, nil
			}
		}
	}
	return nil, &statusError{ErrorMessage: msgNotMember, code: http.StatusForbidden}
}

// federatedChatForPeerAction is like federatedChatForSource but marks the
// authenticated peer as the source for author/typing checks. This is needed
// for edit/delete/typing in a locally owned group, where the chat itself has
// no RemoteServer.
func federatedChatForPeerAction(ctx context.Context, st *store.Store, chatID string) (*model.Chat, error) {
	chat, err := federatedChatForSource(ctx, st, chatID)
	if err != nil {
		return nil, err
	}
	peer := federatedServerFromContext(ctx)
	clone := *chat
	clone.FederatedPeer = peer
	if chat.RemoteServer == "" {
		// A locally owned chat has no RemoteServer. Mark the copy as local
		// and set the peer for the legacy author checks, but keep LocalChat
		// so relay guards know this chat must fan out.
		clone.RemoteServer = peer
		clone.LocalChat = true
	}
	return &clone, nil
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

	chat, err := federatedChatForPeerAction(ctx, st, chatID)
	if err != nil {
		return nil, err
	}

	// The message is addressed by (chat, id); a thread only narrows the
	// container. Without this check a peer that knew a foreign thread id
	// could aim the edit at a thread of another chat.
	if threadID != "" {
		thread, ok := st.GetThread(ctx, threadID)
		if !ok || thread.ChatID != chatID {
			return nil, errThreadNotFound
		}
	}

	updated, err := svc.EditFederatedMessage(ctx, chat, messageID, threadID, req, cfg.MessageEditTTL)
	if err != nil {
		return nil, federatedOrInternalError(err)
	}

	var out federatedMessageOutput
	out.Status = http.StatusOK
	out.Body.Message = updated

	return &out, nil
}

// federatedOrInternalError maps federation-domain errors, logging and
// converting unmapped ones to a 500 (pre-migration parity). Errors already
// mapped to a status (see mapFederatedCallError) pass through untouched.
func federatedOrInternalError(err error) error {
	if se, _ := errors.AsType[*statusError](err); se != nil {
		return se
	}

	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("federated operation failed", "err", err)

	return errInternal
}

// --- Input/output types ---

type federatedReactionInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
	Body      struct {
		UserID string    `json:"userId"`
		Emoji  string    `json:"emoji"`
		Add    bool      `json:"add"`
		At     time.Time `json:"at"`
	}
}

type federatedAddGroupMemberInput struct {
	ID   string `path:"id"`
	Body struct {
		UserID string `json:"userId"`
	}
}

type federatedCreateThreadInput struct {
	ID   string `path:"id"`
	Body struct {
		ID                string    `json:"id"`
		ParentMessageID   string    `json:"parentMessageId"`
		ParentMessageText string    `json:"parentMessageText,omitempty"`
		ParentMessageFrom string    `json:"parentMessageFrom,omitempty"`
		CreatedAt         time.Time `json:"createdAt"`
	}
}

type federatedSendThreadMessageInput struct {
	ID       string `path:"id"`
	ThreadID string `path:"threadId"`
	Body     struct {
		ID               string           `json:"id"`
		FromID           string           `json:"fromId"`
		FromNick         string           `json:"fromNick"`
		Text             string           `json:"text"`
		ReplyToID        string           `json:"replyToId,omitempty"`
		ThreadParentID   string           `json:"threadParentId,omitempty"`
		Location         *model.Location  `json:"location,omitempty"`
		Encrypted        bool             `json:"encrypted,omitempty"`
		EncryptedPayload string           `json:"encryptedPayload,omitempty"`
		Files            []model.FileInfo `json:"files,omitempty"`
	}
}

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
		BotID        string   `json:"botId,omitempty"`
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
	ID               string           `json:"id,omitempty"`
	FromID           string           `json:"fromId,omitempty"`
	FromNick         string           `json:"fromNick,omitempty"`
	Text             string           `json:"text,omitempty"`
	ReplyToID        string           `json:"replyToId,omitempty"`
	Location         *model.Location  `json:"location,omitempty"`
	Encrypted        bool             `json:"encrypted,omitempty"`
	EncryptedPayload string           `json:"encryptedPayload,omitempty"`
	Files            []model.FileInfo `json:"files,omitempty"`
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
	Since   string `query:"since"`
	SinceID string `query:"sinceId"`
	Limit   int    `query:"limit"`
}

type federatedSyncOutput struct {
	Body service.SyncFederatedResponse
}

type federatedCreateGroupInput struct {
	Body struct {
		ChatID  string   `json:"chatId"`
		Name    string   `json:"name"`
		OwnerID string   `json:"ownerId"`
		Members []string `json:"members"`
	}
}

type federatedCreateGroupOutput struct {
	Status int
	Body   struct {
		Status string            `json:"status,omitempty"`
		Chat   *service.ChatView `json:"chat,omitempty"`
	}
}

func registerFederatedFiles(api huma.API, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-serve-file",
		Method:      http.MethodGet,
		Path:        "/api/federated/files/{fileId}",
		Summary:     "Serve an attachment to a peer server",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *federatedFileInput) (*huma.StreamResponse, error) {
		server := federatedServerFromContext(ctx)
		file, err := st.GetFile(ctx, input.FileID)
		if err != nil || file.RemoteServer != "" || !svc.FileVisibleToServer(ctx, input.FileID, server) {
			return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusNotFound}
		}

		fullPath := filepath.Join(cfg.Uploads.Dir, file.StoragePath)
		return &huma.StreamResponse{
			Body: func(hctx huma.Context) {
				r, w := humachi.Unwrap(hctx)
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
				w.Header().Set("Content-Type", file.MimeType)
				disposition := "attachment"
				if filestage.IsInlinableMIME(file.MimeType) {
					disposition = "inline"
				}
				w.Header().Set("Content-Disposition", filestage.ContentDisposition(disposition, file.OriginalName))
				w.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(mimeCacheMaxAge))
				http.ServeFile(w, r, fullPath)
			},
		}, nil
	})
}

type federatedFileInput struct {
	FileID string `path:"fileId"`
}

type federatedGroupMemberInput struct {
	ID     string `path:"id"`
	UserID string `path:"userId"`
}

type federatedGroupIDInput struct {
	ID string `path:"id"`
}

type federatedRenameGroupInput struct {
	ID   string `path:"id"`
	Body struct {
		Name string `json:"name"`
	}
}
