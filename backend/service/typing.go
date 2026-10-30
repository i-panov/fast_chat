package service

import (
	"context"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
)

const (
	// TypingThrottleInterval bounds how often a user may emit an active typing
	// indicator to avoid flooding the realtime channel.
	TypingThrottleInterval = 2 * time.Second
)

// nowFunc is the clock used for typing throttling; overridden in tests.
var nowFunc = time.Now

// HandleTyping processes a typing indicator: it applies the throttle window,
// records the activity, and fans out the event to every chat member except the
// originating user. The transport is responsible for propagating the event to
// remote federation peers. Returns true when the indicator was throttled
// (suppressed).
func (s *Service) HandleTyping(
	_ context.Context,
	chat *model.Chat,
	chatID,
	userID,
	nick string,
	active bool,
) bool {

	if active {
		key := chatID + ":" + userID
		if s.hub != nil {
			now := nowFunc()
			if last, ok := s.hub.LoadLastTyping(key); ok {
				if t, ok := last.(time.Time); ok && now.Sub(t) < TypingThrottleInterval {
					return true
				}
			}

			s.hub.StoreLastTyping(key, now)
		}
	}

	s.broadcastTyping(chat, userID, nick, active)

	return false
}

// broadcastTyping fans out a typing indicator to every chat member except the
// originating user.
func (s *Service) broadcastTyping(
	chat *model.Chat,
	userID,
	nick string,
	active bool,
) {

	eventName := federationEventTypingStop
	if active {
		eventName = federationEventTyping
	}

	payload := map[string]string{
		keyChatID: chat.ID,
		keyUserID: userID,
	}

	if active && nick != "" {
		payload["nick"] = nick
	}

	event := sse.Event{Event: eventName, Data: payload}

	for _, memberID := range chat.Members {
		if memberID != userID {
			s.sendEvent(memberID, event)
		}
	}
}
