package store

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

var (
	ErrFileNotFound = errors.New("file not found")
	ErrFileConflict = errors.New("federated file id conflict")
)

// SaveFile inserts a new file record owned by uploadedBy. The same content
// can be uploaded under different names: each upload gets its own record (and
// its own original name), while all records sharing a hash point at the same
// StoragePath on disk — the physical file is written only once.
//
// uploadedBy is the account that performed the upload. It is what makes the
// attachment rights checkable later: only the owner may attach the file.
func (s *Store) SaveFile(ctx context.Context, hash, mimeType string, size int64, originalName, storagePath, uploadedBy string) (*model.File, error) {
	return s.SaveFileEncrypted(ctx, hash, mimeType, size, originalName, storagePath, uploadedBy, false)
}

// SaveFileEncrypted stores file metadata and whether the bytes are ciphertext.
func (s *Store) SaveFileEncrypted(
	ctx context.Context, hash, mimeType string, size int64,
	originalName, storagePath, uploadedBy string, encrypted bool,
) (*model.File, error) {

	file := &model.File{
		ID:           GenerateID(),
		Hash:         hash,
		MimeType:     mimeType,
		Size:         size,
		OriginalName: originalName,
		StoragePath:  storagePath,
		UploadedBy:   uploadedBy,
		Encrypted:    encrypted,
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
	if err := s.db.WithContext(ctx).Where("hash = ? AND encrypted = ? AND remote_server = ?", hash, false, "").First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

// FindFileByHashForUploader returns the record the given user owns for the
// hash. A user may only attach files they uploaded themselves, so resolving
// a client-supplied hash has to be scoped to the caller.
func (s *Store) FindFileByHashForUploader(ctx context.Context, hash, uploadedBy string) (*model.File, bool) {
	var file model.File
	err := s.db.WithContext(ctx).
		Where("hash = ? AND uploaded_by = ? AND encrypted = ? AND remote_server = ?", hash, uploadedBy, false, "").
		First(&file).Error
	if err != nil {
		return nil, false
	}

	return &file, true
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
		Where("hash = ? AND uploaded_by = ? AND encrypted = ? AND remote_server = ?", hash, uploadedBy, false, "").
		Count(&count).Error; err != nil {
		return false
	}

	return count > 0
}

// FindFileByHashAndName returns the record the given user owns for the exact
// (hash, original name) pair. It is used to reuse the user's own record when
// the same content is uploaded again under the same name.
func (s *Store) FindFileByHashAndName(ctx context.Context, hash, name, uploadedBy string) (*model.File, bool) {
	var file model.File
	err := s.db.WithContext(ctx).
		Where("hash = ? AND original_name = ? AND uploaded_by = ? AND encrypted = ? AND remote_server = ?", hash, name, uploadedBy, false, "").
		First(&file).Error
	if err != nil {
		return nil, false
	}

	return &file, true
}

func (s *Store) GetFile(ctx context.Context, fileID string) (*model.File, error) {
	var f model.File
	if err := s.db.WithContext(ctx).First(&f, "id = ?", fileID).Error; err != nil {
		return nil, ErrFileNotFound
	}

	return &f, nil
}

func (s *Store) AddMessageFiles(ctx context.Context, messageID string, fileIDs []string) error {
	// Deduplicate first: ["a","a"] with a live "a" must attach once, not
	// fail the existence check (1 != 2) nor hit the primary key.
	seen := make(map[string]struct{}, len(fileIDs))
	unique := make([]string, 0, len(fileIDs))
	for _, fid := range fileIDs {
		if _, ok := seen[fid]; ok {
			continue
		}
		seen[fid] = struct{}{}
		unique = append(unique, fid)
	}
	fileIDs = unique
	if len(fileIDs) == 0 {
		return nil
	}

	// The message itself must exist: without REFERENCES the link rows
	// would otherwise dangle on a ghost id.
	var msgCount int64
	if err := s.db.WithContext(ctx).Model(&model.Message{}).Where("id = ?", messageID).Count(&msgCount).Error; err != nil {
		return err
	}
	if msgCount == 0 {
		return ErrMessageNotFound
	}

	// A retry after an idempotent send must not fail on the primary key,
	// and a typo must not leave a dangling link.
	var existing int64
	if err := s.db.WithContext(ctx).Model(&model.File{}).Where("id IN ?", fileIDs).Count(&existing).Error; err != nil {
		return err
	}

	if existing != int64(len(fileIDs)) {
		return ErrFileNotFound
	}

	rows := make([]model.MessageFile, 0, len(fileIDs))
	for _, fid := range fileIDs {
		rows = append(rows, model.MessageFile{MessageID: messageID, FileID: fid})
	}

	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
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
	for start := 0; start < len(messageIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(messageIDs))

		var chunk []model.MessageFile
		if err := s.db.WithContext(ctx).Where("message_id IN ?", messageIDs[start:end]).Find(&chunk).Error; err != nil {
			return nil, err
		}

		links = append(links, chunk...)
	}

	if len(links) == 0 {
		return out, nil
	}

	fileIDs := make([]string, 0, len(links))
	for _, link := range links {
		fileIDs = append(fileIDs, link.FileID)
	}

	var files []model.File
	for start := 0; start < len(fileIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(fileIDs))

		var chunk []model.File
		if err := s.db.WithContext(ctx).Where("id IN ?", fileIDs[start:end]).Find(&chunk).Error; err != nil {
			return nil, err
		}

		files = append(files, chunk...)
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

// CreateRemoteFile stores metadata for a file whose bytes remain on the
// sender's server. StoragePath is intentionally empty: the transport serves
// it through the federation proxy instead of the local uploads directory.
func (s *Store) CreateRemoteFile(ctx context.Context, file *model.File) error {
	file.StoragePath = ""
	if file.CreatedAt.IsZero() {
		file.CreatedAt = time.Now().UTC()
	}
	var existing model.File
	err := s.db.WithContext(ctx).Where("id = ?", file.ID).First(&existing).Error
	if err == nil {
		if existing.RemoteServer == file.RemoteServer && existing.UploadedBy == file.UploadedBy {
			return nil
		}
		return ErrFileConflict
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return s.db.WithContext(ctx).Create(file).Error
}

// DeleteOrphanFilesBefore removes file records created before the cutoff that
// are not attached to a message and are not a user or chat avatar. It returns
// the deleted row count and the storage paths that no surviving row references
// any more; the caller removes those bytes from disk.
//
// Remote placeholders are skipped: their bytes live on another server and the
// row itself is the only way to proxy them. The reference check and the delete
// run in one transaction, so an upload that is attached concurrently is either
// seen by the check or fails to attach to a removed id.
func (s *Store) DeleteOrphanFilesBefore(ctx context.Context, before time.Time, limit int) (int, []string, error) {
	if limit <= 0 {
		return 0, nil, nil
	}

	messageFiles := s.db.Model(&model.MessageFile{}).Select("file_id")
	userAvatars := s.db.Model(&model.User{}).Select("avatar_file_id").Where("avatar_file_id <> ''")
	chatAvatars := s.db.Model(&model.Chat{}).Select("avatar_file_id").Where("avatar_file_id <> ''")

	var candidates []model.File
	if err := s.db.WithContext(ctx).
		Where("created_at < ? AND remote_server = ''", before).
		Where("id NOT IN (?)", messageFiles).
		Where("id NOT IN (?)", userAvatars).
		Where("id NOT IN (?)", chatAvatars).
		Order("created_at ASC").
		Limit(limit).
		Find(&candidates).Error; err != nil {
		return 0, nil, err
	}
	if len(candidates) == 0 {
		return 0, nil, nil
	}

	paths := make(map[string]struct{}, len(candidates))
	deleted := 0

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for i := range candidates {
			file := &candidates[i]
			var references int64

			for _, ref := range []struct {
				model any
				where string
			}{
				{&model.MessageFile{}, "file_id = ?"},
				{&model.User{}, "avatar_file_id = ?"},
				{&model.Chat{}, "avatar_file_id = ?"},
			} {
				var count int64
				if err := tx.Model(ref.model).Where(ref.where, file.ID).Count(&count).Error; err != nil {
					return err
				}
				references += count
			}

			if references > 0 {
				continue
			}

			result := tx.Delete(&model.File{}, "id = ?", file.ID)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				continue
			}
			deleted++
			if file.StoragePath != "" {
				paths[file.StoragePath] = struct{}{}
			}
		}

		return nil
	})
	if err != nil {
		return 0, nil, err
	}

	unused := make([]string, 0, len(paths))
	for path := range paths {
		var stillUsed int64
		if err := s.db.WithContext(ctx).Model(&model.File{}).
			Where("storage_path = ?", path).Count(&stillUsed).Error; err != nil {
			// Keep the bytes: reporting the row as deleted but leaving the
			// file is harmless, deleting a shared blob is not.
			slog.Warn("orphan file GC: reference check failed", "path", path, "err", err)
			continue
		}
		if stillUsed == 0 {
			unused = append(unused, path)
		}
	}

	return deleted, unused, nil
}

// GetFilesByIDs loads file metadata for many ids in one query.
//
//nolint:dupl // mirrors the generic bot batch loader.
func (s *Store) GetFilesByIDs(ctx context.Context, ids []string) map[string]*model.File {
	out := make(map[string]*model.File, len(ids))
	if len(ids) == 0 {
		return out
	}
	for start := 0; start < len(ids); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(ids))
		var files []model.File
		if err := s.db.WithContext(ctx).Where("id IN ?", ids[start:end]).Find(&files).Error; err != nil {
			slog.Warn("GetFilesByIDs failed", "err", err)
			continue
		}
		for idx := range files {
			out[files[idx].ID] = &files[idx]
		}
	}
	return out
}
