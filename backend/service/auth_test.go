package service

import "testing"

func TestIsValidEmail(t *testing.T) {
	cases := map[string]bool{
		"alice@test.local":    true,
		"a.b+c@example.co.uk": true,
		"alice@test.local ":   false, // trailing space
		" Name <a@b.local>":   false, // display name form must be rejected
		"not-an-email":        false,
		"a@@b.local":          false,
		"@test.local":         false,
		"alice@":              false,
		"":                    false,
	}

	for in, want := range cases {
		if got := isValidEmail(in); got != want {
			t.Errorf("isValidEmail(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestGenerateCode(t *testing.T) {
	seen := map[string]bool{}

	for range 200 {
		code, err := generateCode()
		if err != nil {
			t.Fatalf("generateCode: %v", err)
		}

		if len(code) != 6 {
			t.Fatalf("code %q has wrong length", code)
		}

		for _, r := range code {
			if r < '0' || r > '9' {
				t.Fatalf("code %q contains non-digit %q", code, r)
			}
		}

		seen[code] = true
	}

	if len(seen) < 100 {
		t.Error("expected code diversity across 200 draws")
	}
}
