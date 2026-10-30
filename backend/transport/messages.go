package transport

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

// RegisterMessages adds the message, thread, read-status, and typing
// operations.
func RegisterMessages(api huma.API, svc *service.Service, st *store.Store, fed *federation.Client, cfg *config.Config) {
	registerMessagePages(api, svc)
	registerMessageMutations(api, svc, st, fed, cfg)
	registerThreads(api, svc, st, fed, cfg)
	registerTyping(api, svc, fed)
}

// registerMessagePages registers a subset of the message-domain operations.
func registerMessagePages(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-messages",
		Method:      http.MethodGet,
		Path:        "/api/chats/{id}/messages",
		Summary:     "Page through a chat's messages",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *listMessagesInput) (*messagesWithCursorOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		limit := messageLimit(input.Limit)

		messages, nextCursor, err := svc.GetMessages(ctx, chat, user.ID, limit, input.Before, nil)
		if err != nil {
			return nil, errInternal
		}
		if messages == nil {
			messages = []service.MessageWithStatus{}
		}

		return messagesWithCursor(messages, nextCursor), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "query-messages",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/messages/query",
		Summary:     "Fetch messages with statuses by ID list",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *queryMessagesInput) (*messagesWithCursorOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		limit := input.Body.Limit
		if limit <= 0 || limit > service.MaxMessagesLimit {
			limit = service.DefaultMessagesLimit
		}

		// MissingIDs drives a batch status lookup: cap it like the read
		// receipts endpoint so a 1MB body cannot turn into a 20k-row IN query.
		if len(input.Body.MissingIDs) > service.MaxMessagesLimit {
			return nil, &statusError{ErrorMessage: msgTooManyMessageIDs, code: http.StatusBadRequest}
		}

		messages, nextCursor, err := svc.GetMessages(ctx, chat, user.ID, limit, input.Body.Before, input.Body.MissingIDs)
		if err != nil {
			return nil, errInternal
		}
		if messages == nil {
			messages = []service.MessageWithStatus{}
		}

		return messagesWithCursor(messages, nextCursor), nil
	})
}

// registerMessageMutations registers a subset of the message-domain operations.
func registerMessageMutations(api huma.API, svc *service.Service, st *store.Store, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "send-message",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/messages",
		Summary:     "Send a message to a chat",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *sendMessageInput) (*messageOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, threadID, err := resolveMessageTarget(ctx, svc, st, input.ID, "", user.ID)
		if err != nil {
			return nil, err
		}

		out, err := sendMessage(ctx, svc, fed, chat, threadID, user, &service.SendMessageInput{
			ID:               input.Body.ID,
			Text:             input.Body.Text,
			ReplyToID:        input.Body.ReplyToID,
			FileIDs:          input.Body.FileIDs,
			FileHashes:       input.Body.FileHashes,
			Location:         input.Body.Location,
			Encrypted:        input.Body.Encrypted,
			EncryptedPayload: input.Body.EncryptedPayload,
		})
		if err != nil {
			return nil, err
		}

		return messageResponseBody(out, http.StatusCreated), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "edit-message",
		Method:      http.MethodPatch,
		Path:        "/api/chats/{id}/messages/{messageId}",
		Summary:     "Edit a message",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *editMessageInput) (*messageOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		return editMessage(ctx, svc, fed, st, input.ID, "", input.MessageID, user, cfg, &input.Body.DecodedEditRequest)
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-message",
		Method:      http.MethodDelete,
		Path:        "/api/chats/{id}/messages/{messageId}",
		Summary:     "Delete a message",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *deleteMessageInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		if err := svc.DeleteMessage(ctx, chat, input.MessageID, user.ID, cfg.MessageDeleteTTL); err != nil {
			return nil, messageOrInternalError(err)
		}

		fedDelete(ctx, fed, chat.RemoteServer, "/api/federated/chats/"+chat.ID+"/messages/"+input.MessageID)

		return deletedStatus(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "mark-messages-read",
		Method:      http.MethodPost,
		Path:        "/api/messages/read",
		Summary:     "Mark messages as read",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *markReadInput) (*statusOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if len(input.Body.MessageIDs) == 0 || input.Body.ChatID == "" {
			return nil, &statusError{ErrorMessage: "messageIds and chatId are required", code: http.StatusBadRequest}
		}

		if len(input.Body.MessageIDs) > 100 {
			return nil, &statusError{ErrorMessage: msgTooManyMessageIDs, code: http.StatusBadRequest}
		}

		if _, err := requireChatMember(ctx, svc, input.Body.ChatID, user.ID); err != nil {
			return nil, err
		}

		if err := svc.MarkMessagesRead(ctx, input.Body.ChatID, user.ID, input.Body.MessageIDs); err != nil {
			return nil, messageOrInternalError(err)
		}

		return okStatus(), nil
	})
}

// registerThreads registers a subset of the message-domain operations.
func registerThreads(api huma.API, svc *service.Service, st *store.Store, fed *federation.Client, cfg *config.Config) {
	registerThreadLifecycle(api, svc)
	registerThreadMessages(api, svc, st, fed, cfg)
}

// registerThreadLifecycle registers thread create/list operations.
func registerThreadLifecycle(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "create-thread",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/messages/{messageId}/thread",
		Summary:     "Create a thread from a message",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *createThreadInput) (*threadOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		thread, err := svc.CreateThread(ctx, chat, input.ID, input.MessageID)
		if err != nil {
			return nil, messageOrInternalError(err)
		}

		var out threadOutput
		out.Body.Thread = thread
		out.Status = http.StatusCreated

		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-threads",
		Method:      http.MethodGet,
		Path:        "/api/chats/{id}/threads",
		Summary:     "List a chat's threads",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *chatPathInput) (*threadsOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if _, err := requireChatMember(ctx, svc, input.ID, user.ID); err != nil {
			return nil, err
		}

		var out threadsOutput
		out.Body.Threads = svc.GetThreads(ctx, input.ID)

		return &out, nil
	})
}

// registerThreadMessages registers thread message list/send/edit operations.
func registerThreadMessages(api huma.API, svc *service.Service, st *store.Store, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "list-thread-messages",
		Method:      http.MethodGet,
		Path:        "/api/chats/{id}/threads/{threadId}/messages",
		Summary:     "Page through a thread's messages",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *threadPathInput) (*threadMessagesOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		thread, err := requireThread(ctx, st, input.ThreadID)
		if err != nil {
			return nil, err
		}

		if thread.ChatID != input.ID {
			return nil, errThreadNotFound
		}

		if _, err := requireChatMember(ctx, svc, thread.ChatID, user.ID); err != nil {
			return nil, err
		}

		limit := messageLimit(input.Limit)

		messages, nextCursor, err := svc.GetThreadMessages(ctx, thread.ID, limit, input.Before)
		if err != nil {
			return nil, errInternal
		}
		if messages == nil {
			messages = []model.Message{}
		}

		return threadMessages(messages, nextCursor), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "send-thread-message",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/threads/{threadId}/messages",
		Summary:     "Send a message inside a thread",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *sendThreadMessageInput) (*messageOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, threadID, err := resolveMessageTarget(ctx, svc, st, input.ID, input.ThreadID, user.ID)
		if err != nil {
			return nil, err
		}

		out, err := sendMessage(ctx, svc, fed, chat, threadID, user, &service.SendMessageInput{
			ID:               input.Body.ID,
			Text:             input.Body.Text,
			ReplyToID:        input.Body.ReplyToID,
			FileIDs:          input.Body.FileIDs,
			FileHashes:       input.Body.FileHashes,
			Location:         input.Body.Location,
			Encrypted:        input.Body.Encrypted,
			EncryptedPayload: input.Body.EncryptedPayload,
		})
		if err != nil {
			return nil, err
		}

		return messageResponseBody(out, http.StatusCreated), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "edit-thread-message",
		Method:      http.MethodPatch,
		Path:        "/api/chats/{id}/threads/{threadId}/messages/{messageId}",
		Summary:     "Edit a message inside a thread",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *editThreadMessageInput) (*messageOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		return editMessage(ctx, svc, fed, st, input.ID, input.ThreadID, input.MessageID, user, cfg, &input.Body.DecodedEditRequest)
	})
}

// registerTyping registers a subset of the message-domain operations.
func registerTyping(api huma.API, svc *service.Service, fed *federation.Client) {
	huma.Register(api, huma.Operation{
		OperationID: "typing",
		Method:      http.MethodPost,
		Path:        "/api/chats/{id}/typing",
		Summary:     "Send a typing indicator",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *typingInput) (*typingOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		chat, err := requireChatMember(ctx, svc, input.ID, user.ID)
		if err != nil {
			return nil, err
		}

		throttled := svc.HandleTyping(ctx, chat, input.ID, user.ID, user.Nick, input.Body.Active)
		if throttled {
			return &typingOutput{Body: struct {
				Status string `example:"ok" json:"status"`
			}{Status: "throttled"}}, nil
		}

		fedPost(ctx, fed, chat.RemoteServer, "/api/federated/chats/"+input.ID+"/typing", map[string]any{
			"userId": user.ID,
			"active": input.Body.Active,
			"nick":   user.Nick,
		})

		return &typingOutput{Body: struct {
			Status string `example:"ok" json:"status"`
		}{Status: "ok"}}, nil
	})
}

// --- Shared operation helpers ---

// messageOrInternalError maps message-domain errors, logging and converting
// unmapped ones to a 500 (pre-migration parity).
func messageOrInternalError(err error) error {
	if se := MapError(err); se != nil {
		return se
	}

	slog.Error("message operation failed", "err", err)

	return errInternal
}

// messageLimit normalizes a page-size query parameter to the service bounds.
func messageLimit(limit int) int {
	if limit <= 0 || limit > service.MaxMessagesLimit {
		return service.DefaultMessagesLimit
	}

	return limit
}

// resolveMessageTarget loads the chat a request addresses. For a thread the
// chat comes from the thread, and the thread must belong to the chat in the
// path: a thread reached through a foreign chat id is a 404, not a write
// under a chat the caller was never authorised for.
func resolveMessageTarget(ctx context.Context, svc *service.Service, st *store.Store, chatID, threadID, userID string) (*model.Chat, string, error) {
	if threadID != "" {
		thread, threadErr := requireThread(ctx, st, threadID)
		if threadErr != nil {
			return nil, "", threadErr
		}

		if thread.ChatID != chatID {
			return nil, "", errThreadNotFound
		}

		chat, chatErr := requireChatMember(ctx, svc, thread.ChatID, userID)
		if chatErr != nil {
			return nil, "", chatErr
		}

		return chat, threadID, nil
	}

	chat, chatErr := requireChatMember(ctx, svc, chatID, userID)
	if chatErr != nil {
		return nil, "", chatErr
	}

	return chat, "", nil
}

// requireThread loads a thread or maps to the pre-migration 404.
func requireThread(ctx context.Context, st *store.Store, threadID string) (*model.Thread, error) {
	thread, ok := st.GetThread(ctx, threadID)
	if !ok {
		return nil, errThreadNotFound
	}

	return &thread, nil
}

// sendMessage performs the shared send flow: service call, federated
// propagation, and push fan-out.
func sendMessage(
	ctx context.Context,
	svc *service.Service,
	fed *federation.Client,
	chat *model.Chat,
	threadID string,
	user *authUser,
	input *service.SendMessageInput,
) (*model.Message, error) {

	// File references resolve with one store lookup each: reject an obviously
	// abusive batch on the transport before the service fans out to the DB.
	if len(input.FileIDs) > service.MaxMessageFiles || len(input.FileHashes) > service.MaxMessageFiles {
		return nil, &statusError{ErrorMessage: msgTooManyFiles, code: http.StatusBadRequest}
	}

	msg, err := svc.SendMessage(ctx, chat, threadID, user.ID, user.Nick, input)
	if err != nil {
		return nil, messageOrInternalError(err)
	}

	if threadID == "" {
		// The attachments are not federated: the peer does not have the
		// file, and there is no endpoint that would hand it over. A message
		// with an attachment therefore reaches the peer without it. Sending
		// the file is a separate feature: it needs an endpoint, a size
		// policy and a transfer of the encrypted content.
		fedPost(ctx, fed, chat.RemoteServer, "/api/federated/chats/"+chat.ID+"/messages", map[string]any{
			"id":               msg.ID,
			"fromId":           msg.FromID,
			"fromNick":         msg.FromNick,
			"text":             msg.Text,
			"replyToId":        input.ReplyToID,
			"location":         input.Location,
			"encrypted":        msg.Encrypted,
			"encryptedPayload": msg.EncryptedPayload,
		})
	}

	for _, memberID := range chat.Members {
		if memberID == user.ID {
			continue
		}

		svc.SendPushForMessage(ctx, chat, msg, threadID, memberID)
	}

	return msg, nil
}

// editMessage performs the shared edit flow for chat and thread messages.
func editMessage(
	ctx context.Context,
	svc *service.Service,
	fed *federation.Client,
	st *store.Store,
	chatID, threadID, messageID string,
	user *authUser,
	cfg *config.Config,
	req *service.DecodedEditRequest,
) (*messageOutput, error) {

	var chat *model.Chat

	if threadID != "" {
		thread, threadErr := requireThread(ctx, st, threadID)
		if threadErr != nil {
			return nil, threadErr
		}

		if thread.ChatID != chatID {
			return nil, errThreadNotFound
		}

		chat, threadErr = requireChatMember(ctx, svc, thread.ChatID, user.ID)
		if threadErr != nil {
			return nil, threadErr
		}
	} else {
		var chatErr error
		chat, chatErr = requireChatMember(ctx, svc, chatID, user.ID)
		if chatErr != nil {
			return nil, chatErr
		}
	}

	if len(req.FileIDs) > service.MaxMessageFiles || len(req.FileHashes) > service.MaxMessageFiles {
		return nil, &statusError{ErrorMessage: msgTooManyFiles, code: http.StatusBadRequest}
	}

	updated, edit, err := svc.EditMessage(ctx, chat.ID, threadID, messageID, user.ID, req, cfg.MessageEditTTL)
	if err != nil {
		return nil, messageOrInternalError(err)
	}

	payload := map[string]any{
		"text":             edit.Text,
		"fileIDs":          edit.FileIDs,
		"location":         edit.RawLocation,
		"encrypted":        edit.Encrypted,
		"encryptedPayload": edit.EncryptedPayload,
	}

	if threadID != "" {
		fedPatch(ctx, fed, chat.RemoteServer, "/api/federated/chats/"+chat.ID+"/threads/"+threadID+"/messages/"+messageID, payload)
	} else {
		fedPatch(ctx, fed, chat.RemoteServer, "/api/federated/chats/"+chat.ID+"/messages/"+messageID, payload)
	}

	svc.BroadcastMessageUpdated(ctx, chat, threadID, &updated)

	var out messageOutput
	out.Body.Message = &updated
	out.Status = http.StatusOK

	return &out, nil
}

// --- Input/output types ---

type listMessagesInput struct {
	ID     string `path:"id"`
	Limit  int    `query:"limit"`
	Before string `query:"before"`
}

type messagesWithCursorOutput struct {
	Body struct {
		Messages   []service.MessageWithStatus `json:"messages"`
		NextCursor string                      `json:"nextCursor"`
	}
}

func messagesWithCursor(messages []service.MessageWithStatus, nextCursor string) *messagesWithCursorOutput {
	var out messagesWithCursorOutput
	out.Body.Messages = messages
	out.Body.NextCursor = nextCursor

	return &out
}

type queryMessagesInput struct {
	ID   string `path:"id"`
	Body struct {
		Limit      int      `json:"limit,omitempty"`
		Before     string   `json:"before,omitempty"`
		MissingIDs []string `json:"missingIDs,omitempty"`
	}
}

type sendMessageInput struct {
	ID   string `path:"id"`
	Body struct {
		ID               string          `json:"id,omitempty"`
		Text             string          `json:"text,omitempty"`
		ReplyToID        string          `json:"replyToId,omitempty"`
		FileIDs          []string        `json:"fileIDs,omitempty"`
		FileHashes       []string        `json:"fileHashes,omitempty"`
		Location         *model.Location `json:"location,omitempty"`
		Encrypted        bool            `json:"encrypted,omitempty"`
		EncryptedPayload string          `json:"encryptedPayload,omitempty"`
	}
}

type messageOutput struct {
	Status int
	Body   struct {
		Message *model.Message `json:"message"`
	}
}

func (o *messageOutput) GetStatus() int {
	return o.Status
}

func messageResponseBody(msg *model.Message, status int) *messageOutput {
	var out messageOutput
	out.Body.Message = msg
	out.Status = status

	return &out
}

type editMessageInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
	Body      struct {
		service.DecodedEditRequest
	}
}

type deleteMessageInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
}

type markReadInput struct {
	Body struct {
		MessageIDs []string `json:"messageIDs,omitempty"`
		ChatID     string   `json:"chatId,omitempty"`
	}
}

func okStatus() *statusOutput {
	var out statusOutput
	out.Body.Status = "ok"

	return &out
}

type createThreadInput struct {
	ID        string `path:"id"`
	MessageID string `path:"messageId"`
}

type threadOutput struct {
	Status int
	Body   struct {
		Thread *model.Thread `json:"thread"`
	}
}

func (o *threadOutput) GetStatus() int {
	return o.Status
}

type threadsOutput struct {
	Body struct {
		Threads []model.Thread `json:"threads"`
	}
}

type threadPathInput struct {
	ID       string `path:"id"`
	ThreadID string `path:"threadId"`
	Limit    int    `query:"limit"`
	Before   string `query:"before"`
}

type threadMessagesOutput struct {
	Body struct {
		Messages   []model.Message `json:"messages"`
		NextCursor string          `json:"nextCursor"`
	}
}

func threadMessages(messages []model.Message, nextCursor string) *threadMessagesOutput {
	var out threadMessagesOutput
	out.Body.Messages = messages
	out.Body.NextCursor = nextCursor

	return &out
}

type sendThreadMessageInput struct {
	ID       string `path:"id"`
	ThreadID string `path:"threadId"`
	Body     struct {
		ID               string          `json:"id,omitempty"`
		Text             string          `json:"text,omitempty"`
		ReplyToID        string          `json:"replyToId,omitempty"`
		FileIDs          []string        `json:"fileIDs,omitempty"`
		FileHashes       []string        `json:"fileHashes,omitempty"`
		Location         *model.Location `json:"location,omitempty"`
		Encrypted        bool            `json:"encrypted,omitempty"`
		EncryptedPayload string          `json:"encryptedPayload,omitempty"`
	}
}

type editThreadMessageInput struct {
	ID        string `path:"id"`
	ThreadID  string `path:"threadId"`
	MessageID string `path:"messageId"`
	Body      struct {
		service.DecodedEditRequest
	}
}

type typingInput struct {
	ID   string `path:"id"`
	Body struct {
		Active bool `json:"active,omitempty"`
	}
}

type typingOutput struct {
	Body struct {
		Status string `example:"ok" json:"status"`
	}
}
