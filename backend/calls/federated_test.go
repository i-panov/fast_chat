package calls

import (
	"errors"
	"testing"
)

func TestFederatedShadowReserveAndActivate(t *testing.T) {
	m := NewManager(nil)
	if err := m.TryReserveFederated("c1", "ownerA", "chat1", "a:x", "b:y", "offer-1"); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if shadow, ok := m.GetFederated("c1"); !ok || shadow.Offer != "offer-1" || shadow.State != StateRinging {
		t.Fatalf("shadow must keep the offer and stay ringing, got %+v, %v", shadow, ok)
	}
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y", "offer-2"); !errors.Is(err, ErrBusyCallee) {
		t.Fatalf("expected busy-callee, got %v", err)
	}
	if !m.MarkFederatedActive("c1", ActiveTTL) {
		t.Fatalf("activate must find the shadow")
	}
	if shadow, ok := m.GetFederated("c1"); !ok || shadow.State != StateActive || shadow.Offer != "" {
		t.Fatalf("shadow must be active without an offer, got %+v, %v", shadow, ok)
	}
	if m.MarkFederatedActive("gone", ActiveTTL) {
		t.Fatalf("activate must miss a gone call")
	}
	m.RemoveFederated("c1")
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y", "offer-2"); err != nil {
		t.Fatalf("reserve after remove: %v", err)
	}
}
