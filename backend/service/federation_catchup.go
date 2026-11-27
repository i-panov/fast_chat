package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

// federationSender is the signed server-to-server client the catch-up worker
// uses. It is an interface so the service can be tested without a peer.
type federationSender interface {
	URL(remoteServer, path string) string
	Request(ctx context.Context, method, urlStr string, body any) ([]byte, error)
}

// SetFederationClient attaches the signed client to the service. It is
// called once at startup: the catch-up worker needs it to pull the deltas the
// peers have for this server.
func (s *Service) SetFederationClient(client federationSender) {
	s.fed = client
}

// RunFederationCatchup pulls the deltas the peers have for this server and
// applies them.
//
// It is the second half of the delivery guarantee: the outbox pushes what
// this server has, the catch-up pulls what the peer has. Together they
// cover a peer that was unreachable when the message was written.
func (s *Service) RunFederationCatchup(ctx context.Context, interval time.Duration) {
	if s.fed == nil {
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.catchupOnce(ctx)
		}
	}
}

// catchupOnce polls every peer this server has a chat with.
func (s *Service) catchupOnce(ctx context.Context) {
	servers, err := s.store.GetFederatedServers(ctx)
	if err != nil {
		log().Error("federation peers could not be listed", "err", err)
		return
	}

	for _, peer := range servers {
		s.catchupPeer(ctx, peer)
	}
}

// maxCatchupRounds bounds one peer's catch-up: a peer receiving live
// writes could otherwise keep every page full forever. The cursor below
// always points at undelivered data, so the remainder arrives next tick.
const maxCatchupRounds = 50

// catchupPeer pulls the peer's delta page by page and applies it. Pages
// are applied as they arrive (bounded memory); the cursor advances to
// ServerNow only on a complete drain, otherwise to the pending NextSince
// so nothing is skipped.
func (s *Service) catchupPeer(ctx context.Context, peer string) {
	since := s.store.GetFederationCursor(ctx, peer)
	cursor := since
	cursorID := ""

	for round := 0; ; round++ {
		syncURL := s.fed.URL(peer, "/api/federated/sync?since="+url.QueryEscape(cursor.Format(time.RFC3339))+"&sinceId="+url.QueryEscape(cursorID))

		data, err := s.fed.Request(ctx, http.MethodGet, syncURL, nil)
		if err != nil {
			log().Info("federation catch-up failed", "peer", peer, "err", err)
			return
		}

		var delta SyncFederatedResponse
		if err := json.Unmarshal(data, &delta); err != nil {
			log().Warn("federation catch-up response could not be parsed", "peer", peer, "err", err)
			return
		}

		// Do not advance the cursor past a page that did not fully apply.
		// Applied rows are idempotent, so the next tick retries the page.
		if !s.applyFederatedDelta(ctx, peer, &delta) {
			log().Warn("federation catch-up page could not be fully applied", "peer", peer)
			break
		}

		if delta.NextSince == "" || round+1 >= maxCatchupRounds {
			if delta.NextSince != "" {
				// Drained the round budget with more pending: park the
				// cursor at the continuation instead of ServerNow so the
				// remainder is picked up next tick. The id tiebreaker
				// does not persist across ticks (documented above), so
				// only the time part carries over.
				if next, err := time.Parse(time.RFC3339, delta.NextSince); err == nil {
					cursor = next
				} else {
					cursor = delta.ServerNow
				}
			} else {
				cursor = delta.ServerNow
			}
			break
		}

		next, err := time.Parse(time.RFC3339, delta.NextSince)
		if err != nil {
			log().Warn("federation catch-up next cursor could not be parsed", "peer", peer, "err", err)
			cursor = delta.ServerNow
			break
		}
		cursor = next
		cursorID = delta.NextSinceID
	}

	// The cursor only moves forward: a peer whose clock went backwards must
	// not make this server skip the messages in between. The persisted
	// cursor is time-only (the id tiebreaker lives for one drain): resuming
	// across ticks may redeliver the boundary tail, which applyFederatedDelta
	// absorbs idempotently.
	if cursor.After(since) {
		if err := s.store.SetFederationCursor(ctx, peer, cursor); err != nil {
			log().Error("federation cursor could not be stored", "peer", peer, "err", err)
		}
	}
}

// applyFederatedDelta applies the chats, messages and deletions a peer
// reported. Every step is idempotent: the peer may send the same delta
// twice, and the pull may overlap with a message that arrived through the
// outbox.
// applyFederatedDelta reports whether every row in the page was applied (or
// deliberately skipped as non-retryable). A false result keeps the catch-up
// cursor before this page so a transient store failure is retried instead of
// losing the rows forever.
func (s *Service) applyFederatedDelta(ctx context.Context, peer string, delta *SyncFederatedResponse) bool {
	applied := true

	for i := range delta.Chats {
		if !s.ensureRemoteChat(ctx, peer, &delta.Chats[i]) {
			applied = false
		}
	}

	for i := range delta.Messages {
		if !s.applyFederatedMessage(ctx, peer, &delta.Messages[i]) {
			applied = false
		}
	}

	for i := range delta.ThreadMessages {
		if !s.applyFederatedMessage(ctx, peer, &delta.ThreadMessages[i]) {
			applied = false
		}
	}

	for i := range delta.Reactions {
		if !s.applyFederatedReaction(ctx, peer, &delta.Reactions[i], true) {
			applied = false
		}
	}

	for i := range delta.ReactionDeletions {
		if !s.applyFederatedReactionDeletion(ctx, peer, &delta.ReactionDeletions[i]) {
			applied = false
		}
	}

	for _, deleted := range delta.DeletedMessages {
		chat, ok := s.store.GetChat(ctx, deleted.ChatID)
		if !ok || chat.RemoteServer != peer {
			continue
		}

		// A deletion of a message that is already gone is not an error: the
		// peer and this server may have processed it in a different order.
		err := s.DeleteFederatedMessage(ctx, chat, deleted.MessageID, 0)
		if err != nil && !errorsIsMessageNotFound(err) && !isPermanentFederationApplyError(err) {
			log().Info("federation deletion could not be applied", "peer", peer, "messageID", deleted.MessageID, "err", err)
			applied = false
		}
	}

	return applied
}

// isPermanentFederationApplyError reports errors that will repeat for this
// row forever. They are skipped so one poisoned message cannot stop the
// peer's whole delta stream; transient failures keep the retry behaviour.
func isPermanentFederationApplyError(err error) bool {
	for _, sentinel := range []error{
		ErrUserBlocked,
		ErrMessageTooLong,
		ErrFederatedFromNotRemote,
		ErrFederatedAuthorNotRemote,
		ErrInvalidCoordinates,
		ErrEmptyMessage,
		ErrFederatedIDRequired,
		ErrBotEncryptionRequired,
		ErrBotEncryptionForbidden,
		ErrBotMarkupInvalid,
		ErrInvalidReaction,
		ErrMessageNotFound,
		ErrDeleteWindowExpired,
		ErrDeletingNotAllowed,
		ErrMissingEncryptedPayload,
		ErrEncryptedPayloadTooLarge,
		ErrInvalidEncryptedPayload,
		ErrUnsupportedPayloadVersion,
		ErrInvalidNonce,
		ErrInvalidBox,
		ErrMissingEnvelopes,
		ErrEmptyKeyID,
		store.ErrMessageIDConflict,
	} {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// applyFederatedReaction applies a live reaction from a peer delta.
func (s *Service) applyFederatedReaction(
	ctx context.Context,
	peer string,
	reaction *model.MessageReaction,
	add bool,
) bool {

	return s.applyFederatedReactionChange(
		ctx, peer, reaction.MessageID, reaction.UserID, reaction.Emoji, add, reaction.CreatedAt,
	)
}

// applyFederatedReactionDeletion applies a reaction tombstone from a peer.
func (s *Service) applyFederatedReactionDeletion(
	ctx context.Context,
	peer string,
	deletion *model.ReactionDeletion,
) bool {

	return s.applyFederatedReactionChange(
		ctx, peer, deletion.MessageID, deletion.UserID, deletion.Emoji, false, deletion.RemovedAt,
	)
}

// applyFederatedReactionChange is the shared body of the add and remove
// application paths. A message that is already gone (deleted before the
// catch-up) is skipped: the reaction has no visible target left.
func (s *Service) applyFederatedReactionChange(
	ctx context.Context,
	peer, messageID, userID, emoji string,
	add bool,
	at time.Time,
) bool {

	msg, err := s.store.GetMessageByID(ctx, messageID)
	if err != nil {
		return true
	}
	chat, ok := s.store.GetChat(ctx, msg.ChatID)
	if !ok || (chat.RemoteServer != "" && chat.RemoteServer != peer) {
		return true
	}
	if !containsMember(chat.Members, userID) {
		return true
	}
	// A locally owned chat has no RemoteServer: only the peer that owns the
	// actor may report that actor's reaction. Without this a peer could
	// forge or delete reactions of local users.
	if chat.RemoteServer == "" && !UserIDBelongsToServer(userID, peer) {
		log().Info("federation reaction skipped: author belongs to another server",
			"peer", peer, "userID", userID)
		return true
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	if _, err := s.ApplyFederatedReaction(ctx, chat, messageID, userID, emoji, add, at); err != nil {
		log().Info("federation reaction could not be applied", "peer", peer, "messageID", messageID, "err", err)
		return false
	}

	return true
}

// applyFederatedMessage applies a single chat or thread message a peer
// reported. Reply context travels with the delta: SendFederatedMessage
// re-validates that the parent lives in the same chat.
func (s *Service) applyFederatedMessage(ctx context.Context, peer string, msg *model.Message) bool {
	// The peer holds the messages of this server too: they are our own
	// messages, echoed back by the catch-up.
	if UserIDBelongsToServer(msg.FromID, s.cfg.Server.Domain) {
		return true
	}

	chat, ok := s.store.GetChat(ctx, msg.ChatID)
	if !ok || chat.RemoteServer != peer {
		log().Info("federation message skipped: foreign chat", "peer", peer, "chatID", msg.ChatID)
		return true
	}
	if !containsMember(chat.Members, msg.FromID) {
		log().Info("federation message skipped: author is not a member", "peer", peer, "from", msg.FromID)
		return true
	}

	maxLen := MaxMessageLen
	if msg.Encrypted {
		maxLen = EncryptedMaxLen
	}

	var replyToID string
	if msg.ReplyTo != nil {
		replyToID = msg.ReplyTo.MessageID
	}

	// The attachments are not part of the delta: the peer does not have
	// the file, so there is nothing to carry. The message arrives
	// without them.
	in := &FederatedInboundMessage{
		ID:       msg.ID,
		FromID:   msg.FromID,
		FromNick: msg.FromNick,
		Text:     msg.Text,
		// The delta carries the source timestamp; using the application time
		// would reorder a backlog into one "now" block and extend edit/delete
		// windows for old messages.
		CreatedAt:        msg.CreatedAt,
		ReplyToID:        replyToID,
		ThreadID:         msg.ThreadID,
		Location:         msg.Location,
		Encrypted:        msg.Encrypted,
		EncryptedPayload: msg.EncryptedPayload,
		Files:            msg.Files,
	}

	in.Peer = peer
	if _, err := s.SendFederatedMessage(ctx, chat, in, maxLen); err != nil {
		log().Info("federation message could not be applied", "peer", peer, "messageID", msg.ID, "err", err)
		// A permanent rejection of this row must not wedge the cursor for
		// the whole peer. Skipping the row keeps every other chat flowing.
		return isPermanentFederationApplyError(err)
	}

	return true
}

// ensureRemoteChat creates the chat locally when the peer reports a chat this
// server does not know yet, and keeps the membership of a known chat in sync.
//
// The peer is authoritative for the chat: it holds the conversation on both
// sides. A change of the membership has to reach the local members even when
// the change itself was made while this server was offline.
func (s *Service) ensureRemoteChat(ctx context.Context, peer string, chat *FederatedChatDTO) bool {
	if chat.BotID != "" && !containsMember(chat.Members, chat.BotID) {
		log().Warn("federated chat has bot outside members", "chatID", chat.ID)
		return true
	}
	mode := chat.BotEncryptionMode
	if chat.BotID != "" && !UserIDBelongsToServer(chat.BotID, peer) {
		if bot, ok := s.store.GetBot(ctx, chat.BotID); ok {
			mode = bot.EncryptionMode
		}
	}
	existing, ok := s.store.GetChat(ctx, chat.ID)
	if ok {
		if existing.RemoteServer != peer {
			return true
		}

		applied := true
		if chat.BotID != "" && (existing.BotID != chat.BotID || existing.BotEncryptionMode != mode) {
			if err := s.store.SetChatBot(ctx, existing.ID, chat.BotID, mode); err != nil {
				log().Warn("federated bot chat metadata could not be restored", "chatID", chat.ID, "err", err)
				applied = false
			} else {
				existing.BotID = chat.BotID
				existing.BotEncryptionMode = mode
				s.ensureBotChatReplica(ctx, existing)
				view := s.EnrichChat(ctx, existing)
				for _, memberID := range existing.Members {
					s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: view})
				}
			}
		}

		if !s.syncRemoteChatMembers(ctx, peer, existing, chat) {
			applied = false
		}

		return applied
	}

	createdAt := chat.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	remote := &model.Chat{
		ID:                chat.ID,
		Type:              chat.Type,
		Name:              chat.Name,
		OwnerID:           chat.OwnerID,
		Members:           chat.Members,
		RemoteServer:      peer,
		BotID:             chat.BotID,
		BotEncryptionMode: mode,
		CreatedAt:         createdAt,
	}

	if err := s.store.CreateRemoteChat(ctx, remote); err != nil {
		log().Warn("federated chat could not be created", "peer", peer, "chatID", chat.ID, "err", err)
		return false
	}
	s.ensureBotChatReplica(ctx, remote)

	// The local members learn about the chat right away, the same way they
	// learn about a chat the peer created.
	enriched := s.EnrichChat(ctx, remote)
	for _, memberID := range remote.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatCreated, Data: enriched})
	}

	return true
}

// ensureBotChatReplica restores the local bot lookup when a federated chat
// replica carries bot metadata after a catch-up.
func (s *Service) ensureBotChatReplica(ctx context.Context, chat *model.Chat) {
	if chat.BotID == "" {
		return
	}
	if _, ok := s.store.GetBot(ctx, chat.BotID); !ok {
		return
	}
	for _, memberID := range chat.Members {
		if memberID == chat.BotID {
			continue
		}
		if err := s.store.CreateBotChat(ctx, chat.BotID, memberID, chat.ID); err != nil {
			log().Warn("federated bot chat replica could not be created", "chatID", chat.ID, "err", err)
		}
	}
}

// syncRemoteChatMembers applies the membership the peer reports to a chat
// this server already knows.
func (s *Service) syncRemoteChatMembers(ctx context.Context, peer string, existing *model.Chat, chat *FederatedChatDTO) bool {
	// An empty list would empty the chat. The peer always reports its
	// members, so an empty list means that the report is broken: applying it
	// would take the local users out of a chat they are still part of.
	if len(chat.Members) == 0 {
		log().Warn("federated chat without members, membership left untouched", "peer", peer, "chatID", chat.ID)
		return true
	}

	if sameMembers(existing.Members, chat.Members) {
		return true
	}

	if err := s.store.ReplaceChatMembers(ctx, existing.ID, chat.Members); err != nil {
		log().Warn("federated chat membership could not be updated", "peer", peer, "chatID", chat.ID, "err", err)
		return false
	}

	updated, ok := s.store.GetChat(ctx, existing.ID)
	if !ok {
		return true
	}

	enriched := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: enriched})
	}

	// Members the peer dropped learn about it right away instead of seeing a
	// stale chat until the next resync.
	reported := make(map[string]struct{}, len(chat.Members))
	for _, memberID := range chat.Members {
		reported[memberID] = struct{}{}
	}

	for _, memberID := range existing.Members {
		if _, ok := reported[memberID]; !ok {
			s.sendEvent(memberID, sse.Event{Event: eventChatDeleted, Data: map[string]string{keyChatID: existing.ID}})
		}
	}

	return true
}

// sameMembers reports whether two member lists hold the same users.
func sameMembers(current, reported []string) bool {
	if len(current) != len(reported) {
		return false
	}

	set := make(map[string]struct{}, len(current))
	for _, id := range current {
		set[id] = struct{}{}
	}

	for _, id := range reported {
		if _, ok := set[id]; !ok {
			return false
		}
	}

	return true
}

// errorsIsMessageNotFound reports whether the error says that the message is
// gone, which is the expected state for a repeated deletion.
func errorsIsMessageNotFound(err error) bool {
	return errors.Is(err, ErrMessageNotFound)
}
