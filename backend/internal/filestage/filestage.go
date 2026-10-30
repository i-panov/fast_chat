// Package filestage provides upload staging utilities: hash/encrypted-form
// parsing, atomic temp-file staging with MIME sniffing and hashing, MIME
// inline-safety classification, and Content-Disposition filename sanitation.
package filestage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fast_chat/internal/ids"
)

const (
	uploadDirPermissions  = 0o700
	sniffBytes            = 512
	dispositionInline     = "inline"
	dispositionAttachment = "attachment"
	// maxFilenameRunes caps the sanitized Content-Disposition filename so a
	// peer cannot bloat response headers.
	maxFilenameRunes = 120
)

// MaxUploadSize caps file upload bodies. A var (not const) so tests can
// shrink it.
var MaxUploadSize int64 = 50 << 20

// ErrFileTooLarge is returned when the staged stream exceeds the limit.
var ErrFileTooLarge = errors.New("file too large")

// isHexString reports whether s is a non-empty lowercase hex string.
func isHexString(s string) bool {
	if s == "" {
		return false
	}

	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}

	return true
}

// ParseFileHash validates and returns the client-provided plaintext hash
// for encrypted file uploads. Returns ("", false) when no hash is provided.
// For encrypted uploads the hash is required and validated.
//
// The hash is normalized to lowercase so the same content deduplicates
// regardless of the hex case the client sent.
func ParseFileHash(r *http.Request) (string, bool, string) {
	encrypted := r.FormValue("encrypted") == "true"
	clientHash := strings.ToLower(strings.TrimSpace(r.FormValue("hash")))

	if encrypted && clientHash == "" {
		return "", true, "hash required for encrypted files"
	}

	if clientHash != "" {
		if len(clientHash) != 64 || !isHexString(clientHash) {
			return "", encrypted, "invalid hash format"
		}
	}

	return clientHash, encrypted, ""
}

// StagedFile is the outcome of staging an upload on disk.
type StagedFile struct {
	MimeType     string
	Size         int64
	Hash         string
	TempPath     string
	FullPath     string
	RelativePath string
}

// StageAndHashFile writes the uploaded file to a temp location, computes its
// MIME type and size, and returns the hash (from client or computed). The
// caller finalizes the upload by renaming TempPath to FullPath.
//
// The stream is capped at MaxUploadSize via LimitReader as defense in depth:
// the caller already caps the body, but the stage must not trust it.
func StageAndHashFile(
	file io.Reader,
	clientHash string,
	encrypted bool,
	uploadsDir string,
) (StagedFile, error) {

	return StageAndHashFileWithLimit(file, clientHash, encrypted, uploadsDir, MaxUploadSize)
}

// StageAndHashFileWithLimit is StageAndHashFile with an explicit byte limit.
// A limit <= 0 falls back to MaxUploadSize. A stream longer than the limit
// fails with ErrFileTooLarge.
func StageAndHashFileWithLimit(
	file io.Reader,
	clientHash string,
	encrypted bool,
	uploadsDir string,
	limit int64,
) (StagedFile, error) {

	if limit <= 0 {
		limit = MaxUploadSize
	}

	// Cap the stream even when the caller forgot: limit+1 lets the stage
	// detect the overflow instead of truncating silently.
	file = io.LimitReader(file, limit+1)

	var staged StagedFile
	// failed tracks whether an error occurred after the temp file was created,
	// so the deferred cleanup can remove the staged file.
	var failed bool

	// Storage name is a random id with no extension so the client cannot
	// influence the on-disk filename (e.g. ".php" tricks behind a
	// misconfigured reverse proxy).
	dateDir := time.Now().Format("20060102")
	storageName := ids.Generate()
	staged.RelativePath = filepath.Join(dateDir, storageName)
	staged.FullPath = filepath.Join(uploadsDir, staged.RelativePath)

	// Directory mode is deliberate least privilege: 0700/0750 gives the owner
	// rwx (or r-x for group) on a directory; anything below strips the execute
	// bit and breaks path traversal. The rule targets file modes.
	// nosemgrep: go.lang.correctness.permissions.incorrect-default-permission
	if mkdirErr := os.MkdirAll(filepath.Dir(staged.FullPath), uploadDirPermissions); mkdirErr != nil {
		failed = true
		return StagedFile{}, fmt.Errorf("mkdir: %w", mkdirErr)
	}

	// Stage in the destination directory so the final os.Rename is atomic
	// on the same filesystem (avoids EXDEV across /tmp and uploads dir).
	var tempFile *os.File
	tempFile, tmpErr := os.CreateTemp(filepath.Dir(staged.FullPath), ".upload-*.tmp")
	if tmpErr != nil {
		failed = true
		return StagedFile{}, fmt.Errorf("create temp: %w", tmpErr)
	}

	staged.TempPath = tempFile.Name()

	// On any error after this point, remove the staged temp file so it does
	// not accumulate on disk (e.g. interrupted uploads, read failures).
	defer func() {
		if failed {
			os.Remove(staged.TempPath) //nolint:errcheck,gosec // best-effort: already failing
		}
	}()

	// Detect MIME type from the first 512 bytes of the file body, ignoring the
	// client-supplied Content-Type. This blocks an attacker from uploading
	// .html and serving it as text/html.
	peek := make([]byte, sniffBytes)

	peekN, peekErr := io.ReadFull(file, peek)
	if peekErr != nil && !errors.Is(peekErr, io.ErrUnexpectedEOF) && peekErr != io.EOF {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return StagedFile{}, fmt.Errorf("read file header: %w", peekErr)
	}

	staged.MimeType = http.DetectContentType(peek[:peekN])

	hasher := sha256.New()
	peekAndHash := io.MultiWriter(tempFile, hasher)

	if _, werr := peekAndHash.Write(peek[:peekN]); werr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return StagedFile{}, fmt.Errorf("write file: %w", werr)
	}

	var written int64
	written, copyErr := io.Copy(peekAndHash, file)
	if copyErr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return StagedFile{}, fmt.Errorf("read file: %w", copyErr)
	}

	staged.Size = written + int64(peekN)
	if staged.Size > limit {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return StagedFile{}, fmt.Errorf("%w: limit %d bytes", ErrFileTooLarge, limit)
	}

	if syncErr := tempFile.Sync(); syncErr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return StagedFile{}, fmt.Errorf("sync file: %w", syncErr)
	}

	if closeErr := tempFile.Close(); closeErr != nil {
		failed = true
		return StagedFile{}, fmt.Errorf("finalize file: %w", closeErr)
	}

	// For encrypted files, use the client-provided hash. Otherwise compute.
	if encrypted {
		staged.Hash = strings.ToLower(clientHash)
	} else {
		staged.Hash = hex.EncodeToString(hasher.Sum(nil))
	}

	return staged, nil
}

// SweepStaleTempFiles removes abandoned ".upload-*.tmp" stage files older
// than maxAge under uploadsDir (e.g. after a crash mid-upload). It returns
// the number of removed files. A missing directory sweeps nothing.
func SweepStaleTempFiles(uploadsDir string, maxAge time.Duration) (int, error) {
	if _, err := os.Stat(uploadsDir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}

		return 0, fmt.Errorf("stat uploads dir: %w", err)
	}

	cutoff := time.Now().Add(-maxAge)
	removed := 0

	err := filepath.WalkDir(uploadsDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil //nolint:nilerr // best-effort sweep skips unreadable entries
		}

		if entry.IsDir() {
			return nil
		}

		name := entry.Name()
		if !strings.HasPrefix(name, ".upload-") || !strings.HasSuffix(name, ".tmp") {
			return nil
		}

		info, err := entry.Info()
		if err != nil {
			return nil //nolint:nilerr // best-effort sweep skips vanishing entries
		}

		if info.ModTime().After(cutoff) {
			return nil
		}

		// Remove only regular files: a symlink planted under the mask
		// must not be followed into someone else's file. Lstat (not
		// Stat) inspects the link itself. A swap in the Lstat→Remove
		// window would still need write access to uploadsDir, which the
		// server owns exclusively.
		linfo, err := os.Lstat(path)
		if err != nil {
			return nil //nolint:nilerr // best-effort sweep skips vanishing entries
		}

		if !linfo.Mode().IsRegular() {
			return nil
		}

		//nolint:gosec // regular-file Lstat gate above; residual TOCTOU needs write access to the server-owned dir
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil
		}

		removed++

		return nil
	})
	if err != nil {
		return removed, fmt.Errorf("sweep uploads dir: %w", err)
	}

	return removed, nil
}

// IsInlinableMIME reports whether the given MIME type is safe to serve inline
// in a browser. Everything else is forced to attachment to neutralise XSS via
// uploaded HTML/JS/SVG/documents.
//
// SVG is never inlinable: image/svg+xml can carry scripts in the site origin
// even though it matches the image/ prefix.
func IsInlinableMIME(mime string) bool {
	base := strings.ToLower(strings.TrimSpace(mime))
	if idx := strings.Index(base, ";"); idx >= 0 {
		base = strings.TrimSpace(base[:idx])
	}

	// Explicit SVG denial survives parameters and case variations.
	if base == "image/svg+xml" {
		return false
	}

	switch {
	case strings.HasPrefix(base, "image/"),
		strings.HasPrefix(base, "video/"),
		strings.HasPrefix(base, "audio/"),
		base == "application/pdf":
		return true
	}

	return false
}

// SanitizeFilename returns a Content-Disposition-safe ASCII filename:
// only [A-Za-z0-9._-], capped at 120 runes. Anything else becomes "_".
// An empty or dot-only result falls back to "file".
//
// Non-ASCII input is transliterated away here; use ContentDisposition to keep
// the original name via the RFC 5987 filename* parameter.
func SanitizeFilename(name string) string {
	var sanitized strings.Builder

	for _, sym := range name {
		switch {
		case sym >= 'A' && sym <= 'Z',
			sym >= 'a' && sym <= 'z',
			sym >= '0' && sym <= '9',
			sym == '.' || sym == '_' || sym == '-':
			sanitized.WriteRune(sym)
		default:
			sanitized.WriteRune('_')
		}
	}

	out := sanitized.String()
	if r := []rune(out); len(r) > maxFilenameRunes {
		out = string(r[:maxFilenameRunes])
	}

	out = strings.Trim(out, ".")
	out = strings.TrimSpace(out)
	// Only the empty case is reachable here: the builder emits strictly
	// ASCII (so utf8 is trivially valid) and Trim(".", ) already removed
	// any dot-only result.
	if out == "" {
		return "file"
	}

	return out
}

// ContentDisposition builds a Content-Disposition header value that keeps a
// non-ASCII filename via RFC 5987 filename* while the fallback filename=""
// stays strictly sanitized.
func ContentDisposition(disposition, filename string) string {
	safe := SanitizeFilename(filename)
	if isASCII(filename) && safe == filename && len([]rune(filename)) <= maxFilenameRunes {
		return disposition + "; filename=\"" + safe + "\""
	}

	return disposition + "; filename=\"" + safe + "\"; filename*=UTF-8''" + encodeRFC5987(filename)
}

// isASCII reports whether str is printable ASCII without characters that need
// quoting in a Content-Disposition header.
func isASCII(str string) bool {
	if str == "" {
		return false
	}

	for idx := range len(str) {
		if str[idx] < 0x20 || str[idx] > 0x7E {
			return false
		}

		switch str[idx] {
		case '"', '\\', ';':
			return false
		}
	}

	return true
}

// encodeRFC5987 percent-encodes value for a filename* parameter.
func encodeRFC5987(value string) string {
	const hexDigits = "0123456789ABCDEF"

	var encoded strings.Builder

	for idx := range len(value) {
		chr := value[idx]
		if isRFC5987Unreserved(chr) {
			encoded.WriteByte(chr)

			continue
		}

		encoded.WriteByte('%')
		encoded.WriteByte(hexDigits[chr>>4])
		encoded.WriteByte(hexDigits[chr&0x0F])
	}

	return encoded.String()
}

// isRFC5987Unreserved reports whether chr can appear literally in a
// filename* parameter.
func isRFC5987Unreserved(chr byte) bool {
	if chr >= 'A' && chr <= 'Z' || chr >= 'a' && chr <= 'z' || chr >= '0' && chr <= '9' {
		return true
	}

	switch chr {
	case '.', '_', '-', '~':
		return true
	}

	return false
}
