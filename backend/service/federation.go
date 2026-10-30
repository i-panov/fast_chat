package service

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
)

// Federation domain errors. Handlers map a specific error to an HTTP status and
// a stable user-facing message; the service never depends on the transport.
var (
	ErrFederatedChatMembers     = errors.New("federated chat must have exactly 2 members")
	ErrFederatedMembersNotValid = errors.New("members must belong to federation endpoints")
	ErrFederatedFromNotRemote   = errors.New("fromId does not belong to remote server")
	ErrFederatedAuthorNotRemote = errors.New("message author does not belong to remote server")
	ErrFederatedIDRequired      = errors.New("id is required")
)

const (
	// federatedChatMembers is the required number of members in a federated
	// chat: exactly one local and one remote.
	federatedChatMembers = 2
	// MinSearchRunes is the minimum query length for user search. It is the
	// single source of truth for both local and federated search.
	MinSearchRunes = 2
	// typing event names for federation fan-out.
	federationEventTyping     = "typing"
	federationEventTypingStop = "typing_stop"
)

// UserIDBelongsToServer reports whether userID is a federated ID whose domain
// suffix matches serverDomain. The domain starts after the FIRST colon so
// that host:port domains ("nick:localhost:8080") parse consistently with
// RemoteServerFromID.
func UserIDBelongsToServer(userID, serverDomain string) bool {
	idx := strings.Index(userID, ":")
	if idx < 0 || idx == len(userID)-1 {
		return false
	}

	return userID[idx+1:] == serverDomain
}

// FederatedChatMembersValid checks that exactly one member belongs to the
// remote server and the other to the local server.
func FederatedChatMembersValid(members []string, remoteServer, localServer string) bool {
	if remoteServer == "" || localServer == "" {
		return false
	}

	remoteCount := 0
	localCount := 0

	for _, m := range members {
		switch {
		case UserIDBelongsToServer(m, remoteServer):
			remoteCount++
		case UserIDBelongsToServer(m, localServer):
			localCount++
		default:
			return false
		}
	}

	return remoteCount == 1 && localCount == 1
}

// ValidFileIDs filters fileIDs to those that exist in the store. Used by
// federated edits to resolve explicit remote file references.
func (s *Service) ValidFileIDs(ctx context.Context, fileIDs []string) []string {
	valid := make([]string, 0, len(fileIDs))

	for _, fid := range fileIDs {
		if _, err := s.store.GetFile(ctx, fid); err == nil {
			valid = append(valid, fid)
		}
	}

	return valid
}

// validFileIDsForMembers filters fileIDs down to the files uploaded by one of
// the given members. A federated peer may only reference files that belong to
// the conversation: an id that leaked from another chat must not turn into a
// way to attach somebody else's upload to a federated message.
func (s *Service) validFileIDsForMembers(ctx context.Context, members, fileIDs []string) []string {
	owners := make(map[string]struct{}, len(members))
	for _, member := range members {
		owners[member] = struct{}{}
	}

	valid := make([]string, 0, len(fileIDs))

	for _, fid := range fileIDs {
		file, err := s.store.GetFile(ctx, fid)
		if err != nil {
			continue
		}

		if _, ok := owners[file.UploadedBy]; ok {
			valid = append(valid, fid)
		}
	}

	return valid
}

// CreateFederatedChat creates a chat on behalf of a remote server after
// validating membership constraints. Returns the enriched view, and true if it
// already existed (idempotent). When alreadyExists is true the view is zero.
func (s *Service) CreateFederatedChat(
	ctx context.Context,
	chatID string,
	members []string,
	remoteServer,
	localServer string,
) (ChatView, bool, error) {

	if len(members) != federatedChatMembers {
		return ChatView{}, false, ErrFederatedChatMembers
	}

	if !FederatedChatMembersValid(members, remoteServer, localServer) {
		return ChatView{}, false, ErrFederatedMembersNotValid
	}

	if _, ok := s.store.GetChat(ctx, chatID); ok {
		return ChatView{}, true, nil
	}

	chat := &model.Chat{
		ID:           chatID,
		Members:      members,
		CreatedAt:    time.Now().UTC(),
		RemoteServer: remoteServer,
	}

	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		return ChatView{}, false, err
	}

	// Realtime fan-out is part of this use case (pre-migration parity): every local
	// member must learn about the chat over SSE without waiting for a sync.
	enriched := s.EnrichChat(ctx, chat)
	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatCreated, Data: enriched})
	}

	return enriched, false, nil
}

// SearchFederatedUsers returns the public users matching query for a remote
// server, enforcing the minimum query length. Returns a non-nil slice.
func (s *Service) SearchFederatedUsers(ctx context.Context, query string) []model.PublicUser {
	if utf8.RuneCountInString(strings.TrimSpace(query)) < MinSearchRunes {
		return []model.PublicUser{}
	}

	users := s.store.SearchUsers(ctx, query, "")
	if users == nil {
		return []model.PublicUser{}
	}

	return users
}

// FederatedInboundMessage carries the decoded, validated fields of an inbound
// federated message request before persistence.
type FederatedInboundMessage struct {
	ID               string
	FromID           string
	FromNick         string
	Text             string
	ReplyToID        string
	ThreadID         string
	Location         *model.Location
	Encrypted        bool
	EncryptedPayload string
}

// SendFederatedMessage validates and persists an inbound federated message,
// enriching the reply snapshot, and fans out the new-message event. Returns
// the stored message for the transport response.
func (s *Service) SendFederatedMessage(
	ctx context.Context,
	chat *model.Chat,
	in *FederatedInboundMessage,
	maxLen int,
) (*model.Message, error) {

	if err := ValidateEncryptedPayload(in.Encrypted, in.EncryptedPayload); err != nil {
		return nil, err
	}

	if !UserIDBelongsToServer(in.FromID, chat.RemoteServer) {
		return nil, ErrFederatedFromNotRemote
	}

	if in.ID == "" {
		return nil, ErrFederatedIDRequired
	}

	in.Text = strings.TrimSpace(in.Text)
	// Parity with local sends: an empty text is fine when a location is
	// attached. Files are not carried over federation (the peer has no way to
	// fetch them), so location is the only attachment that exempts the text.
	if in.Text == "" && in.Location == nil {
		return nil, ErrEmptyMessage
	}

	if utf8.RuneCountInString(in.Text) > maxLen {
		return nil, ErrMessageTooLong
	}

	if in.Location != nil && !ValidCoords(in.Location.Lat, in.Location.Lng) {
		return nil, ErrInvalidCoordinates
	}

	msg := &model.Message{
		ID:               in.ID,
		ChatID:           chat.ID,
		ThreadID:         in.ThreadID,
		FromID:           in.FromID,
		FromNick:         in.FromNick,
		Text:             in.Text,
		Encrypted:        in.Encrypted,
		EncryptedPayload: in.EncryptedPayload,
		CreatedAt:        time.Now().UTC(),
		Location:         in.Location,
	}

	if in.ReplyToID != "" {
		if parent, err := s.store.GetMessage(ctx, chat.ID, in.ReplyToID); err == nil {
			msg.ReplyTo = &model.ReplyToInfo{
				MessageID: in.ReplyToID,
				Text:      parent.Text,
				FromNick:  parent.FromNick,
				Files:     s.store.GetMessageFilesForReply(ctx, parent.ID),
				Location:  parent.Location,
			}
		}
	}

	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		return nil, err
	}

	if msg.ThreadID != "" {
		eventData := map[string]any{keyThreadID: msg.ThreadID, keyMessage: msg}
		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventThreadMessageNew, Data: eventData})
		}
	} else {
		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventNewMessage, Data: msg})
		}
	}

	return msg, nil
}

// EditFederatedMessage validates and applies an inbound federated edit, fans
// out the update event, and returns the updated message view for the response.
func (s *Service) EditFederatedMessage(
	ctx context.Context,
	chat *model.Chat,
	messageID,
	threadID string,
	editReq *DecodedEditRequest,
	editTTL int,
) (*model.Message, error) {

	stored, err := s.store.GetMessage(ctx, chat.ID, messageID)
	if err != nil {
		return nil, ErrMessageNotFound
	}

	if !UserIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		return nil, ErrFederatedAuthorNotRemote
	}

	if editTTL < 0 {
		return nil, ErrEditingNotAllowed
	}

	if editTTL > 0 && time.Since(stored.CreatedAt) > time.Duration(editTTL)*time.Second {
		return nil, ErrEditWindowExpired
	}

	edit, err := ParseEditPayload(editReq, stored.Encrypted, stored.EncryptedPayload)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()

	if err := s.store.EditRawMessage(
		ctx, chat.ID, messageID, edit.Text, now,
		edit.Location, edit.ClearLocation, edit.EncryptedPtr, edit.EncryptedPayloadPtr,
	); err != nil {
		return nil, err
	}

	if edit.FileIDs != nil {
		// Note: fileHashes (plaintext hash → file ID resolution) is not
		// supported for federated edits. Remote servers send explicit fileIDs
		// via ValidFileIDs. This is intentional: federation trust boundaries
		// require explicit file references, not hash-based dedup.
		// A non-nil (possibly empty) list replaces the attachments, so an
		// empty list clears them.
		validIDs := s.validFileIDsForMembers(ctx, chat.Members, edit.FileIDs)

		if err := s.store.SetMessageFiles(ctx, messageID, validIDs); err != nil {
			log().Info("federated edit: failed to set message files", "err", err)
		}
	}

	// Re-read the row so the response carries the full state (reply context,
	// files, thread, location) instead of a hand-built subset that the client
	// would merge over its cached message.
	updated, gerr := s.store.GetMessage(ctx, chat.ID, messageID)
	if gerr != nil {
		return nil, gerr
	}

	files, _ := s.store.GetMessageFiles(ctx, messageID) //nolint:errcheck // best-effort: failure is not actionable
	updated.Files = files

	if threadID != "" {
		eventData := map[string]any{
			keyThreadID: threadID,
			keyMessage:  &updated,
		}

		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventThreadMessageUpd, Data: eventData})
		}
	} else {
		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventMessageUpdated, Data: &updated})
		}
	}

	return &updated, nil
}

// DeleteFederatedMessage validates and applies an inbound federated deletion,
// fans out the tombstone, and returns the chat/message IDs for the response.
func (s *Service) DeleteFederatedMessage(
	ctx context.Context,
	chat *model.Chat,
	messageID string,
	deleteTTL int,
) error {

	stored, err := s.store.GetMessage(ctx, chat.ID, messageID)
	if err != nil {
		return ErrMessageNotFound
	}

	if !UserIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		return ErrFederatedAuthorNotRemote
	}

	if deleteTTL < 0 {
		return ErrDeletingNotAllowed
	}

	if deleteTTL > 0 && time.Since(stored.CreatedAt) > time.Duration(deleteTTL)*time.Second {
		return ErrDeleteWindowExpired
	}

	if err := s.store.DeleteRawMessage(ctx, chat.ID, messageID); err != nil {
		return err
	}

	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventMessageDeleted, Data: map[string]string{keyChatID: chat.ID, keyMessageID: messageID}})
	}

	return nil
}

// HandleFederatedTyping fans out an inbound typing indicator to every chat
// member except the originating user.
func (s *Service) HandleFederatedTyping(
	_ context.Context,
	chat *model.Chat,
	userID,
	nick string,
	active bool,
) {

	s.broadcastTyping(chat, userID, nick, active)
}

// SyncFederatedResponse is the shape of the federation catchup response.
type SyncFederatedResponse struct {
	ServerNow       time.Time              `json:"serverNow"`
	Chats           []FederatedChatDTO     `json:"chats"`
	Messages        []model.Message        `json:"messages"`
	ThreadMessages  []model.Message        `json:"threadMessages"`
	DeletedMessages []model.DeletedMessage `json:"deletedMessages"`
	// NextSince continues the delta, same contract as SyncResponse.
	NextSince   string `json:"nextSince,omitempty"`
	NextSinceID string `json:"nextSinceId,omitempty"`
}

// FederatedChatDTO describes a chat that a peer shares with this server. The
// peer is authoritative for it, so a server that missed the creation of the
// chat can rebuild it from the catch-up response.
type FederatedChatDTO struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"ownerId"`
	Members   []string  `json:"members"`
	CreatedAt time.Time `json:"createdAt"`
}

// SyncFederated returns the messages and deleted messages changed since the
// given timestamp for all chats shared with the remote server.
func (s *Service) SyncFederated(
	ctx context.Context,
	serverDomain string,
	since time.Time,
	sinceID string,
	limit int,
) (SyncFederatedResponse, error) {

	fedChatIDs := s.store.GetFederatedChatIDs(ctx, serverDomain)

	msgPage, err := s.store.MessagesChangedSince(ctx, fedChatIDs, since, sinceID, limit)
	if err != nil {
		return SyncFederatedResponse{}, err
	}
	threadPage, err := s.store.ThreadMessagesChangedSince(ctx, fedChatIDs, since, sinceID, limit)
	if err != nil {
		return SyncFederatedResponse{}, err
	}
	deletedPage, err := s.store.DeletedMessagesSince(ctx, fedChatIDs, since, sinceID, limit)
	if err != nil {
		return SyncFederatedResponse{}, err
	}

	msgs := msgPage.Rows
	if msgs == nil {
		msgs = []model.Message{}
	}

	threadMsgs := threadPage.Rows
	if threadMsgs == nil {
		threadMsgs = []model.Message{}
	}

	deleted := deletedPage.Rows
	if deleted == nil {
		deleted = []model.DeletedMessage{}
	}

	nextSince, nextSinceID := nextSyncCursor(
		cursorPage{msgPage.NextSince, msgPage.NextID, msgPage.HasMore},
		cursorPage{threadPage.NextSince, threadPage.NextID, threadPage.HasMore},
		cursorPage{deletedPage.NextSince, deletedPage.NextID, deletedPage.HasMore},
	)

	return SyncFederatedResponse{
		ServerNow:       time.Now().UTC(),
		Chats:           s.federatedChats(ctx, fedChatIDs),
		Messages:        msgs,
		ThreadMessages:  threadMsgs,
		DeletedMessages: deleted,
		NextSince:       nextSince,
		NextSinceID:     nextSinceID,
	}, nil
}

// federatedChats describes the chats a peer shares with this server.
func (s *Service) federatedChats(ctx context.Context, chatIDs []string) []FederatedChatDTO {
	if len(chatIDs) == 0 {
		return []FederatedChatDTO{}
	}

	chats, err := s.store.GetChatsByIDs(ctx, chatIDs)
	if err != nil {
		log().Warn("federated chats could not be loaded", "err", err)
		return []FederatedChatDTO{}
	}

	out := make([]FederatedChatDTO, 0, len(chats))
	for idx := range chats {
		out = append(out, FederatedChatDTO{
			ID:        chats[idx].ID,
			Type:      chats[idx].Type,
			Name:      chats[idx].Name,
			OwnerID:   chats[idx].OwnerID,
			Members:   chats[idx].Members,
			CreatedAt: chats[idx].CreatedAt,
		})
	}

	return out
}
