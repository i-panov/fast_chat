package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	uploadDirPermissions  = 0o750
	sniffBytes            = 512
	mimeCacheMaxAge       = 86400
	dispositionInline     = "inline"
	dispositionAttachment = "attachment"
)

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil { //nolint:gosec // limited by MaxBytesReader above
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{mapKeyError: errKeyFileTooLarge})

		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "missing file"})

		return
	}

	defer file.Close() //nolint:errcheck

	// Storage name is a UUID with no extension so the client cannot influence
	// the on-disk filename (e.g. ".php" tricks behind a misconfigured reverse
	// proxy).
	dateDir := time.Now().Format("20060102")
	storageName := generateID()
	relativePath := filepath.Join(dateDir, storageName)
	fullPath := filepath.Join(h.cfg.UploadDir, relativePath)

	if err := os.MkdirAll(filepath.Dir(fullPath), uploadDirPermissions); err != nil { //nolint:gosec // paths are controlled
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to process file"})

		return
	}

	// Stage in the destination directory so the final os.Rename is atomic
	// on the same filesystem (avoids EXDEV across /tmp and UploadDir).
	tempFile, err := os.CreateTemp(filepath.Dir(fullPath), ".upload-*"+filepath.Ext(storageName)+".tmp") //nolint:gosec
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to process file"})

		return
	}

	tempPath := tempFile.Name()

	defer os.Remove(tempPath) //nolint:errcheck

	// Detect MIME type from the first 512 bytes of the file body, ignoring the
	// client-supplied Content-Type. This blocks an attacker from uploading
	// .html and serving it as text/html.
	peek := make([]byte, sniffBytes)

	peekN, peekErr := io.ReadFull(file, peek)
	if peekErr != nil && peekErr != io.ErrUnexpectedEOF && peekErr != io.EOF {
		tempFile.Close() //nolint:errcheck,gosec
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to read file"})

		return
	}

	mimeType := http.DetectContentType(peek[:peekN])

	hasher := sha256.New()
	peekAndHash := io.MultiWriter(tempFile, hasher)

	if _, err := peekAndHash.Write(peek[:peekN]); err != nil {
		tempFile.Close() //nolint:errcheck,gosec
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to write file"})

		return
	}

	size, err := io.Copy(peekAndHash, file)
	if err != nil {
		tempFile.Close() //nolint:errcheck,gosec
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to read file"})

		return
	}

	size += int64(peekN)

	if err := tempFile.Sync(); err != nil {
		tempFile.Close() //nolint:errcheck,gosec
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to persist file"})

		return
	}

	if err := tempFile.Close(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to finalize file"})

		return
	}

	hash := hex.EncodeToString(hasher.Sum(nil))

	existing, ok := h.store.FindFileByHash(hash)
	if ok {
		writeJSON(w, http.StatusOK, map[string]interface{}{"file": existing.ToFileInfo()})

		return
	}

	// Atomic publish: rename moves the staged file into place in a single
	// step, so readers either see the previous version or the new one —
	// never a partially written file.
	if err := os.Rename(tempPath, fullPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to save file"})

		return
	}

	saved, err := h.store.SaveFile(hash, mimeType, size, header.Filename, relativePath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to save file metadata"})

		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"file": saved.ToFileInfo()})
}

func (h *Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	fileID := r.PathValue("fileId")

	fileRecord, err := h.store.GetFile(fileID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "file not found"})

		return
	}

	hasAccess := h.userCanAccessFile(user.ID, fileID)

	if !hasAccess {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	fullPath := filepath.Join(h.cfg.UploadDir, fileRecord.StoragePath)

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
func (h *Handler) userCanAccessFile(userID, fileID string) bool {
	chatIDs, err := h.store.GetFileChats(fileID)
	if err == nil {
		for _, cid := range chatIDs {
			if chat, ok := h.store.GetChat(cid); ok && isMember(chat, userID) {
				return true
			}
		}
	}

	avatarChatIDs, err := h.store.GetChatsByAvatarFileID(fileID)
	if err == nil {
		for _, cid := range avatarChatIDs {
			if chat, ok := h.store.GetChat(cid); ok && isMember(chat, userID) {
				return true
			}
		}
	}

	return false
}
