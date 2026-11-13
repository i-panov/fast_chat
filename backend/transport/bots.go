package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/model"
	"fast_chat/service"
)

//nolint:funlen,gocognit,gocyclo,cyclop,maintidx // one function registers the small Bot API surface.
func registerBots(api huma.API, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "create-bot",
		Method:      http.MethodPost,
		Path:        "/api/bots",
		Summary:     "Create a bot for the authenticated user",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *botCreateInput) (*botCreateOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		created, err := svc.CreateBot(ctx, user.ID, input.Body.Username, input.Body.DisplayName)
		if err != nil {
			return nil, botError(err)
		}
		var out botCreateOutput
		out.Status = http.StatusCreated
		out.Body.OK = true
		out.Body.Token = created.Token
		out.Body.Bot = service.BotManagedView{
			ID: created.User.ID, Username: created.User.Username,
			DisplayName: created.User.DisplayName, IsActive: created.Bot.IsActive,
			IsMaster: created.Bot.IsMaster,
		}
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-bots",
		Method:      http.MethodGet,
		Path:        "/api/bots",
		Summary:     "List bots owned by the authenticated user",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*botListOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		bots, err := svc.ListOwnedBots(ctx, user.ID)
		if err != nil {
			return nil, errInternal
		}
		var out botListOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = bots
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "rotate-bot-token",
		Method:      http.MethodPost,
		Path:        "/api/bots/{username}/token",
		Summary:     "Rotate a bot token",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *botTokenInput) (*botTokenOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		token, err := svc.RotateBotToken(ctx, user.ID, input.Username)
		if err != nil {
			return nil, botError(err)
		}
		var out botTokenOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Token = token
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-get-chat",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/getChat",
		Summary:     "Get a bot chat",
	}, func(ctx context.Context, input *botChatInput) (*botChatOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		chat, err := svc.GetBotChat(ctx, bot.UserID, input.Body.ChatID)
		if err != nil {
			return nil, botError(err)
		}
		var out botChatOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = chat
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-chat-action",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/sendChatAction",
		Summary:     "Send a chat action such as typing",
	}, func(ctx context.Context, input *botChatActionInput) (*botOKOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		if err := svc.BotChatAction(ctx, bot.UserID, input.Body.ChatID, input.Body.Action); err != nil {
			return nil, botError(err)
		}
		return newBotOKOutput(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-get-me",
		Method:      http.MethodGet,
		Path:        "/api/bot-api/getMe",
		Summary:     "Return the bot identity",
	}, func(ctx context.Context, _ *struct{}) (*botMeOutput, error) {
		bot, user, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		var out botMeOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = botMeResult(bot, user)
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-get-updates",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/getUpdates",
		Summary:     "Long-poll bot updates",
	}, func(ctx context.Context, input *botGetUpdatesInput) (*botUpdatesOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		updates, err := svc.PollBotUpdates(ctx, bot.UserID, input.Body.Offset, input.Body.Limit, time.Duration(input.Body.Timeout)*time.Second)
		if err != nil {
			return nil, &statusError{ErrorMessage: "failed to poll updates", code: http.StatusInternalServerError}
		}
		out := &botUpdatesOutput{}
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = make([]map[string]any, 0, len(updates))
		for i := range updates {
			var payload map[string]any
			if err := json.Unmarshal([]byte(updates[i].Payload), &payload); err != nil {
				continue
			}
			payload["update_id"] = updates[i].ID
			out.Body.Result = append(out.Body.Result, payload)
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-send-message",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/sendMessage",
		Summary:     "Send a plaintext message from a bot",
	}, func(ctx context.Context, input *botSendMessageInput) (*botSendMessageOutput, error) {
		bot, user, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		var msg *model.Message
		if input.Body.Encrypted {
			msg, err = svc.SendBotEncryptedMessage(ctx, bot.UserID, input.Body.ChatID, input.Body.Text, input.Body.EncryptedPayload)
		} else {
			msg, err = svc.SendBotMessage(ctx, bot.UserID, input.Body.ChatID, input.Body.Text, input.Body.ReplyMarkup)
		}
		if err != nil {
			return nil, botError(err)
		}
		var out botSendMessageOutput
		out.Status = http.StatusCreated
		out.Body.OK = true
		out.Body.Result = botMessageDTOFrom(msg, user)
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-edit-message",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/editMessageText",
		Summary:     "Edit a message sent by the bot",
	}, func(ctx context.Context, input *botEditMessageInput) (*botSendMessageOutput, error) {
		bot, user, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		msg, err := svc.EditBotMessage(
			ctx, bot.UserID, input.Body.ChatID, input.Body.MessageID,
			input.Body.Text, input.Body.ReplyMarkup,
			input.Body.Encrypted, input.Body.EncryptedPayload,
		)
		if err != nil {
			return nil, botError(err)
		}
		var out botSendMessageOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = botMessageDTOFrom(msg, user)
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-delete-message",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/deleteMessage",
		Summary:     "Delete a message sent by the bot",
	}, func(ctx context.Context, input *botDeleteMessageInput) (*botOKOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		if err := svc.DeleteBotMessage(ctx, bot.UserID, input.Body.ChatID, input.Body.MessageID); err != nil {
			return nil, botError(err)
		}
		return newBotOKOutput(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-set-encryption-key",
		Method:      http.MethodPut,
		Path:        "/api/bot-api/encryption-key",
		Summary:     "Enable E2EE and register the bot public key",
	}, func(ctx context.Context, input *botEncryptionInput) (*botOKOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		raw, err := service.DecodePublicKey(input.Body.PublicKey)
		if err != nil {
			return nil, &statusError{ErrorMessage: msgInvalidPublicKey, code: http.StatusBadRequest}
		}
		if err := svc.SetBotEncryptionKey(ctx, bot.UserID, encodePublicKey(raw)); err != nil {
			return nil, errInternal
		}
		return newBotOKOutput(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-user-device-keys",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/getUserDeviceKeys",
		Summary:     "List the device keys of a user in a bot chat",
	}, func(ctx context.Context, input *botUserKeysInput) (*botUserKeysOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		if _, ok := svc.GetBotChatForUser(ctx, bot.UserID, input.Body.UserID); !ok {
			return nil, &statusError{ErrorMessage: "bot chat not found", code: http.StatusForbidden}
		}
		devices, err := svc.ListUserDeviceKeys(ctx, input.Body.UserID)
		if err != nil {
			return nil, errInternal
		}
		var out botUserKeysOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result = devices
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-answer-callback",
		Method:      http.MethodPost,
		Path:        "/api/bot-api/answerCallbackQuery",
		Summary:     "Answer an inline button callback",
	}, func(ctx context.Context, input *botAnswerCallbackInput) (*botOKOutput, error) {
		bot, _, err := botFromContext(ctx, svc)
		if err != nil {
			return nil, err
		}
		if err := svc.AnswerBotCallback(
			ctx, bot.UserID, input.Body.CallbackQueryID,
			input.Body.Text, input.Body.ShowAlert,
			input.Body.Encrypted, input.Body.EncryptedPayload,
		); err != nil {
			return nil, botError(err)
		}
		return newBotOKOutput(), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "bot-chat-callback",
		Method:      http.MethodPost,
		Path:        "/api/bot-chats/{chatId}/callbacks",
		Summary:     "Press an inline button",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *botChatCallbackInput) (*botChatCallbackOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		callback, err := svc.CreateBotCallback(ctx, user.ID, input.ChatID, input.Body.MessageID, input.Body.Data)
		if err != nil {
			return nil, botError(err)
		}
		var out botChatCallbackOutput
		out.Status = http.StatusOK
		out.Body.OK = true
		out.Body.Result.CallbackQueryID = callback.ID
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "open-bot-chat",
		Method:      http.MethodPost,
		Path:        "/api/bot-chats",
		Summary:     "Open a 1-1 chat with a bot",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *openBotChatInput) (*createChatOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}
		view, err := svc.OpenBotChat(ctx, user.ID, input.Body.Username)
		if err != nil {
			return nil, botError(err)
		}
		var out createChatOutput
		out.Body.Chat = view
		out.Status = http.StatusCreated
		return &out, nil
	})
}

func botFromContext(ctx context.Context, svc *service.Service) (*model.Bot, *model.User, error) {
	req, ok := requestFromContext(ctx)
	if !ok {
		return nil, nil, errUnauthorized
	}
	header := req.Header.Get("Authorization")
	token := strings.TrimPrefix(header, "Bearer ")
	if token == header || token == "" {
		return nil, nil, &statusError{ErrorMessage: "bot token required", code: http.StatusUnauthorized}
	}
	bot, user, ok := svc.GetBotByToken(ctx, token)
	if !ok {
		return nil, nil, &statusError{ErrorMessage: "invalid bot token", code: http.StatusUnauthorized}
	}
	return bot, user, nil
}

func botError(err error) error {
	switch {
	case errors.Is(err, service.ErrBotUsernameInvalid):
		return &statusError{ErrorMessage: "invalid bot username", code: http.StatusBadRequest}
	case errors.Is(err, service.ErrBotUsernameTaken):
		return &statusError{ErrorMessage: "bot username taken", code: http.StatusConflict}
	case errors.Is(err, service.ErrBotNotActive):
		return &statusError{ErrorMessage: "bot is not active", code: http.StatusForbidden}
	case errors.Is(err, service.ErrChatNotFound), errors.Is(err, service.ErrUserNotFound):
		return &statusError{ErrorMessage: "bot chat not found", code: http.StatusNotFound}
	case errors.Is(err, service.ErrEmptyMessage):
		return &statusError{ErrorMessage: "empty message", code: http.StatusBadRequest}
	case errors.Is(err, service.ErrBotMarkupInvalid):
		return &statusError{ErrorMessage: "invalid inline keyboard", code: http.StatusBadRequest}
	case errors.Is(err, service.ErrBotActionInvalid):
		return &statusError{ErrorMessage: "unsupported chat action", code: http.StatusBadRequest}
	case errors.Is(err, service.ErrMessageNotFound):
		return &statusError{ErrorMessage: "message not found", code: http.StatusNotFound}
	default:
		return errInternal
	}
}

type botMeResultType struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"display_name"`    //nolint:tagliatelle // Bot API uses snake_case
	IsBot          bool   `json:"is_bot"`          //nolint:tagliatelle // Bot API uses snake_case
	EncryptionMode string `json:"encryption_mode"` //nolint:tagliatelle // Bot API uses snake_case
}

func botMeResult(bot *model.Bot, user *model.User) botMeResultType {
	return botMeResultType{
		ID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
		IsBot: true, EncryptionMode: bot.EncryptionMode,
	}
}

type botMeOutput struct {
	Status int
	Body   struct {
		OK     bool            `json:"ok"`
		Result botMeResultType `json:"result"`
	}
}

type botGetUpdatesInput struct {
	Body struct {
		Offset  uint64 `json:"offset"`
		Limit   int    `json:"limit"`
		Timeout int    `json:"timeout"`
	}
}

type botUpdatesOutput struct {
	Status int
	Body   struct {
		OK     bool             `json:"ok"`
		Result []map[string]any `json:"result"`
	}
}

type botSendMessageInput struct {
	Body struct {
		ChatID           string                      `json:"chat_id"` //nolint:tagliatelle // Bot API uses snake_case
		Text             string                      `json:"text"`
		ReplyMarkup      *model.InlineKeyboardMarkup `json:"reply_markup,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
		Encrypted        bool                        `json:"encrypted,omitempty"`
		EncryptedPayload string                      `json:"encrypted_payload,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
	}
}

type botEditMessageInput struct {
	Body struct {
		ChatID           string                      `json:"chat_id"`    //nolint:tagliatelle // Bot API uses snake_case
		MessageID        string                      `json:"message_id"` //nolint:tagliatelle // Bot API uses snake_case
		Text             string                      `json:"text"`
		ReplyMarkup      *model.InlineKeyboardMarkup `json:"reply_markup,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
		Encrypted        bool                        `json:"encrypted,omitempty"`
		EncryptedPayload string                      `json:"encrypted_payload,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
	}
}

type botDeleteMessageInput struct {
	Body struct {
		ChatID    string `json:"chat_id"`    //nolint:tagliatelle // Bot API uses snake_case
		MessageID string `json:"message_id"` //nolint:tagliatelle // Bot API uses snake_case
	}
}

type botAnswerCallbackInput struct {
	Body struct {
		CallbackQueryID  string `json:"callback_query_id"` //nolint:tagliatelle // Bot API uses snake_case
		Text             string `json:"text"`
		ShowAlert        bool   `json:"show_alert"` //nolint:tagliatelle // Bot API uses snake_case
		Encrypted        bool   `json:"encrypted,omitempty"`
		EncryptedPayload string `json:"encrypted_payload,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
	}
}

type botChatCallbackInput struct {
	ChatID string `path:"chatId"`
	Body   struct {
		MessageID string `json:"messageId"`
		Data      string `json:"data"`
	}
}

type botChatCallbackOutput struct {
	Status int
	Body   struct {
		OK     bool `json:"ok"`
		Result struct {
			CallbackQueryID string `json:"callback_query_id"` //nolint:tagliatelle // Bot API uses snake_case
		} `json:"result"`
	}
}

func (o *botChatCallbackOutput) GetStatus() int { return o.Status }

type openBotChatInput struct {
	Body struct {
		Username string `json:"username"`
	}
}

func (o *botMeOutput) GetStatus() int      { return o.Status }
func (o *botUpdatesOutput) GetStatus() int { return o.Status }

type botSendMessageOutput struct {
	Status int
	Body   struct {
		OK     bool           `json:"ok"`
		Result *botMessageDTO `json:"result"`
	}
}

func (o *botSendMessageOutput) GetStatus() int { return o.Status }

func newBotOKOutput() *botOKOutput {
	var out botOKOutput
	out.Status = http.StatusOK
	out.Body.OK = true
	out.Body.Result = true
	return &out
}

type botOKOutput struct {
	Status int
	Body   struct {
		OK     bool `json:"ok"`
		Result bool `json:"result"`
	}
}

func (o *botOKOutput) GetStatus() int { return o.Status }

type botCreateInput struct {
	Body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName,omitempty"`
	}
}

type botCreateOutput struct {
	Status int
	Body   struct {
		OK    bool                   `json:"ok"`
		Bot   service.BotManagedView `json:"bot"`
		Token string                 `json:"token"`
	}
}

func (o *botCreateOutput) GetStatus() int { return o.Status }

type botListOutput struct {
	Status int
	Body   struct {
		OK     bool                     `json:"ok"`
		Result []service.BotManagedView `json:"result"`
	}
}

func (o *botListOutput) GetStatus() int { return o.Status }

type botTokenInput struct {
	Username string `path:"username"`
}

type botTokenOutput struct {
	Status int
	Body   struct {
		OK    bool   `json:"ok"`
		Token string `json:"token"`
	}
}

func (o *botTokenOutput) GetStatus() int { return o.Status }

type botMessageDTO struct {
	MessageID        string                      `json:"message_id"` //nolint:tagliatelle // Bot API uses snake_case
	ChatID           string                      `json:"chat_id"`    //nolint:tagliatelle // Bot API uses snake_case
	From             botMessageUser              `json:"from"`
	Text             string                      `json:"text"`
	Encrypted        bool                        `json:"encrypted,omitempty"`
	EncryptedPayload string                      `json:"encrypted_payload,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
	Date             time.Time                   `json:"date"`
	ReplyMarkup      *model.InlineKeyboardMarkup `json:"reply_markup,omitempty"` //nolint:tagliatelle // Bot API uses snake_case
}

type botMessageUser struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"display_name"`    //nolint:tagliatelle // Bot API uses snake_case
	IsBot          bool   `json:"is_bot"`          //nolint:tagliatelle // Bot API uses snake_case
	EncryptionMode string `json:"encryption_mode"` //nolint:tagliatelle // Bot API uses snake_case
}

func botMessageDTOFrom(msg *model.Message, user *model.User) *botMessageDTO {
	return &botMessageDTO{
		MessageID: msg.ID, ChatID: msg.ChatID,
		From: botMessageUser{ID: user.ID, Username: user.Username, DisplayName: user.DisplayName, IsBot: true},
		Text: msg.Text, Encrypted: msg.Encrypted, EncryptedPayload: msg.EncryptedPayload,
		Date: msg.CreatedAt, ReplyMarkup: msg.ReplyMarkup,
	}
}

type botEncryptionInput struct {
	Body struct {
		PublicKey string `json:"publicKey"`
	}
}

type botUserKeysInput struct {
	Body struct {
		UserID string `json:"userId"`
	}
}

type botUserKeysOutput struct {
	Status int
	Body   struct {
		OK     bool                `json:"ok"`
		Result []service.DeviceKey `json:"result"`
	}
}

func (o *botUserKeysOutput) GetStatus() int { return o.Status }

type botChatInput struct {
	Body struct {
		ChatID string `json:"chat_id"` //nolint:tagliatelle // Bot API uses snake_case
	}
}

type botChatOutput struct {
	Status int
	Body   struct {
		OK     bool                `json:"ok"`
		Result service.BotChatInfo `json:"result"`
	}
}

func (o *botChatOutput) GetStatus() int { return o.Status }

type botChatActionInput struct {
	Body struct {
		ChatID string `json:"chat_id"` //nolint:tagliatelle // Bot API uses snake_case
		Action string `json:"action"`
	}
}
