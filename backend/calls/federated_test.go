package calls

import (
	"errors"
	"testing"
)

func TestFederatedShadowReserveAndExpiry(t *testing.T) {
	m := NewManager(nil)
	if err := m.TryReserveFederated("c1", "ownerA", "chat1", "a:x", "b:y", "offer-1"); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if shadow, ok := m.GetFederated("c1"); !ok || shadow.Offer != "offer-1" {
		t.Fatalf("shadow must keep the offer, got %+v, %v", shadow, ok)
	}
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y", "offer-2"); !errors.Is(err, ErrBusyCallee) {
		t.Fatalf("expected busy-callee, got %v", err)
	}
	if !m.ExtendFederated("c1", ActiveTTL) {
		t.Fatalf("extend must find the shadow")
	}
	if m.ExtendFederated("gone", ActiveTTL) {
		t.Fatalf("extend must miss a gone call")
	}
	m.RemoveFederated("c1")
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y", "offer-2"); err != nil {
		t.Fatalf("reserve after remove: %v", err)
	}
}
