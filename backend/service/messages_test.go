package service

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestValidCoords(t *testing.T) {
	cases := []struct {
		lat, lng float64
		want     bool
	}{
		{0, 0, true},
		{90, 180, true},
		{-90, -180, true},
		{90.0001, 0, false},
		{0, 180.1, false},
		{-90.1, 0, false},
		{999, 999, false},
	}
	for _, c := range cases {
		if got := ValidCoords(c.lat, c.lng); got != c.want {
			t.Errorf("ValidCoords(%v,%v)=%v want %v", c.lat, c.lng, got, c.want)
		}
	}
}

func TestParseLocationPatch(t *testing.T) {
	// Empty -> no change.
	loc, changed, err := parseLocationPatch(nil)
	if err != nil || changed || loc != nil {
		t.Fatalf("empty: loc=%v changed=%v err=%v", loc, changed, err)
	}

	// "null" -> clear location.
	loc, changed, err = parseLocationPatch(json.RawMessage("null"))
	if err != nil || !changed || loc != nil {
		t.Fatalf("null: loc=%v changed=%v err=%v", loc, changed, err)
	}

	// Valid coords.
	loc, changed, err = parseLocationPatch(json.RawMessage(`{"lat":55.7,"lng":37.6}`))
	if err != nil || changed || loc == nil {
		t.Fatalf("valid: loc=%v changed=%v err=%v", loc, changed, err)
	}
	if loc.Lat != 55.7 || loc.Lng != 37.6 {
		t.Errorf("unexpected loc: %+v", loc)
	}

	// Invalid coords.
	if _, _, err := parseLocationPatch(json.RawMessage(`{"lat":999,"lng":37.6}`)); !errors.Is(err, ErrInvalidCoordinates) {
		t.Fatalf("bad coords: expected ErrInvalidCoordinates, got %v", err)
	}

	// Malformed JSON.
	if _, _, err := parseLocationPatch(json.RawMessage(`{bad`)); !errors.Is(err, ErrInvalidCoordinates) {
		t.Fatalf("malformed: expected ErrInvalidCoordinates, got %v", err)
	}
}
