package store

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"fast_chat/model"
)

var (
	ErrFileNotFound = errors.New("file not found")
)

// SaveFile inserts a new file record owned by uploadedBy. The same content
// can be uploaded under different names: each upload gets its own record (and
// its own original name), while all records sharing a hash point at the same
// StoragePath on disk — the physical file is written only once.
//
// uploadedBy is the account that performed the upload. It is what makes the
// attachment rights checkable later: only the owner may attach the file.
func (s *Store) SaveFile(ctx context.Context, hash, mimeType string, size int64, originalName, storagePath, uploadedBy string) (*model.File, error) {
	file := &model.File{
		ID:           GenerateID(),
		Hash:         hash,
		MimeType:     mimeType,
		Size:         size,
		OriginalName: originalName,
		StoragePath:  storagePath,
		UploadedBy:   uploadedBy,
		CreatedAt:    time.Now().UTC(),
	}

	if err := s.db.WithContext(ctx).Create(file).Error; err != nil {
		return nil, err
	}

	return file, nil
}

// FindFileByHash returns any record with the given hash, regardless of owner.
// It answers "does this content exist on disk", which is what the physical
// file dedup needs.
func (s *Store) FindFileByHash(ctx context.Context, hash string) (*model.File, bool) {
	var f model.File
	if err := s.db.WithContext(ctx).Where("hash = ?", hash).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

// FindFileByHashForUploader returns the record the given user owns for the
// hash. A user may only attach files they uploaded themselves, so resolving
// a client-supplied hash has to be scoped to the caller.
func (s *Store) FindFileByHashForUploader(ctx context.Context, hash, uploadedBy string) (*model.File, bool) {
	var f model.File
	if err := s.db.WithContext(ctx).Where("hash = ? AND uploaded_by = ?", hash, uploadedBy).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

// FindLegacyFileByHash returns a record stored before the ownership column
// existed. Such records have no owner and stay reachable only through the
// chats that reference them.
func (s *Store) FindLegacyFileByHash(ctx context.Context, hash string) (*model.File, bool) {
	var f model.File
	if err := s.db.WithContext(ctx).Where("hash = ? AND uploaded_by = ''", hash).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

// FileExistsByHash reports whether the given user already has a file with the
// hash. The check is scoped to the caller: it is a deduplication hint for
// their own uploads, not a global oracle over the content of other users.
func (s *Store) FileExistsByHash(ctx context.Context, hash, uploadedBy string) bool {
	var count int64
	if err := s.db.WithContext(ctx).Model(&model.File{}).
		Where("hash = ? AND uploaded_by = ?", hash, uploadedBy).
		Count(&count).Error; err != nil {
		return false
	}

	return count > 0
}

// FindFileByHashAndName returns the record the given user owns for the exact
// (hash, original name) pair. It is used to reuse the user's own record when
// the same content is uploaded again under the same name.
func (s *Store) FindFileByHashAndName(ctx context.Context, hash, name, uploadedBy string) (*model.File, bool) {
	var f model.File
	if err := s.db.WithContext(ctx).Where("hash = ? AND original_name = ? AND uploaded_by = ?", hash, name, uploadedBy).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

func (s *Store) GetFile(ctx context.Context, fileID string) (*model.File, error) {
	var f model.File
	if err := s.db.WithContext(ctx).First(&f, "id = ?", fileID).Error; err != nil {
		return nil, ErrFileNotFound
	}

	return &f, nil
}

func (s *Store) AddMessageFiles(ctx context.Context, messageID string, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}

	rows := make([]model.MessageFile, 0, len(fileIDs))
	for _, fid := range fileIDs {
		rows = append(rows, model.MessageFile{MessageID: messageID, FileID: fid})
	}

	return s.db.WithContext(ctx).Create(&rows).Error
}

func (s *Store) GetMessageFiles(ctx context.Context, messageID string) ([]model.FileInfo, error) {
	var rows []model.MessageFile
	if err := s.db.WithContext(ctx).Where("message_id = ?", messageID).Find(&rows).Error; err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		return nil, nil
	}

	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.FileID
	}

	var files []model.File
	if err := s.db.WithContext(ctx).Where("id IN ?", ids).Find(&files).Error; err != nil {
		return nil, err
	}

	result := make([]model.FileInfo, len(files))
	for i := range files {
		result[i] = files[i].ToFileInfo()
	}

	return result, nil
}

// GetMessageFilesBatch returns file info for many message IDs in two
// queries (link table + files), regardless of how many messages are
// requested. Use this in handler paths that fan out a list of messages.
func (s *Store) GetMessageFilesBatch(ctx context.Context, messageIDs []string) (map[string][]model.FileInfo, error) {
	out := make(map[string][]model.FileInfo, len(messageIDs))
	if len(messageIDs) == 0 {
		return out, nil
	}

	var links []model.MessageFile
	if err := s.db.WithContext(ctx).Where("message_id IN ?", messageIDs).Find(&links).Error; err != nil {
		return nil, err
	}

	if len(links) == 0 {
		return out, nil
	}

	fileIDs := make([]string, 0, len(links))
	for _, link := range links {
		fileIDs = append(fileIDs, link.FileID)
	}

	var files []model.File
	if err := s.db.WithContext(ctx).Where("id IN ?", fileIDs).Find(&files).Error; err != nil {
		return nil, err
	}

	filesByID := make(map[string]model.File, len(files))
	for i := range files {
		filesByID[files[i].ID] = files[i]
	}

	for _, link := range links {
		file, ok := filesByID[link.FileID]
		if !ok {
			continue
		}

		out[link.MessageID] = append(out[link.MessageID], file.ToFileInfo())
	}

	return out, nil
}

// GetMessageFilesForReply returns files for embedding into a ReplyToInfo.
// It silently swallows errors and returns nil on failure to keep the caller paths simple.
func (s *Store) GetMessageFilesForReply(ctx context.Context, messageID string) []model.FileInfo {
	files, err := s.GetMessageFiles(ctx, messageID)
	if err != nil {
		slog.Warn("GetMessageFilesForReply", "messageID", messageID, "err", err)
		return nil
	}

	return files
}

func (s *Store) GetFileChats(ctx context.Context, fileID string) ([]string, error) {
	var rows []model.MessageFile
	if err := s.db.WithContext(ctx).Where("file_id = ?", fileID).Find(&rows).Error; err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		return nil, nil
	}

	msgIDs := make([]string, len(rows))
	for i, r := range rows {
		msgIDs[i] = r.MessageID
	}

	var msgs []model.Message
	if err := s.db.WithContext(ctx).Where("id IN ?", msgIDs).Find(&msgs).Error; err != nil {
		return nil, err
	}

	seen := make(map[string]struct{})

	var chatIDs []string

	for idx := range msgs {
		cid := msgs[idx].ChatID

		if _, ok := seen[cid]; !ok {
			seen[cid] = struct{}{}
			chatIDs = append(chatIDs, cid)
		}
	}

	return chatIDs, nil
}
