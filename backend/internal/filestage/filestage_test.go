package filestage

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsInlinableMIMEDeniesSVG(t *testing.T) {
	for _, mime := range []string{
		"image/svg+xml",
		"image/svg+xml; charset=utf-8",
		"IMAGE/SVG+XML",
		"image/SVG+xml",
	} {
		if IsInlinableMIME(mime) {
			t.Errorf("IsInlinableMIME(%q) = true, want false", mime)
		}
	}

	for _, mime := range []string{
		"image/png",
		"image/jpeg",
		"video/mp4",
		"audio/mpeg",
		"application/pdf",
	} {
		if !IsInlinableMIME(mime) {
			t.Errorf("IsInlinableMIME(%q) = false, want true", mime)
		}
	}

	if IsInlinableMIME("text/html; charset=utf-8") {
		t.Error("IsInlinableMIME(text/html) = true, want false")
	}
}

func TestParseFileHashNormalizesLower(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), "POST", "/api/files/upload", http.NoBody)
	upper := strings.ToUpper("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
	req.Form = map[string][]string{"hash": {upper}}

	hash, encrypted, errKey := ParseFileHash(req)
	if errKey != "" {
		t.Fatalf("errKey = %q, want empty", errKey)
	}

	if encrypted {
		t.Error("encrypted = true, want false")
	}

	want := strings.ToLower(upper)
	if hash != want {
		t.Errorf("hash = %q, want %q", hash, want)
	}
}

func TestParseFileHashRejectsBad(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), "POST", "/api/files/upload", http.NoBody)
	req.Form = map[string][]string{"encrypted": {"true"}, "hash": {"not-hex"}}

	if _, _, errKey := ParseFileHash(req); errKey == "" {
		t.Error("expected error for bad hash, got empty")
	}

	empty := httptest.NewRequestWithContext(context.Background(), "POST", "/api/files/upload", http.NoBody)
	empty.Form = map[string][]string{"encrypted": {"true"}}

	if _, _, errKey := ParseFileHash(empty); errKey == "" {
		t.Error("expected error for missing encrypted hash, got empty")
	}
}

func TestStageEnforcesLimit(t *testing.T) {
	dir := t.TempDir()
	data := bytes.Repeat([]byte("a"), 100)

	if _, err := StageAndHashFileWithLimit(bytes.NewReader(data), "", false, dir, 10); !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("err = %v, want ErrFileTooLarge", err)
	}

	staged, err := StageAndHashFileWithLimit(bytes.NewReader(data), "", false, dir, int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = os.Remove(staged.TempPath) }()

	if staged.Size != int64(len(data)) {
		t.Errorf("size = %d, want %d", staged.Size, len(data))
	}

	if len(staged.Hash) != 64 {
		t.Errorf("hash length = %d, want 64", len(staged.Hash))
	}
}

func TestSweepStaleTempFiles(t *testing.T) {
	dir := t.TempDir()

	old := filepath.Join(dir, ".upload-old.tmp")
	fresh := filepath.Join(dir, ".upload-fresh.tmp")
	keep := filepath.Join(dir, "real-file.bin")

	for _, p := range []string{old, fresh, keep} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}

	removed, err := SweepStaleTempFiles(dir, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if removed != 1 {
		t.Errorf("removed = %d, want 1", removed)
	}

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("old temp file was not removed")
	}

	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh temp file should stay: %v", err)
	}

	if _, err := os.Stat(keep); err != nil {
		t.Errorf("non-temp file should stay: %v", err)
	}
}

func TestSanitizeFilenameStrict(t *testing.T) {
	if got := SanitizeFilename("../../etc/passwd"); strings.Contains(got, "/") {
		t.Errorf("slash survived: %q", got)
	}

	if got := SanitizeFilename("a\"b\\c\nd;e"); got != "a_b_c_d_e" {
		t.Errorf("got %q, want a_b_c_d_e", got)
	}

	if got := SanitizeFilename(""); got != "file" {
		t.Errorf("empty got %q, want file", got)
	}

	long := strings.Repeat("a", 200)
	if got := SanitizeFilename(long); len([]rune(got)) != 120 {
		t.Errorf("long filename runes = %d, want 120", len([]rune(got)))
	}

	if got := SanitizeFilename("my file.pdf"); got != "my_file.pdf" {
		t.Errorf("space handling got %q, want my_file.pdf", got)
	}
}

func TestContentDispositionFilenameStar(t *testing.T) {
	got := ContentDisposition("attachment", "photo.png")
	if got != `attachment; filename="photo.png"` {
		t.Errorf("ascii got %q", got)
	}

	got = ContentDisposition("attachment", "файл.png")
	if !strings.Contains(got, `filename="`) || !strings.Contains(got, "filename*=UTF-8''") {
		t.Errorf("non-ascii got %q, want filename + filename*", got)
	}
}
