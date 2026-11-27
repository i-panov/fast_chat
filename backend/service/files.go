package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fast_chat/internal/filestage"
	"fast_chat/model"
)

// Orphan file GC. A file is orphaned when its message was deleted, an edit
// dropped the attachment, or the upload never made it into a message. The
// bytes stay on disk forever without this sweep.
const (
	orphanFileRetention     = 7 * 24 * time.Hour
	orphanFileSweepInterval = 24 * time.Hour
	orphanFileBatch         = 200

	// maxUnattachedFileBytes caps the total size of one account's uploads
	// that are not attached to a message or an avatar. Such files live for
	// the whole orphan retention window, so without the cap one account can
	// fill the instance disk with uploads that are never used.
	maxUnattachedFileBytes = 512 << 20
)

// ErrUploadQuotaExceeded reports that the user's unattached uploads are at the
// cap and the new file would exceed it.
var ErrUploadQuotaExceeded = errors.New("upload quota exceeded")

// RunFileGC sweeps orphaned uploads immediately and then once a day until the
// context is cancelled.
func (s *Service) RunFileGC(ctx context.Context, interval time.Duration) {
	if s.cfg == nil || s.cfg.Uploads.Dir == "" {
		return
	}
	if interval <= 0 {
		interval = orphanFileSweepInterval
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	s.sweepOrphanFiles(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepOrphanFiles(ctx)
		}
	}
}

func (s *Service) sweepOrphanFiles(ctx context.Context) {
	before := time.Now().UTC().Add(-orphanFileRetention)

	s.fileMu.Lock()
	defer s.fileMu.Unlock()

	// Crashed uploads leave their stage files behind; the startup sweep alone
	// is not enough for a long-lived process.
	if _, err := filestage.SweepStaleTempFiles(s.cfg.Uploads.Dir, orphanFileSweepInterval); err != nil {
		log().Warn("failed to sweep stale upload temp files", "err", err)
	}

	for {
		deleted, paths, err := s.store.DeleteOrphanFilesBefore(ctx, before, orphanFileBatch)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				log().Warn("orphan file GC failed", "err", err)
			}
			return
		}

		for _, path := range paths {
			s.removeUploadedFile(path)
		}

		if deleted == 0 || deleted < orphanFileBatch {
			return
		}
	}
}

// removeUploadedFile deletes one stored upload after checking that the path
// still resolves inside the uploads directory (a corrupted row must not become
// an arbitrary file delete).
func (s *Service) removeUploadedFile(relativePath string) {
	root := filepath.Clean(s.cfg.Uploads.Dir)
	full := filepath.Join(root, relativePath)

	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || filepath.IsAbs(rel) ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) {

		log().Warn("orphan file GC: refusing path outside uploads", "path", relativePath)
		return
	}

	if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
		log().Warn("orphan file GC: cannot remove file", "path", relativePath, "err", err)
	}
}

// EnsureUploadQuota rejects an upload that would push the user's unattached
// files past maxUnattachedFileBytes. It is checked before the bytes hit the
// disk, so a rejected upload costs nothing.
func (s *Service) EnsureUploadQuota(ctx context.Context, userID string, size int64) error {
	if size <= 0 {
		return nil
	}

	used, err := s.store.UnattachedFileBytes(ctx, userID)
	if err != nil {
		return err
	}

	if used+size > maxUnattachedFileBytes {
		return ErrUploadQuotaExceeded
	}

	return nil
}

// IsHexString reports whether s consists solely of hexadecimal characters.
// IsHexString reports whether s is a non-empty hex string. Empty is
// rejected: like filestage's local helper, so the two helpers agree.
func IsHexString(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}

	return true
}

// FileUploadCheck is the outcome of a deduplication lookup. When Deduped is
// true the transport must respond with Check.File and must NOT create a new
// physical file; ExactMatch tells it which status code to use (200 when the
// exact hash+name record is returned as-is, 201 when a new record pointed at
// an already-stored physical file).
type FileUploadCheck struct {
	File       *model.File
	ExactMatch bool
}

// FileUpload describes the content of an upload.
type FileUpload struct {
	Hash         string
	MimeType     string
	Size         int64
	OriginalName string
	// Uploader is the account that performs the upload. It owns the file
	// record, and only the owner may attach the file to a message.
	Uploader string
	// Encrypted marks an upload whose content is ciphertext. Such an upload
	// is never deduplicated: every user encrypts the same content with their
	// own key, so the bytes on disk are not interchangeable.
	Encrypted bool
}

// DedupFileByHash looks up an uploaded file by its plaintext content hash and
// returns the record to respond with:
//
//   - encrypted upload → never deduplicated: every user encrypts the same
//     content with their own key, so the bytes on disk are not interchangeable
//     and reusing another user's ciphertext would break decryption;
//   - the caller's own (hash, original name) record → reused as-is;
//   - the same hash uploaded by somebody else → a new record owned by the
//     caller that points at the already-stored physical file;
//   - unknown hash → Deduped=false so the transport stages the upload.
//
// The caller must not create a physical file when Deduped is true.
func (s *Service) DedupFileByHash(ctx context.Context, upload *FileUpload) (FileUploadCheck, bool, error) {
	if upload.Encrypted {
		return FileUploadCheck{}, false, nil
	}

	// Serialize with the orphan sweep: it may delete the shared blob of this
	// hash, and a record created after that would point at nothing.
	s.fileMu.Lock()
	defer s.fileMu.Unlock()

	if exact, ok := s.store.FindFileByHashAndName(ctx, upload.Hash, upload.OriginalName, upload.Uploader); ok &&
		s.storedBlobExists(exact.StoragePath) {

		return FileUploadCheck{File: exact, ExactMatch: true}, true, nil
	}

	if existing, ok := s.store.FindFileByHash(ctx, upload.Hash); ok && s.storedBlobExists(existing.StoragePath) {
		saved, err := s.store.SaveFile(
			ctx, upload.Hash, upload.MimeType, upload.Size,
			upload.OriginalName, existing.StoragePath, upload.Uploader,
		)
		if err != nil {
			return FileUploadCheck{}, false, err
		}

		return FileUploadCheck{File: saved}, true, nil
	}

	return FileUploadCheck{}, false, nil
}

// storedBlobExists reports whether the bytes of a stored record are still on
// disk. A dedup hit must not reuse a path the GC already removed: the caller
// would get a 404 forever, and re-uploading the same content would hit the
// same broken record again. Reporting "not stored" lets the upload stage the
// bytes and heal the file with a fresh record.
func (s *Service) storedBlobExists(storagePath string) bool {
	if storagePath == "" || s.cfg == nil || s.cfg.Uploads.Dir == "" {
		return false
	}

	if _, err := os.Stat(filepath.Join(s.cfg.Uploads.Dir, storagePath)); err != nil {
		return false
	}

	return true
}

// UserCanAccessFile reports whether the user may read the file: either
// because they uploaded it, or because it is attached to a message in a chat
// they belong to, or because it is a group chat avatar.
func (s *Service) UserCanAccessFile(ctx context.Context, userID, fileID string) bool {
	file, err := s.store.GetFile(ctx, fileID)
	if err != nil {
		return false
	}

	// The uploader keeps access to their own upload: they hold the content
	// anyway, and the record is what a message attachment points at.
	if file.UploadedBy == userID {
		return true
	}

	// Profile avatars are public to authenticated users: they are shown in
	// search results and chat member lists outside any shared chat.
	if ids, err := s.store.GetUsersByAvatarFileID(ctx, fileID); err == nil && len(ids) > 0 {
		return true
	}

	return s.canReachFileThroughChat(ctx, userID, fileID)
}

// canReachFileThroughChat reports whether the file is attached to a message
// in a chat the user belongs to, or is the avatar of such a chat.
func (s *Service) canReachFileThroughChat(ctx context.Context, userID, fileID string) bool {
	chatIDs, err := s.store.GetFileChats(ctx, fileID)
	if err == nil && len(chatIDs) > 0 {
		chats, err := s.store.GetChatsByIDs(ctx, chatIDs)
		if err == nil {
			for i := range chats {
				if IsMember(&chats[i], userID) {
					return true
				}
			}
		}
	}

	avatarChatIDs, err := s.store.GetChatsByAvatarFileID(ctx, fileID)
	if err == nil && len(avatarChatIDs) > 0 {
		chats, err := s.store.GetChatsByIDs(ctx, avatarChatIDs)
		if err == nil {
			for i := range chats {
				if IsMember(&chats[i], userID) {
					return true
				}
			}
		}
	}

	return false
}

// canAttachFile reports whether the user may attach the file to a message.
// Only the uploader may: a file id or a content hash that leaked from a chat
// must not become a way to keep the content after leaving that chat.
//
// Records written before the ownership column existed have no owner and stay
// attachable by the users who can already reach them through a chat.
func (s *Service) canAttachFile(ctx context.Context, userID, fileID string) bool {
	file, err := s.store.GetFile(ctx, fileID)
	if err != nil {
		return false
	}

	if file.UploadedBy == userID {
		return true
	}

	if file.UploadedBy == "" {
		return s.canReachFileThroughChat(ctx, userID, fileID)
	}

	return false
}

// CanAttachFile reports whether the user may attach the file to a message or
// use it as a group avatar.
func (s *Service) CanAttachFile(ctx context.Context, userID, fileID string) bool {
	return s.canAttachFile(ctx, userID, fileID)
}

// ResolveMessageFiles turns the client-supplied file ids and content hashes
// into the list of files the sender is allowed to attach. Unknown or
// forbidden references are dropped instead of rejected: a stale client may
// still name a file that was removed in the meantime, and the message itself
// is worth delivering.
//
// The hashes are resolved inside the caller's own files, so "the server
// already has this content" cannot be used to attach somebody else's upload.
func (s *Service) ResolveMessageFiles(ctx context.Context, userID string, fileIDs, fileHashes []string) []string {
	out := make([]string, 0, len(fileIDs)+len(fileHashes))
	seen := make(map[string]struct{}, len(fileIDs)+len(fileHashes))

	appendFile := func(id string) {
		if id == "" {
			return
		}

		if _, ok := seen[id]; ok {
			return
		}

		seen[id] = struct{}{}
		out = append(out, id)
	}

	for _, fileID := range fileIDs {
		if s.canAttachFile(ctx, userID, fileID) {
			appendFile(fileID)

			continue
		}

		log().Info("dropping file attachment the sender may not attach", "fileID", fileID, "userID", userID)
	}

	for _, hash := range fileHashes {
		file, ok := s.store.FindFileByHashForUploader(ctx, hash, userID)
		if !ok {
			legacy, legacyOK := s.store.FindLegacyFileByHash(ctx, hash)
			if legacyOK && s.canReachFileThroughChat(ctx, userID, legacy.ID) {
				file = legacy
				ok = true
			}
		}

		if !ok {
			log().Info("dropping file attachment the sender does not own", "hash", hash, "userID", userID)

			continue
		}

		appendFile(file.ID)
	}

	return out
}

// FileVisibleToServer reports whether a file is attached to a chat that has a
// member on serverDomain. It is the access check for the federation file
// proxy: the peer requests bytes on behalf of its local member.
func (s *Service) FileVisibleToServer(ctx context.Context, fileID, serverDomain string) bool {
	if serverDomain == "" {
		return false
	}
	chatIDs, err := s.store.GetFileChats(ctx, fileID)
	if err != nil {
		return false
	}
	chats, err := s.store.GetChatsByIDs(ctx, chatIDs)
	if err != nil {
		return false
	}
	for i := range chats {
		for _, memberID := range chats[i].Members {
			if UserIDBelongsToServer(memberID, serverDomain) {
				return true
			}
		}
	}
	return false
}
