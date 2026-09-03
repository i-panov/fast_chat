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
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fast_chat/service"
	"fast_chat/store"
)

const (
	uploadDirPermissions  = 0o700
	sniffBytes            = 512
	dispositionInline     = "inline"
	dispositionAttachment = "attachment"
)

// MaxUploadSize caps file upload bodies. A var (not const) so tests can
// shrink it.
var MaxUploadSize int64 = 50 << 20

// ParseFileHash validates and returns the client-provided plaintext hash
// for encrypted file uploads. Returns ("", false) when no hash is provided.
// For encrypted uploads the hash is required and validated.
func ParseFileHash(r *http.Request) (string, bool, string) {
	encrypted := r.FormValue("encrypted") == "true"
	clientHash := r.FormValue("hash")

	if encrypted && clientHash == "" {
		return "", true, "hash required for encrypted files"
	}

	if clientHash != "" {
		if len(clientHash) != 64 || !service.IsHexString(clientHash) {
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
func StageAndHashFile(
	file io.Reader,
	clientHash string,
	encrypted bool,
	uploadsDir string,
) (StagedFile, error) {

	var staged StagedFile
	// failed tracks whether an error occurred after the temp file was created,
	// so the deferred cleanup can remove the staged file.
	var failed bool

	// Storage name is a UUID with no extension so the client cannot influence
	// the on-disk filename (e.g. ".php" tricks behind a misconfigured reverse
	// proxy).
	dateDir := time.Now().Format("20060102")
	storageName := store.GenerateID()
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
	tempFile, tmpErr := os.CreateTemp(filepath.Dir(staged.FullPath), ".upload-*"+filepath.Ext(storageName)+".tmp")
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
		staged.Hash = clientHash
	} else {
		staged.Hash = hex.EncodeToString(hasher.Sum(nil))
	}

	return staged, nil
}

// IsInlinableMIME reports whether the given MIME type is safe to serve inline
// in a browser. Everything else is forced to attachment to neutralise XSS via
// uploaded HTML/JS/SVG/documents.
func IsInlinableMIME(mime string) bool {
	switch {
	case strings.HasPrefix(mime, "image/"),
		strings.HasPrefix(mime, "video/"),
		strings.HasPrefix(mime, "audio/"),
		mime == "application/pdf":
		return true
	}

	return false
}

// SanitizeFilename strips characters that could break out of the
// Content-Disposition header or be misinterpreted by the browser.
func SanitizeFilename(name string) string {
	r := strings.NewReplacer(
		"\"", "",
		"\\", "",
		"\n", "",
		"\r", "",
		";", "",
	)

	return r.Replace(name)
}
