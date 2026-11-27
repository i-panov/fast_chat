package transport

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/filestage"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

const (
	// msgSaveFileMetadata is shared by the upload and dedup failure paths.
	msgSaveFileMetadata = "failed to save file metadata"
	// Federated file responses carry the raw ciphertext, so the JSON cap of
	// the federation client does not apply. Keep a margin above the upload
	// limit and bound how many copies may be in memory at once.
	federatedFileMaxBytes = 64 << 20
	federatedFileWorkers  = 4
	// A client that stops reading must not pin a proxy slot forever.
	federatedFileWriteTimeout = 5 * time.Minute
	// The peer body is cancelled when the stream runs longer than this.
	federatedFileStreamTimeout = 15 * time.Minute
	// Waiting for a free proxy slot is bounded, so a burst cannot pile up
	// goroutines behind a stalled transfer.
	federatedFileSlotTimeout = 10 * time.Second
)

// ErrFederatedFileBusy reports that all proxy slots stayed busy past the
// wait budget.
var ErrFederatedFileBusy = errors.New("federated file proxy is busy")

var federatedFileSlots = make(chan struct{}, federatedFileWorkers)

// releaseReadCloser releases the concurrency slot exactly once, when the
// streamed response body is closed.
type releaseReadCloser struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (r *releaseReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(r.release)
	return err
}

// RegisterFiles adds the file upload, download, and existence-check
// operations.
func RegisterFiles(api huma.API, st *store.Store, svc *service.Service, fed *federation.Client, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "upload-file",
		Method:      http.MethodPost,
		Path:        "/api/files/upload",
		Summary:     "Upload a file (multipart/form-data)",
		Security:    []map[string][]string{{bearerScheme: {}}},
		// The upload streams through ParseMultipartForm; its own 50MB
		// MaxBytesReader applies instead of Huma's 1MB default.
		MaxBodyBytes: filestage.MaxUploadSize,
	}, func(ctx context.Context, _ *struct{}) (*uploadFileOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		rawRequest, hasRequest := requestFromContext(ctx)
		rawWriter, hasWriter := responseWriterFromContext(ctx)
		if !hasRequest || !hasWriter {
			return nil, errInternal
		}

		return uploadFile(ctx, st, svc, cfg, user.ID, rawWriter, rawRequest)
	})

	registerServeFile(api, st, svc, fed, cfg)

	huma.Register(api, huma.Operation{
		OperationID: "file-exists",
		Method:      http.MethodGet,
		Path:        "/api/files/exists",
		Summary:     "Check content-hash existence for dedup",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, input *fileExistsInput) (*fileExistsOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		if input.Hash == "" {
			return nil, &statusError{ErrorMessage: "hash parameter required", code: http.StatusBadRequest}
		}

		// The upload path normalizes the hash to lowercase; the existence
		// check must do the same, or an uppercase hash answers false for a
		// file the server already has.
		hash := strings.ToLower(input.Hash)

		if len(hash) != 64 || !service.IsHexString(hash) {
			return nil, &statusError{ErrorMessage: "invalid hash format", code: http.StatusBadRequest}
		}

		var out fileExistsOutput
		out.Body.Exists = st.FileExistsByHash(ctx, hash, user.ID)

		return &out, nil
	})
}

// openFederatedFile acquires a proxy slot and opens the peer's file stream.
// The returned release function must be called exactly once, when the body is
// closed.
func openFederatedFile(
	ctx context.Context,
	fed *federation.Client,
	remoteServer, fileID string,
) (*http.Response, func(), error) {

	timer := time.NewTimer(federatedFileSlotTimeout)
	defer timer.Stop()

	select {
	case federatedFileSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case <-timer.C:
		return nil, nil, ErrFederatedFileBusy
	}

	streamCtx, cancel := context.WithTimeout(ctx, federatedFileStreamTimeout)
	release := func() {
		cancel()
		<-federatedFileSlots
	}

	headers := http.Header{}
	if rawRequest, ok := requestFromContext(ctx); ok {
		for _, name := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
			if value := rawRequest.Header.Get(name); value != "" {
				headers.Set(name, value)
			}
		}
	}

	remoteURL := fed.URL(remoteServer, "/api/federated/files/"+url.PathEscape(fileID))
	resp, err := fed.OpenStream(streamCtx, http.MethodGet, remoteURL, nil, federatedFileMaxBytes, headers)
	if err != nil {
		release()
		return nil, nil, err
	}
	return resp, release, nil
}

// federatedFileStreamError maps a peer refusal to the same status locally.
// A 416 keeps its Content-Range and is rendered as a stream response: Huma's
// error type cannot carry response headers.
func federatedFileStreamError(err error) (*huma.StreamResponse, error) {
	if errors.Is(err, ErrFederatedFileBusy) {
		return nil, &statusError{ErrorMessage: "file proxy is busy", code: http.StatusServiceUnavailable}
	}
	if errors.Is(err, federation.ErrResponseTooLarge) {
		return nil, &statusError{ErrorMessage: "federated file is too large", code: http.StatusBadGateway}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil, &statusError{ErrorMessage: "request cancelled", code: http.StatusServiceUnavailable}
	}

	var statusErr *federation.StatusError
	if !errors.As(err, &statusErr) {
		return nil, &statusError{ErrorMessage: "failed to fetch federated file", code: http.StatusBadGateway}
	}

	switch statusErr.Status {
	case http.StatusRequestedRangeNotSatisfiable:
		contentRange := statusErr.Header.Get("Content-Range")
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			_, w := humachi.Unwrap(hctx)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if contentRange != "" {
				w.Header().Set("Content-Range", contentRange)
			}
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		}}, nil
	case http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests:
		return nil, &statusError{ErrorMessage: "federated file is unavailable", code: statusErr.Status}
	default:
		return nil, &statusError{ErrorMessage: "failed to fetch federated file", code: http.StatusBadGateway}
	}
}

// writeFederatedFile relays a peer's response, including its range status,
// without buffering the whole file.
func writeFederatedFile(w http.ResponseWriter, resp *http.Response, release func(), fileID string) {
	body := &releaseReadCloser{ReadCloser: resp.Body, release: release}
	defer body.Close() //nolint:errcheck // best-effort close

	// A client that stops reading must not hold the slot until the peer
	// times out: the write deadline aborts the copy.
	controller := http.NewResponseController(w)
	if deadlineErr := controller.SetWriteDeadline(time.Now().Add(federatedFileWriteTimeout)); deadlineErr != nil {
		slog.Warn("cannot set federated file write deadline", "fileID", fileID, "err", deadlineErr)
	}

	w.Header().Set("Accept-Ranges", "bytes")
	if lastModified := resp.Header.Get("Last-Modified"); lastModified != "" {
		w.Header().Set("Last-Modified", lastModified)
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}
	if resp.StatusCode == http.StatusNotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if contentType := resp.Header.Get("Content-Type"); strings.HasPrefix(contentType, "multipart/byteranges") {
		w.Header().Set("Content-Type", contentType)
	}
	if resp.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	if contentRange := resp.Header.Get("Content-Range"); contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}

	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, body); err != nil {
		slog.Warn("federated file stream interrupted", "fileID", fileID, "err", err)
		// The response is already committed; a clean return would make a
		// truncated body look complete on chunked responses.
		panic(http.ErrAbortHandler)
	}
}

// registerServeFile streams local and federated attachments. Split out of
// RegisterFiles so the registration function stays within the complexity
// budget.
func registerServeFile(api huma.API, st *store.Store, svc *service.Service, fed *federation.Client, cfg *config.Config) {
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
			if errors.Is(err, store.ErrFileNotFound) {
				return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusNotFound}
			}
			slog.Error("failed to load file record", "fileID", input.FileID, "err", err)

			return nil, errInternal
		}

		if !svc.UserCanAccessFile(ctx, user.ID, input.FileID) {
			return nil, &statusError{ErrorMessage: "not a member", code: http.StatusForbidden}
		}

		mimeType := fileRecord.MimeType
		originalName := fileRecord.OriginalName

		var remoteResp *http.Response
		var releaseSlot func()
		if fileRecord.RemoteServer != "" {
			if fed == nil {
				return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusNotFound}
			}
			// The generic federation client caps JSON responses at 10 MiB,
			// below the 50 MiB upload limit. Stream the bytes with their own
			// cap so a large attachment never sits in memory whole; the slot
			// is held until the response body is closed.
			//nolint:bodyclose // writeFederatedFile closes the response
			resp, release, streamErr := openFederatedFile(
				ctx, fed, fileRecord.RemoteServer, input.FileID,
			)
			if streamErr != nil {
				slog.Warn("federated file stream failed", "fileID", input.FileID, "err", streamErr)
				return federatedFileStreamError(streamErr)
			}
			remoteResp = resp
			releaseSlot = release
		}

		fullPath := filepath.Join(cfg.Uploads.Dir, fileRecord.StoragePath)

		// Check the blob before the headers are written: http.ServeFile would
		// otherwise send a 404 body under the attachment headers, and the
		// browser would save "404 page not found" as the file. The path must
		// stay inside the uploads directory, like the GC insists: a corrupted
		// row must not turn a download into an arbitrary file read.
		if remoteResp == nil {
			if !isInsideUploads(cfg.Uploads.Dir, fileRecord.StoragePath) {
				slog.Error("refusing to serve a file outside the uploads directory", "fileID", input.FileID)

				return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusNotFound}
			}
			if _, statErr := os.Stat(fullPath); statErr != nil {
				return nil, &statusError{ErrorMessage: msgFileNotFound, code: http.StatusNotFound}
			}
		}

		return &huma.StreamResponse{
			Body: func(hctx huma.Context) {
				r, w := humachi.Unwrap(hctx)

				// Defense in depth: never MIME-sniff or execute inline scripts,
				// and force download for anything that could be HTML/JS/SVG.
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
				w.Header().Set("Content-Type", mimeType)

				disposition := "attachment"
				if filestage.IsInlinableMIME(mimeType) {
					disposition = "inline"
				}

				w.Header().Set("Content-Disposition", filestage.ContentDisposition(disposition, originalName))
				w.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(mimeCacheMaxAge))

				if remoteResp != nil {
					writeFederatedFile(w, remoteResp, releaseSlot, input.FileID)
					return
				}
				http.ServeFile(w, r, fullPath)
			},
		}, nil
	})
}

// isInsideUploads reports whether the stored relative path resolves inside the
// uploads root.
func isInsideUploads(root, relativePath string) bool {
	if relativePath == "" {
		return false
	}

	cleanRoot := filepath.Clean(root)
	full := filepath.Join(cleanRoot, relativePath)

	rel, err := filepath.Rel(cleanRoot, full)
	if err != nil || rel == ".." || filepath.IsAbs(rel) {
		return false
	}

	return !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// mimeCacheMaxAge matches the pre-migration file cache duration (one day).
const mimeCacheMaxAge = 86400

// multipartMaxMemory bounds how much of an upload ParseMultipartForm keeps in
// RAM; the rest spills to disk. The total body is already capped by
// MaxBytesReader at MaxUploadSize, so this is only the memory/disk threshold.
const multipartMaxMemory = 1 << 20

// uploadFile mirrors the pre-migration multipart upload flow: cap, parse, stage,
// dedup, persist. uploader is the account that owns the resulting file
// record: only the owner may attach it to a message later.
func uploadFile(
	ctx context.Context,
	st *store.Store,
	svc *service.Service,
	cfg *config.Config,
	uploader string,
	w http.ResponseWriter,
	r *http.Request,
) (*uploadFileOutput, error) {

	r.Body = http.MaxBytesReader(w, r.Body, filestage.MaxUploadSize)

	if err := r.ParseMultipartForm(multipartMaxMemory); err != nil {
		if _, isTooLarge := errors.AsType[*http.MaxBytesError](err); isTooLarge { //nolint:errcheck // the boolean is the result
			return nil, &statusError{ErrorMessage: "file too large", code: http.StatusRequestEntityTooLarge}
		}
		// A broken multipart body, a missing field or a truncated request is
		// a client error, not "the file is too large".
		return nil, &statusError{ErrorMessage: "invalid multipart body", code: http.StatusBadRequest}
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, &statusError{ErrorMessage: "missing file", code: http.StatusBadRequest}
	}

	defer file.Close() //nolint:errcheck // best-effort: failure is not actionable

	clientHash, encrypted, errKey := filestage.ParseFileHash(r)
	if errKey != "" {
		return nil, &statusError{ErrorMessage: errKey, code: http.StatusBadRequest}
	}
	if bot, ok := st.GetBot(ctx, uploader); ok && bot.EncryptionMode == "e2ee" && !encrypted {
		return nil, &statusError{ErrorMessage: "encrypted file required for this bot", code: http.StatusBadRequest}
	}

	staged, err := filestage.StageAndHashFile(file, clientHash, encrypted, cfg.Uploads.Dir)
	if err != nil {
		// The stage limit is defense in depth behind MaxBytesReader: a
		// client that trips it sends something that can never succeed,
		// so 413 (not a retriable 500) is the honest status.
		if errors.Is(err, filestage.ErrFileTooLarge) {
			return nil, &statusError{ErrorMessage: "file too large", code: http.StatusRequestEntityTooLarge}
		}
		slog.Error("failed to stage file", "err", err)
		return nil, &statusError{ErrorMessage: "failed to process file", code: http.StatusInternalServerError}
	}

	defer os.Remove(staged.TempPath) //nolint:errcheck // best-effort: failure is not actionable

	if quotaErr := svc.EnsureUploadQuota(ctx, uploader, staged.Size); quotaErr != nil {
		if errors.Is(quotaErr, service.ErrUploadQuotaExceeded) {
			return nil, &statusError{ErrorMessage: "storage quota exceeded", code: http.StatusRequestEntityTooLarge}
		}
		slog.Error("failed to check the upload quota", "err", quotaErr)

		return nil, &statusError{ErrorMessage: msgSaveFileMetadata, code: http.StatusInternalServerError}
	}

	check, deduped, err := svc.DedupFileByHash(ctx, &service.FileUpload{
		Hash:         staged.Hash,
		MimeType:     staged.MimeType,
		Size:         staged.Size,
		OriginalName: header.Filename,
		Uploader:     uploader,
		Encrypted:    encrypted,
	})
	if err != nil {
		slog.Error("failed to dedup file", "err", err)
		return nil, &statusError{ErrorMessage: msgSaveFileMetadata, code: http.StatusInternalServerError}
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

	if err := os.Rename(staged.TempPath, staged.FullPath); err != nil {
		return nil, &statusError{ErrorMessage: "failed to save file", code: http.StatusInternalServerError}
	}

	saved, err := st.SaveFileEncrypted(ctx, staged.Hash, staged.MimeType, staged.Size, header.Filename, staged.RelativePath, uploader, encrypted)
	if err != nil {
		// The rename already happened, so the deferred TempPath cleanup no
		// longer applies: remove the renamed file best-effort instead of
		// leaving an orphan with no DB row.
		os.Remove(staged.FullPath) //nolint:errcheck,gosec // best-effort: already failing
		return nil, &statusError{ErrorMessage: msgSaveFileMetadata, code: http.StatusInternalServerError}
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
