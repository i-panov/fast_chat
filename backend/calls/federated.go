package calls

import "time"

// FederatedInbound is the ephemeral shadow of an inbound federated call.
// Server B keeps it for the ringing window to enforce busy-callee and to
// route accept/ice/hangup to the right owner. An active call does not extend
// the shadow: the owner's ended report removes it.
type FederatedInbound struct {
	CallID    string
	Owner     string
	ChatID    string
	CallerID  string
	CalleeID  string
	Offer     string
	ExpiresAt time.Time
}

// TryReserveFederated reserves the local callee for an inbound federated
// call. It fails with ErrBusyCallee when the call ID is already known,
// when the same callee already has a shadow, or when the callee is busy in
// a local call. The shadow keeps the offer, so a client that reloads can
// reconcile the ringing call, and lives for the ringing window: the proxy
// extends it on accept for the whole active call (see ExtendFederated).
func (m *Manager) TryReserveFederated(callID, owner, chatID, callerID, calleeID, offer string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	m.purgeExpiredFederatedLocked(now)

	if m.federated == nil {
		m.federated = make(map[string]*FederatedInbound)
	}

	if _, ok := m.calls[callID]; ok {
		return ErrBusyCallee
	}

	if _, ok := m.federated[callID]; ok {
		return ErrBusyCallee
	}

	for _, shadow := range m.federated {
		if shadow.CalleeID == calleeID {
			return ErrBusyCallee
		}
	}

	if _, ok := m.active[calleeID]; ok {
		return ErrBusyCallee
	}

	m.federated[callID] = &FederatedInbound{
		CallID:    callID,
		Owner:     owner,
		ChatID:    chatID,
		CallerID:  callerID,
		CalleeID:  calleeID,
		Offer:     offer,
		ExpiresAt: now.Add(m.ringingTimeout),
	}

	return nil
}

// GetFederated returns a copy of the shadow for the given call ID.
// An expired shadow is removed and reported as missing.
func (m *Manager) GetFederated(callID string) (*FederatedInbound, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	shadow, ok := m.federated[callID]
	if !ok {
		return nil, false
	}

	if !m.now().Before(shadow.ExpiresAt) {
		delete(m.federated, callID)
		return nil, false
	}

	copied := *shadow

	return &copied, true
}

// RemoveFederated drops the shadow for the given call ID, if present.
func (m *Manager) RemoveFederated(callID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.federated, callID)
}

// ExtendFederated stretches the shadow of an accepted call for the whole
// active window. The ringing shadow would expire mid-call otherwise, and the
// owner report about the end of the call would find nothing to deliver to.
// It reports whether the shadow exists.
func (m *Manager) ExtendFederated(callID string, ttl time.Duration) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	shadow, ok := m.federated[callID]
	if !ok {
		return false
	}

	shadow.ExpiresAt = m.now().Add(ttl)

	return true
}

// CurrentFederated returns a copy of the shadow ringing for the given callee,
// if any. An expired shadow is removed and reported as missing.
func (m *Manager) CurrentFederated(calleeID string) (*FederatedInbound, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	m.purgeExpiredFederatedLocked(now)

	for _, shadow := range m.federated {
		if shadow.CalleeID == calleeID {
			copied := *shadow

			return &copied, true
		}
	}

	return nil, false
}

// purgeExpiredFederatedLocked removes shadows past the ringing window.
// It runs under the lock.
func (m *Manager) purgeExpiredFederatedLocked(now time.Time) {
	for id, shadow := range m.federated {
		if !now.Before(shadow.ExpiresAt) {
			delete(m.federated, id)
		}
	}
}
