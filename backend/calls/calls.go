// Package calls keeps the state of the ongoing calls in memory. The package
// knows nothing about HTTP or the database: the rules live in the service
// layer, the transport only maps HTTP to the service.
package calls

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"fast_chat/internal/ids"
)

type State string

const (
	StateRinging State = "ringing"
	StateActive  State = "active"
	StateEnded   State = "ended"
)

// Reasons a call can end with. Only the server sets timeout and rejected;
// hangup and peer-left come from the client, and only peer-left is accepted
// from the request body (see the service layer).
const (
	ReasonHangup   = "hangup"
	ReasonRejected = "rejected"
	ReasonTimeout  = "timeout"
	ReasonPeerLeft = "peer-left"
)

const (
	// RingingTimeout is how long the callee has to answer.
	RingingTimeout = 45 * time.Second
	// ActiveTTL is the hard limit for an active call. It is the safety net
	// for a call whose participants never came back.
	ActiveTTL = 4 * time.Hour
	// EndedTTL is how long an ended call is kept, so a client that returns
	// later can still learn the final state of the call.
	EndedTTL = 10 * time.Minute
	// OfflineGrace is how long a participant may stay offline before the
	// call ends. A short gap is a network drop: the peer connection does
	// not depend on the server, so the media keeps flowing and the client
	// reconnects. A client that is gone for good (a crash, a closed tab)
	// must not hold the call, and the other side, until ActiveTTL.
	OfflineGrace = time.Minute
)

// Signaling size caps: the SDP and ICE payloads are stored in the registry
// and fanned out over SSE channels (buffer 128), so one client sending
// megabytes would bloat every fan-out. A real SDP offer/answer is a few
// kilobytes; 32 KiB leaves an order of magnitude of headroom, and a single
// ICE candidate is smaller still.
const (
	MaxOfferLen        = 32 << 10
	MaxAnswerLen       = 32 << 10
	MaxICECandidateLen = 16 << 10
)

var (
	ErrBusy = errors.New("user is already in a call")
	// ErrBusyCaller and ErrBusyCallee name the side of the call that is
	// busy: the client tells its own call from the call of the peer, and a
	// user cannot be busy in both roles at once.
	ErrBusyCaller = fmt.Errorf("%w as the caller", ErrBusy)
	ErrBusyCallee = fmt.Errorf("%w as the callee", ErrBusy)
	ErrNotFound   = errors.New("call not found")
	ErrNotRinging = errors.New("call is not ringing")
	ErrEnded      = errors.New("call is already ended")
	ErrExpired    = errors.New("call was not answered in time")
	// ErrOfferTooLarge, ErrAnswerTooLarge and ErrICECandidateTooLarge bound
	// the signaling payloads a client may store or fan out.
	ErrOfferTooLarge        = errors.New("call offer is too large")
	ErrAnswerTooLarge       = errors.New("call answer is too large")
	ErrICECandidateTooLarge = errors.New("ICE candidate is too large")
	ErrEmptyAnswer          = errors.New("call answer is empty")
)

// Call is one conversation. The SDP is kept only while it can still be used:
// the offer until the call is accepted, the answer until it ends.
type Call struct {
	ID        string
	CallerID  string
	CalleeID  string
	ChatID    string
	State     State
	Offer     string
	Answer    string
	CreatedAt time.Time
	ExpiresAt time.Time
	EndedAt   time.Time
	Reason    string
}

// Participant reports whether the user takes part in the call.
func (c *Call) Participant(userID string) bool {
	return c.CallerID == userID || c.CalleeID == userID
}

// Peer returns the other side of the call.
func (c *Call) Peer(userID string) string {
	if c.CallerID == userID {
		return c.CalleeID
	}

	return c.CallerID
}

// Manager is the registry of calls. Every operation that changes the state
// runs under one lock, so a busy check and the change it guards cannot be
// interleaved.
//
// The registry hands out a copy of a call, never the pointer it keeps: the
// callers read the fields of a call without the lock, and the registry writes
// them under the lock.
type Manager struct {
	mu           sync.Mutex
	calls        map[string]*Call
	active       map[string]string // userID -> callID
	recent       map[string]string // userID -> last ended callID
	offlineSince func(userID string) time.Time
	onEnded      func(call Call, reason string)
	timers       map[string]*time.Timer
	now          func() time.Time
	// ringingTimeout is how long the callee has to answer. It is a field and
	// not a constant, so the tests do not have to wait for the real window.
	ringingTimeout time.Duration
}

// NewManager builds a registry. offlineSince reports when a user lost the
// last connection; the zero time means the user is connected. The registry
// calls it outside its lock, never while holding it.
func NewManager(offlineSince func(userID string) time.Time) *Manager {
	if offlineSince == nil {
		offlineSince = func(string) time.Time { return time.Time{} }
	}

	return &Manager{
		calls:          make(map[string]*Call),
		active:         make(map[string]string),
		recent:         make(map[string]string),
		timers:         make(map[string]*time.Timer),
		offlineSince:   offlineSince,
		now:            time.Now,
		ringingTimeout: RingingTimeout,
	}
}

// SetOnEnded registers the callback that reports the ending of a call.
//
// The registry is the only place that ends a call and the only one that
// reports it: the callback is called for every ending, whoever performed it
// (the service, the timer of the ringing window, the sweep or the shutdown),
// and only for the one that really performed the transition. A call therefore
// ends with exactly one report.
func (m *Manager) SetOnEnded(onEnded func(call Call, reason string)) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.onEnded = onEnded
}

// ValidateOffer reports whether an SDP offer fits the signaling cap.
func ValidateOffer(offer string) error {
	if len(offer) > MaxOfferLen {
		return ErrOfferTooLarge
	}

	return nil
}

// ValidateAnswer reports whether an SDP answer fits the signaling cap.
// Empty answers never carry an SDP: reject them like oversized ones so a
// call cannot go active with nothing for the caller to apply.
func ValidateAnswer(answer string) error {
	if answer == "" {
		return ErrEmptyAnswer
	}
	if len(answer) > MaxAnswerLen {
		return ErrAnswerTooLarge
	}

	return nil
}

// ValidateICECandidate reports whether a raw ICE candidate fits the cap.
// The service layer calls it before fanning the candidate out over SSE: the
// registry never stores candidates, so this is the only bound on them.
func ValidateICECandidate(candidate []byte) error {
	if len(candidate) > MaxICECandidateLen {
		return ErrICECandidateTooLarge
	}

	return nil
}

// CreateCall registers a new call. It fails when either side is already in
// a call, and the error names the side that is busy.
func (m *Manager) CreateCall(callerID, calleeID, chatID, offer string) (*Call, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if err := ValidateOffer(offer); err != nil {
		return nil, err
	}

	if m.active[callerID] != "" {
		return nil, ErrBusyCaller
	}

	if m.active[calleeID] != "" {
		return nil, ErrBusyCallee
	}

	now := m.now()
	call := &Call{
		ID:        ids.Generate(),
		CallerID:  callerID,
		CalleeID:  calleeID,
		ChatID:    chatID,
		State:     StateRinging,
		Offer:     offer,
		CreatedAt: now,
		ExpiresAt: now.Add(m.ringingTimeout),
	}

	m.calls[call.ID] = call
	m.active[callerID] = call.ID
	m.active[calleeID] = call.ID

	// The window of the answer has its own timer: the call ends exactly
	// when it runs out, and the users are free again right away. The sweep
	// stays as a safety net.
	m.timers[call.ID] = time.AfterFunc(m.ringingTimeout, func() {
		if _, err := m.endRingingCall(call.ID, ReasonTimeout); err != nil {
			return
		}
	})

	return copyOf(call), nil
}

// AcceptCall moves a ringing call to active. Only the first accept wins, and
// only while the ringing window is open.
func (m *Manager) AcceptCall(callID, answer string) (*Call, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	call, ok := m.calls[callID]
	if !ok {
		return nil, ErrNotFound
	}

	if err := ValidateAnswer(answer); err != nil {
		return nil, err
	}

	if call.State == StateEnded {
		return nil, ErrEnded
	}

	if call.State != StateRinging {
		return nil, ErrNotRinging
	}

	// The window of the answer ran out: the call is over even if the sweep
	// has not reached it yet.
	if !m.now().Before(call.ExpiresAt) {
		return nil, ErrExpired
	}

	call.State = StateActive
	call.Answer = answer
	call.Offer = ""
	call.ExpiresAt = m.now().Add(ActiveTTL)
	m.stopTimer(callID)

	return copyOf(call), nil
}

// EndCall finishes a call with the given reason.
//
// The registry is the only place that reports the ending, so a call ends with
// exactly one event: whoever ends it first, the others find the call already
// over and change nothing.
//
// The result tells whether this call performed the ending. The report to the
// participants happens here, outside the lock.
func (m *Manager) EndCall(callID, reason string) (bool, error) {
	return m.end(callID, reason, false)
}

// Get returns a copy of the call with the given identifier.
func (m *Manager) Get(callID string) (*Call, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	call, ok := m.calls[callID]
	if !ok {
		return nil, false
	}

	return copyOf(call), true
}

// Current returns a copy of the call the user is in, or of the last one they
// were in.
func (m *Manager) Current(userID string) (*Call, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if id := m.active[userID]; id != "" {
		call, ok := m.calls[id]
		if ok {
			return copyOf(call), true
		}
	}

	if id := m.recent[userID]; id != "" {
		call, ok := m.calls[id]
		if ok {
			return copyOf(call), true
		}
	}

	return nil, false
}

// Sweep ends the calls that cannot go on and forgets the ones that are old
// enough. It is called from a background loop.
func (m *Manager) Sweep() {
	m.mu.Lock()

	now := m.now()
	var expiredRinging []string
	var staleActive []string

	for _, call := range m.calls {
		switch call.State {
		case StateRinging:
			if !now.Before(call.ExpiresAt) {
				expiredRinging = append(expiredRinging, call.ID)
			}
		case StateActive:
			staleActive = append(staleActive, call.ID)
		case StateEnded:
			// Nothing to do: the call is over.
		}
	}

	m.mu.Unlock()

	for _, id := range expiredRinging {
		if _, err := m.endRingingCall(id, ReasonTimeout); err != nil {
			continue
		}
	}

	for _, id := range staleActive {
		m.mu.Lock()
		call, ok := m.calls[id]
		var snapshot Call
		if ok {
			snapshot = *call
		}
		m.mu.Unlock()

		if !ok || snapshot.State != StateActive {
			continue
		}

		// A participant that is gone for good cannot be on the line. The
		// grace keeps a network drop from ending the call: the client
		// reconnects and the media goes on.
		if m.goneForGood(snapshot.CallerID, now) || m.goneForGood(snapshot.CalleeID, now) {
			if _, err := m.EndCall(id, ReasonPeerLeft); err != nil {
				continue
			}

			continue
		}

		// The hard limit: even a participant that never left cannot keep the
		// call alive forever.
		if now.After(snapshot.ExpiresAt) {
			if _, err := m.EndCall(id, ReasonPeerLeft); err != nil {
				continue
			}
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for id, call := range m.calls {
		if call.State == StateEnded && now.Sub(call.EndedAt) > EndedTTL {
			delete(m.calls, id)
		}
	}
}

// Run sweeps the registry on every tick until the context is cancelled.
func (m *Manager) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.Sweep()
		}
	}
}

// Close ends every call. It runs before the SSE hub is closed, so the
// clients still receive the final state.
func (m *Manager) Close() {
	m.mu.Lock()

	var ended []string

	for id, call := range m.calls {
		if call.State == StateEnded {
			continue
		}

		call.State = StateEnded
		call.Reason = ReasonPeerLeft
		call.EndedAt = m.now()
		call.Offer = ""
		call.Answer = ""
		call.ExpiresAt = time.Time{}

		delete(m.active, call.CallerID)
		delete(m.active, call.CalleeID)
		m.recent[call.CallerID] = call.ID
		m.recent[call.CalleeID] = call.ID
		m.stopTimer(id)

		ended = append(ended, id)
	}

	onEnded := m.onEnded
	m.mu.Unlock()

	for _, id := range ended {
		call, ok := m.Get(id)
		if !ok || onEnded == nil {
			continue
		}

		onEnded(*call, ReasonPeerLeft)
	}
}

// goneForGood tells whether a participant has been offline long enough for
// the call to be over: a client that lost the network comes back, a client
// that crashed does not.
func (m *Manager) goneForGood(userID string, now time.Time) bool {
	since := m.offlineSince(userID)
	if since.IsZero() {
		return false
	}

	return now.Sub(since) >= OfflineGrace
}

// copyOf returns a copy of a call. The registry hands out copies, so the
// callers read the fields without the lock.
func copyOf(call *Call) *Call {
	if call == nil {
		return nil
	}

	copied := *call

	return &copied
}

// stopTimer stops the timer of the ringing window. It runs under the lock.
func (m *Manager) stopTimer(callID string) {
	timer, ok := m.timers[callID]
	if !ok {
		return
	}

	timer.Stop()
	delete(m.timers, callID)
}

// endRingingCall finishes a call that is still waiting for an answer. The
// timer of the window uses it: a call that was accepted in the meantime must
// not be ended as a timeout.
func (m *Manager) endRingingCall(callID, reason string) (bool, error) {
	return m.end(callID, reason, true)
}

// end performs the ending of a call. It reports the ending outside the lock.
func (m *Manager) end(callID, reason string, ringingOnly bool) (bool, error) {
	m.mu.Lock()

	call, ok := m.calls[callID]
	if !ok {
		m.mu.Unlock()

		return false, ErrNotFound
	}

	if call.State == StateEnded {
		m.mu.Unlock()

		return false, nil
	}

	if ringingOnly && call.State != StateRinging {
		m.mu.Unlock()

		return false, nil
	}

	call.State = StateEnded
	call.Reason = reason
	call.EndedAt = m.now()
	call.Offer = ""
	call.Answer = ""
	call.ExpiresAt = time.Time{}

	delete(m.active, call.CallerID)
	delete(m.active, call.CalleeID)
	m.recent[call.CallerID] = call.ID
	m.recent[call.CalleeID] = call.ID

	m.stopTimer(callID)
	snapshot := copyOf(call)
	onEnded := m.onEnded

	m.mu.Unlock()

	if onEnded != nil {
		onEnded(*snapshot, reason)
	}

	return true, nil
}
