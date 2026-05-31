package handler

import (
	"testing"

	"fast_chat/model"
)

func TestParseInt(t *testing.T) {
	tests := []struct {
		input string
		want  int
		err   bool
	}{
		{"0", 0, false},
		{"30", 30, false},
		{"100", 100, false},
		{"", 0, true},
		{"-1", 0, true},
		{"abc", 0, true},
		{"12a", 0, true},
	}

	for _, tc := range tests {
		n, err := parseInt(tc.input)
		if tc.err && err == nil {
			t.Errorf("parseInt(%q): expected error", tc.input)
		}
		if !tc.err && err != nil {
			t.Errorf("parseInt(%q): unexpected error: %v", tc.input, err)
		}
		if n != tc.want {
			t.Errorf("parseInt(%q): got %d, want %d", tc.input, n, tc.want)
		}
	}
}

func TestRemoteServerFromID(t *testing.T) {
	tests := []struct {
		id   string
		want string
	}{
		{"alice:localhost:8080", "localhost:8080"},
		{"bob:example.com:9090", "example.com:9090"},
		{"localuser", ""},
		{"", ""},
		{"onlycolon:", ""},
	}

	for _, tc := range tests {
		got := remoteServerFromID(tc.id)
		if got != tc.want {
			t.Errorf("remoteServerFromID(%q): got %q, want %q", tc.id, got, tc.want)
		}
	}
}

func TestFederatedURL(t *testing.T) {
	got := federatedURL("remote.com:8080", "/api/federated/users/search")
	want := "http://remote.com:8080/api/federated/users/search"
	if got != want {
		t.Errorf("federatedURL: got %q, want %q", got, want)
	}
}

func TestIsMember(t *testing.T) {
	chat := &model.Chat{
		ID:      "chat1",
		Members: []string{"alice", "bob"},
	}

	if !isMember(chat, "alice") {
		t.Error("expected alice to be a member")
	}
	if !isMember(chat, "bob") {
		t.Error("expected bob to be a member")
	}
	if isMember(chat, "carol") {
		t.Error("expected carol to not be a member")
	}
}
