package service

import (
	"context"
	"time"

	"fast_chat/model"
)

const (
	// BotOnlineWindow is how long an external bot stays online after its last
	// Bot API request. A bot that runs the usual getUpdates long poll touches
	// this at least every poll timeout, so a live listener never goes grey.
	BotOnlineWindow = 5 * time.Minute
	// MaxBotPollTimeout keeps one long poll shorter than the presence
	// window: a live bot must touch the API again before it can expire.
	MaxBotPollTimeout = 2 * time.Minute
)

// TouchBotActivity records a Bot API request and, on the transition,
// announces the bot as online. The state change and its event are emitted
// under botPresenceMu together with ExpireInactiveBots: ordering the events
// the same way as the state is what keeps a live bot from being shown
// offline by a sweep that raced its last touch.
func (s *Service) TouchBotActivity(ctx context.Context, bot *model.Bot) {
	if bot.IsMaster {
		// The root bot runs inside this process: it is online exactly while
		// the server is, regardless of Bot API calls.
		s.store.SetPresence(bot.UserID, true)

		return
	}

	s.botPresenceMu.Lock()
	defer s.botPresenceMu.Unlock()

	s.botLastSeen[bot.UserID] = time.Now().UTC()
	if s.store.SetPresence(bot.UserID, true) {
		s.BroadcastUserStatus(ctx, bot.UserID, true)
	}
}

// ExpireInactiveBots moves external bots that have not called the Bot API for
// the whole window to offline and tells their chats. The root bot is not in
// the map and is never expired.
func (s *Service) ExpireInactiveBots(ctx context.Context, now time.Time, window time.Duration) {
	// The state transition and its event belong to one critical section, so
	// a concurrent TouchBotActivity is serialised behind the whole sweep:
	// a live bot's online event can never be followed by a stale offline
	// one from a sweep that caught it mid-request.
	s.botPresenceMu.Lock()
	defer s.botPresenceMu.Unlock()

	for botID, lastSeen := range s.botLastSeen {
		if now.Sub(lastSeen) < window {
			continue
		}

		delete(s.botLastSeen, botID)
		if s.store.SetPresence(botID, false) {
			s.BroadcastUserStatus(ctx, botID, false)
		}
	}
}

// RunBotPresence sweeps expired bots until the context is cancelled.
func (s *Service) RunBotPresence(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.ExpireInactiveBots(ctx, now.UTC(), BotOnlineWindow)
		}
	}
}
