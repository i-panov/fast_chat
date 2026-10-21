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

// catchupPeer pulls the delta of one peer and applies it.
func (s *Service) catchupPeer(ctx context.Context, peer string) {
	since := s.store.GetFederationCursor(ctx, peer)

	syncURL := s.fed.URL(peer, "/api/federated/sync?since="+url.QueryEscape(since.Format(time.RFC3339)))

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

	s.applyFederatedDelta(ctx, peer, &delta)

	// The cursor only moves forward: a peer whose clock went backwards must
	// not make this server skip the messages in between.
	if delta.ServerNow.After(since) {
		if err := s.store.SetFederationCursor(ctx, peer, delta.ServerNow); err != nil {
			log().Error("federation cursor could not be stored", "peer", peer, "err", err)
		}
	}
}

// applyFederatedDelta applies the chats, messages and deletions a peer
// reported. Every step is idempotent: the peer may send the same delta
// twice, and the pull may overlap with a message that arrived through the
// outbox.
func (s *Service) applyFederatedDelta(ctx context.Context, peer string, delta *SyncFederatedResponse) {
	for i := range delta.Chats {
		s.ensureRemoteChat(ctx, peer, &delta.Chats[i])
	}

	for i := range delta.Messages {
		msg := &delta.Messages[i]

		// The peer holds the messages of this server too: they are our own
		// messages, echoed back by the catch-up.
		if UserIDBelongsToServer(msg.FromID, s.cfg.Server.Domain) {
			continue
		}

		chat, ok := s.store.GetChat(ctx, msg.ChatID)
		if !ok {
			log().Info("federation message skipped: unknown chat", "peer", peer, "chatID", msg.ChatID)
			continue
		}

		maxLen := MaxMessageLen
		if msg.Encrypted {
			maxLen = EncryptedMaxLen
		}

		// The attachments are not part of the delta: the peer does not have
		// the file, so there is nothing to carry. The message arrives
		// without them.
		in := &FederatedInboundMessage{
			ID:               msg.ID,
			FromID:           msg.FromID,
			FromNick:         msg.FromNick,
			Text:             msg.Text,
			Location:         msg.Location,
			Encrypted:        msg.Encrypted,
			EncryptedPayload: msg.EncryptedPayload,
		}

		if _, err := s.SendFederatedMessage(ctx, chat, in, maxLen); err != nil {
			log().Info("federation message could not be applied", "peer", peer, "messageID", msg.ID, "err", err)
		}
	}

	for _, deleted := range delta.DeletedMessages {
		chat, ok := s.store.GetChat(ctx, deleted.ChatID)
		if !ok {
			continue
		}

		// A deletion of a message that is already gone is not an error: the
		// peer and this server may have processed it in a different order.
		err := s.DeleteFederatedMessage(ctx, chat, deleted.MessageID, 0)
		if err != nil && !errorsIsMessageNotFound(err) {
			log().Info("federation deletion could not be applied", "peer", peer, "messageID", deleted.MessageID, "err", err)
		}
	}
}

// ensureRemoteChat creates the chat locally when the peer reports a chat this
// server does not know yet, and keeps the membership of a known chat in sync.
//
// The peer is authoritative for the chat: it holds the conversation on both
// sides. A change of the membership has to reach the local members even when
// the change itself was made while this server was offline.
func (s *Service) ensureRemoteChat(ctx context.Context, peer string, chat *FederatedChatDTO) {
	existing, ok := s.store.GetChat(ctx, chat.ID)
	if ok {
		s.syncRemoteChatMembers(ctx, peer, existing, chat)
		return
	}

	createdAt := chat.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	remote := &model.Chat{
		ID:           chat.ID,
		Type:         chat.Type,
		Name:         chat.Name,
		OwnerID:      chat.OwnerID,
		Members:      chat.Members,
		RemoteServer: peer,
		CreatedAt:    createdAt,
	}

	if err := s.store.CreateRemoteChat(ctx, remote); err != nil {
		log().Warn("federated chat could not be created", "peer", peer, "chatID", chat.ID, "err", err)
		return
	}

	// The local members learn about the chat right away, the same way they
	// learn about a chat the peer created.
	enriched := s.EnrichChat(ctx, remote)
	for _, memberID := range remote.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatCreated, Data: enriched})
	}
}

// syncRemoteChatMembers applies the membership the peer reports to a chat
// this server already knows.
func (s *Service) syncRemoteChatMembers(ctx context.Context, peer string, existing *model.Chat, chat *FederatedChatDTO) {
	// An empty list would empty the chat. The peer always reports its
	// members, so an empty list means that the report is broken: applying it
	// would take the local users out of a chat they are still part of.
	if len(chat.Members) == 0 {
		log().Warn("federated chat without members, membership left untouched", "peer", peer, "chatID", chat.ID)
		return
	}

	if sameMembers(existing.Members, chat.Members) {
		return
	}

	if err := s.store.ReplaceChatMembers(ctx, existing.ID, chat.Members); err != nil {
		log().Warn("federated chat membership could not be updated", "peer", peer, "chatID", chat.ID, "err", err)
		return
	}

	updated, ok := s.store.GetChat(ctx, existing.ID)
	if !ok {
		return
	}

	enriched := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: enriched})
	}
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
