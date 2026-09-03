package huma

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"

	"fast_chat/config"
	"fast_chat/handler"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

// RegisterFiles adds the file upload, download, and existence-check
// operations.
func RegisterFiles(api huma.API, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "upload-file",
		Method:      http.MethodPost,
		Path:        "/api/files/upload",
		Summary:     "Upload a file (multipart/form-data)",
		Security:    []map[string][]string{{bearerScheme: {}}},
		// The upload streams through ParseMultipartForm; its own 50MB
		// MaxBytesReader applies instead of Huma's 1MB default.
		MaxBodyBytes: handler.MaxUploadSize,
	}, func(ctx context.Context, _ *struct{}) (*uploadFileOutput, error) {
		if _, ok := userFromContext(ctx); !ok {
			return nil, errUnauthorized
		}

		rawRequest, hasRequest := requestFromContext(ctx)
		rawWriter, hasWriter := responseWriterFromContext(ctx)
		if !hasRequest || !hasWriter {
			return nil, errInternal
		}

		return uploadFile(ctx, st, svc, cfg, rawWriter, rawRequest)
	})

	huma.Register(api, huma.Operation{
		OperationID: "serve-file",
		Method:      http.MethodGet,
		Path:        "/api/files/{fileId}",
		Summary:     "Download a file",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *serveFileInput) (*huma.StreamResponse, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		fileRecord, err := st.GetFile(ctx, input.FileID)
		if err != nil {
			return nil, &statusError{ErrorMessage: "file not found", code: http.StatusNotFound}
		}

		if !svc.UserCanAccessFile(ctx, user.ID, input.FileID) {
			return nil, &statusError{ErrorMessage: "not a member", code: http.StatusForbidden}
		}

		fullPath := filepath.Join(cfg.Uploads.Dir, fileRecord.StoragePath)
		mimeType := fileRecord.MimeType
		originalName := fileRecord.OriginalName

		return &huma.StreamResponse{
			Body: func(hctx huma.Context) {
				r, w := humachi.Unwrap(hctx)

				// Defense in depth: never MIME-sniff or execute inline scripts,
				// and force download for anything that could be HTML/JS/SVG.
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
				w.Header().Set("Content-Type", mimeType)

				disposition := "attachment"
				if handler.IsInlinableMIME(mimeType) {
					disposition = "inline"
				}

				w.Header().Set("Content-Disposition", disposition+"; filename=\""+handler.SanitizeFilename(originalName)+"\"")
				w.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(mimeCacheMaxAge))

				http.ServeFile(w, r, fullPath)
			},
		}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "file-exists",
		Method:      http.MethodGet,
		Path:        "/api/files/exists",
		Summary:     "Check content-hash existence for dedup",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *fileExistsInput) (*fileExistsOutput, error) {
		_, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Hash == "" {
			return nil, &statusError{ErrorMessage: "hash parameter required", code: http.StatusBadRequest}
		}

		if len(input.Hash) != 64 || !service.IsHexString(input.Hash) {
			return nil, &statusError{ErrorMessage: "invalid hash format", code: http.StatusBadRequest}
		}

		var out fileExistsOutput
		out.Body.Exists = st.FileExistsByHash(ctx, input.Hash)

		return &out, nil
	})
}

// mimeCacheMaxAge matches the legacy file cache duration (one day).
const mimeCacheMaxAge = 86400

// uploadFile mirrors the legacy multipart upload flow: cap, parse, stage,
// dedup, persist.
func uploadFile(
	ctx context.Context,
	st *store.Store,
	svc *service.Service,
	cfg *config.Config,
	w http.ResponseWriter,
	r *http.Request,
) (*uploadFileOutput, error) {

	r.Body = http.MaxBytesReader(w, r.Body, handler.MaxUploadSize)

	if err := r.ParseMultipartForm(handler.MaxUploadSize); err != nil {
		return nil, &statusError{ErrorMessage: "file too large", code: http.StatusRequestEntityTooLarge}
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, &statusError{ErrorMessage: "missing file", code: http.StatusBadRequest}
	}

	defer file.Close() //nolint:errcheck // best-effort: failure is not actionable

	clientHash, encrypted, errKey := handler.ParseFileHash(r)
	if errKey != "" {
		return nil, &statusError{ErrorMessage: errKey, code: http.StatusBadRequest}
	}

	mimeType, size, hash, tempPath, fullPath, relativePath, err :=
		handler.StageAndHashFile(file, clientHash, encrypted, cfg.Uploads.Dir)
	if err != nil {
		slog.Error("failed to stage file", "err", err)
		return nil, &statusError{ErrorMessage: "failed to process file", code: http.StatusInternalServerError}
	}

	defer os.Remove(tempPath) //nolint:errcheck // best-effort: failure is not actionable

	check, deduped, err := svc.DedupFileByHash(ctx, hash, mimeType, size, header.Filename)
	if err != nil {
		slog.Error("failed to dedup file", "err", err)
		return nil, &statusError{ErrorMessage: "failed to save file metadata", code: http.StatusInternalServerError}
	}

	if deduped {
		status := http.StatusCreated
		if check.ExactMatch {
			status = http.StatusOK
		}

		var out uploadFileOutput
		out.Body.File = check.File.ToFileInfo()
		out.Status = status

		return &out, nil
	}

	if err := os.Rename(tempPath, fullPath); err != nil {
		return nil, &statusError{ErrorMessage: "failed to save file", code: http.StatusInternalServerError}
	}

	saved, err := st.SaveFile(ctx, hash, mimeType, size, header.Filename, relativePath)
	if err != nil {
		return nil, &statusError{ErrorMessage: "failed to save file metadata", code: http.StatusInternalServerError}
	}

	var out uploadFileOutput
	out.Body.File = saved.ToFileInfo()
	out.Status = http.StatusCreated

	return &out, nil
}

type serveFileInput struct {
	FileID string `path:"fileId"`
}

type fileExistsInput struct {
	Hash string `query:"hash"`
}

type fileExistsOutput struct {
	Body struct {
		Exists bool `json:"exists"`
	}
}

type uploadFileOutput struct {
	Status int
	Body   struct {
		File model.FileInfo `json:"file"`
	}
}

func (o *uploadFileOutput) GetStatus() int {
	return o.Status
}
