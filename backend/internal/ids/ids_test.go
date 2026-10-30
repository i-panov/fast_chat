package ids

import (
	"regexp"
	"testing"
)

func TestGenerateFormat(t *testing.T) {
	got := Generate()
	if len(got) != 32 {
		t.Fatalf("length = %d, want 32", len(got))
	}

	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(got) {
		t.Fatalf("value %q is not 32 hex characters", got)
	}
}

func TestGenerateIsUnique(t *testing.T) {
	seen := make(map[string]struct{}, 1000)

	for range 1000 {
		id := Generate()
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate identifier %q", id)
		}

		seen[id] = struct{}{}
	}
}

func TestTryGenerateFormat(t *testing.T) {
	got, err := TryGenerate()
	if err != nil {
		t.Fatalf("TryGenerate error: %v", err)
	}

	if len(got) != 32 {
		t.Fatalf("length = %d, want 32", len(got))
	}

	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(got) {
		t.Fatalf("value %q is not 32 hex characters", got)
	}
}

func TestMustGenerateFormat(t *testing.T) {
	got := MustGenerate()
	if len(got) != 32 {
		t.Fatalf("length = %d, want 32", len(got))
	}
}
