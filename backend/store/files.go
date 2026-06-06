package store

import (
	"errors"
	"time"

	"fast_chat/model"
)

var (
	ErrFileNotFound = errors.New("file not found")
)

func (s *Store) SaveFile(hash, mimeType string, size int64, originalName, storagePath string) (*model.File, error) {
	existing, ok := s.FindFileByHash(hash)
	if ok {
		return existing, nil
	}

	file := &model.File{
		ID:           generateID(),
		Hash:         hash,
		MimeType:     mimeType,
		Size:         size,
		OriginalName: originalName,
		StoragePath:  storagePath,
		CreatedAt:    time.Now(),
	}

	if err := s.db.Create(file).Error; err != nil {
		return nil, err
	}

	return file, nil
}

func (s *Store) FindFileByHash(hash string) (*model.File, bool) {
	var f model.File
	if err := s.db.Where("hash = ?", hash).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

func (s *Store) GetFile(fileID string) (*model.File, error) {
	var f model.File
	if err := s.db.First(&f, "id = ?", fileID).Error; err != nil {
		return nil, ErrFileNotFound
	}

	return &f, nil
}

func (s *Store) AddMessageFiles(messageID string, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}

	rows := make([]model.MessageFile, 0, len(fileIDs))
	for _, fid := range fileIDs {
		rows = append(rows, model.MessageFile{MessageID: messageID, FileID: fid})
	}

	return s.db.Create(&rows).Error
}

func (s *Store) GetMessageFiles(messageID string) ([]model.FileInfo, error) {
	var rows []model.MessageFile
	if err := s.db.Where("message_id = ?", messageID).Find(&rows).Error; err != nil {
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
	if err := s.db.Where("id IN ?", ids).Find(&files).Error; err != nil {
		return nil, err
	}

	result := make([]model.FileInfo, len(files))
	for i, f := range files {
		result[i] = f.ToFileInfo()
	}

	return result, nil
}

// GetMessageFilesBatch returns file info for many message IDs in two
// queries (link table + files), regardless of how many messages are
// requested. Use this in handler paths that fan out a list of messages.
func (s *Store) GetMessageFilesBatch(messageIDs []string) (map[string][]model.FileInfo, error) {
	out := make(map[string][]model.FileInfo, len(messageIDs))
	if len(messageIDs) == 0 {
		return out, nil
	}

	var links []model.MessageFile
	if err := s.db.Where("message_id IN ?", messageIDs).Find(&links).Error; err != nil {
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
	if err := s.db.Where("id IN ?", fileIDs).Find(&files).Error; err != nil {
		return nil, err
	}

	filesByID := make(map[string]model.File, len(files))
	for _, file := range files {
		filesByID[file.ID] = file
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
func (s *Store) GetMessageFilesForReply(messageID string) []model.FileInfo {
	files, err := s.GetMessageFiles(messageID)
	if err != nil {
		return nil
	}

	return files
}

func (s *Store) GetFileChats(fileID string) ([]string, error) {
	var rows []model.MessageFile
	if err := s.db.Where("file_id = ?", fileID).Find(&rows).Error; err != nil {
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
	if err := s.db.Where("id IN ?", msgIDs).Find(&msgs).Error; err != nil {
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
