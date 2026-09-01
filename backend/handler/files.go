package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"fast_chat/service"
	"fast_chat/store"
)

const (
	uploadDirPermissions  = 0o700
	sniffBytes            = 512
	mimeCacheMaxAge       = 86400
	dispositionInline     = "inline"
	dispositionAttachment = "attachment"
)

// parseFileHash validates and returns the client-provided plaintext hash
// for encrypted file uploads. Returns ("", false) when no hash is provided.
// For encrypted uploads the hash is required and validated.
func parseFileHash(r *http.Request) (string, bool, string) {
	encrypted := r.FormValue("encrypted") == "true"
	clientHash := r.FormValue("hash")

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

// stageAndHashFile writes the uploaded file to a temp location, computes
// its MIME type and size, and returns the hash (from client or computed).
// Returns the temp path, full path, and relative path for the caller to
// finalize the upload.
func stageAndHashFile(
	file io.Reader,
	clientHash string,
	encrypted bool,
	uploadsDir string,
) (string, int64, string, string, string, string, error) {

	var (
		mimeType     string
		size         int64
		tempPath     string
		fullPath     string
		relativePath string
	)
	// failed tracks whether an error occurred after the temp file was created,
	// so the deferred cleanup can remove the staged file.
	var failed bool

	// Storage name is a UUID with no extension so the client cannot influence
	// the on-disk filename (e.g. ".php" tricks behind a misconfigured reverse
	// proxy).
	dateDir := time.Now().Format("20060102")
	storageName := store.GenerateID()
	relativePath = filepath.Join(dateDir, storageName)
	fullPath = filepath.Join(uploadsDir, relativePath)

	if mkdirErr := os.MkdirAll(filepath.Dir(fullPath), uploadDirPermissions); mkdirErr != nil {
		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("mkdir: %w", mkdirErr)
	}

	// Stage in the destination directory so the final os.Rename is atomic
	// on the same filesystem (avoids EXDEV across /tmp and uploads dir).
	var tempFile *os.File
	tempFile, tmpErr := os.CreateTemp(filepath.Dir(fullPath), ".upload-*"+filepath.Ext(storageName)+".tmp")
	if tmpErr != nil {
		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("create temp: %w", tmpErr)
	}

	tempPath = tempFile.Name()

	// On any error after this point, remove the staged temp file so it does
	// not accumulate on disk (e.g. interrupted uploads, read failures).
	defer func() {
		if failed {
			os.Remove(tempPath) //nolint:errcheck,gosec // best-effort: already failing
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
		return "", 0, "", "", "", "", fmt.Errorf("read file header: %w", peekErr)
	}

	mimeType = http.DetectContentType(peek[:peekN])

	hasher := sha256.New()
	peekAndHash := io.MultiWriter(tempFile, hasher)

	if _, werr := peekAndHash.Write(peek[:peekN]); werr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("write file: %w", werr)
	}

	var written int64
	written, copyErr := io.Copy(peekAndHash, file)
	if copyErr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("read file: %w", copyErr)
	}

	size = written + int64(peekN)

	if syncErr := tempFile.Sync(); syncErr != nil {
		tempFile.Close() //nolint:errcheck,gosec // temp-file removal is best-effort

		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("sync file: %w", syncErr)
	}

	if closeErr := tempFile.Close(); closeErr != nil {
		failed = true
		return "", 0, "", "", "", "", fmt.Errorf("finalize file: %w", closeErr)
	}

	// For encrypted files, use the client-provided hash. Otherwise compute.
	if encrypted {
		return mimeType, size, clientHash, tempPath, fullPath, relativePath, nil
	}

	return mimeType, size, hex.EncodeToString(hasher.Sum(nil)), tempPath, fullPath, relativePath, nil
}

// If found, it writes the existing file info response and returns true.
func (h *Handler) dedupFileByHash(
	ctx context.Context,
	w http.ResponseWriter,
	hash, mimeType string,
	size int64,
	originalName string,
) bool {

	if exact, ok := h.store.FindFileByHashAndName(ctx, hash, originalName); ok {
		WriteJSON(w, http.StatusOK, map[string]any{"file": exact.ToFileInfo()})
		return true
	}

	if existing, ok := h.store.FindFileByHash(ctx, hash); ok {
		saved, saveErr := h.store.SaveFile(ctx, hash, mimeType, size, originalName, existing.StoragePath)
		if saveErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to save file metadata")
			return true
		}
		WriteJSON(w, http.StatusCreated, map[string]any{"file": saved.ToFileInfo()})
		return true
	}

	return false
}

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil { //nolint:gosec // limited by MaxBytesReader above
		writeError(w, http.StatusRequestEntityTooLarge, errKeyFileTooLarge)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file")
		return
	}

	defer file.Close() //nolint:errcheck // best-effort: failure is not actionable

	clientHash, encrypted, errKey := parseFileHash(r)
	if errKey != "" {
		writeError(w, http.StatusBadRequest, errKey)
		return
	}

	mimeType, size, hash, tempPath, fullPath, relativePath, err :=
		stageAndHashFile(file, clientHash, encrypted, h.cfg.Uploads.Dir)
	if err != nil {
		slog.Error("failed to stage file", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to process file")
		return
	}

	defer os.Remove(tempPath) //nolint:errcheck // best-effort: failure is not actionable

	if h.dedupFileByHash(r.Context(), w, hash, mimeType, size, header.Filename) {
		return
	}

	if err := os.Rename(tempPath, fullPath); err != nil { //nolint:gosec // paths are controlled UUIDs
		writeError(w, http.StatusInternalServerError, "failed to save file")
		return
	}

	saved, err := h.store.SaveFile(r.Context(), hash, mimeType, size, header.Filename, relativePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save file metadata")
		return
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"file": saved.ToFileInfo()})
}

func (h *Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	fileID := r.PathValue("fileId")

	fileRecord, err := h.store.GetFile(r.Context(), fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	hasAccess := h.userCanAccessFile(r.Context(), user.ID, fileID)

	if !hasAccess {
		writeError(w, http.StatusForbidden, errKeyNotMember)
		return
	}

	fullPath := filepath.Join(h.cfg.Uploads.Dir, fileRecord.StoragePath)

	// Defense in depth: tell the browser never to MIME-sniff or execute inline
	// scripts, and force download for anything that could be interpreted as
	// HTML/JS/SVG (XSS via uploaded file).
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Content-Type", fileRecord.MimeType)

	disposition := dispositionAttachment
	if isInlinableMIME(fileRecord.MimeType) {
		disposition = dispositionInline
	}

	w.Header().Set("Content-Disposition", disposition+"; filename=\""+sanitizeFilename(fileRecord.OriginalName)+"\"")
	w.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(mimeCacheMaxAge))

	http.ServeFile(w, r, fullPath) //nolint:gosec // path is controlled, generated UUID
}

// isInlinableMIME reports whether the given MIME type is safe to serve inline
// in a browser. Everything else is forced to attachment to neutralise XSS via
// uploaded HTML/JS/SVG/documents.
func isInlinableMIME(mime string) bool {
	switch {
	case strings.HasPrefix(mime, "image/"),
		strings.HasPrefix(mime, "video/"),
		strings.HasPrefix(mime, "audio/"),
		mime == "application/pdf":
		return true
	}

	return false
}

// sanitizeFilename strips characters that could break out of the
// Content-Disposition header or be misinterpreted by the browser.
func sanitizeFilename(name string) string {
	r := strings.NewReplacer(
		"\"", "",
		"\\", "",
		"\n", "",
		"\r", "",
		";", "",
	)

	return r.Replace(name)
}

// userCanAccessFile returns true if the user has access to the file via any
// message attachment or as a group chat avatar.
func (h *Handler) userCanAccessFile(ctx context.Context, userID, fileID string) bool {
	chatIDs, err := h.store.GetFileChats(ctx, fileID)
	if err == nil && len(chatIDs) > 0 {
		chats, err := h.store.GetChatsByIDs(ctx, chatIDs)
		if err == nil {
			for _, chat := range chats {
				if service.IsMember(&chat, userID) {
					return true
				}
			}
		}
	}

	avatarChatIDs, err := h.store.GetChatsByAvatarFileID(ctx, fileID)
	if err == nil && len(avatarChatIDs) > 0 {
		chats, err := h.store.GetChatsByIDs(ctx, avatarChatIDs)
		if err == nil {
			for _, chat := range chats {
				if service.IsMember(&chat, userID) {
					return true
				}
			}
		}
	}

	return false
}

// FileExistsHandler responds to GET /api/files/exists?hash=<sha256>.
// The client calls this before uploading to skip the upload when the server
// already has the file content (deduplication by plaintext hash). The hash is
// a content fingerprint, not confidential data.
func (h *Handler) FileExistsHandler(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeError(w, http.StatusBadRequest, "hash parameter required")
		return
	}

	// Validate hash format (64 hex chars for SHA-256).
	if len(hash) != 64 || !isHexString(hash) {
		writeError(w, http.StatusBadRequest, "invalid hash format")
		return
	}

	exists := h.store.FileExistsByHash(r.Context(), hash)
	WriteJSON(w, http.StatusOK, map[string]bool{"exists": exists})
}

func isHexString(s string) bool {
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}
