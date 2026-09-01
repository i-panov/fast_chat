package service

import (
	"context"

	"fast_chat/model"
)

// IsHexString reports whether s consists solely of hexadecimal characters.
func IsHexString(s string) bool {
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

// DedupFileByHash looks up an uploaded file by its plaintext content hash and
// returns the record to respond with, mirroring the transport's dedup rules:
//
//   - exact (hash, original name) pair already stored → reuse it as-is;
//   - same hash, different name → create a new record that points at the
//     already-stored physical file (the content exists on disk);
//   - hash unknown → Deduped=false so the transport stages the upload.
//
// The caller must not create a physical file when Deduped is true.
func (s *Service) DedupFileByHash(ctx context.Context, hash, mimeType string, size int64, originalName string) (FileUploadCheck, bool, error) {
	if exact, ok := s.store.FindFileByHashAndName(ctx, hash, originalName); ok {
		return FileUploadCheck{File: exact, ExactMatch: true}, true, nil
	}

	if existing, ok := s.store.FindFileByHash(ctx, hash); ok {
		saved, err := s.store.SaveFile(ctx, hash, mimeType, size, originalName, existing.StoragePath)
		if err != nil {
			return FileUploadCheck{}, false, err
		}

		return FileUploadCheck{File: saved}, true, nil
	}

	return FileUploadCheck{}, false, nil
}

// UserCanAccessFile reports whether the user may read the file: either via a
// message attachment in a chat they belong to, or as a group chat avatar.
func (s *Service) UserCanAccessFile(ctx context.Context, userID, fileID string) bool {
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
