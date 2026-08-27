package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	tinyPNG = "\x89PNG\r\n\x1a\nfake-png-bytes"
	htmlDoc = "<!doctype html><html><body><script>alert(1)</script></body></html>"
)

func uploadFile(t *testing.T, h *Handler, token, filename, body string) (int, string) {
	t.Helper()

	var buf bytes.Buffer

	mw := multipart.NewWriter(&buf)

	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := fw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}

	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.UploadFile)(w, req)

	var resp struct {
		File struct {
			ID string `json:"id"`
		} `json:"file"`
	}

	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, string(w.Body.Bytes()))
	}

	return w.Code, resp.File.ID
}

func uploadAndGetFileID(t *testing.T, h *Handler, token, filename, body string) string {
	t.Helper()

	code, id := uploadFile(t, h, token, filename, body)
	if code != http.StatusCreated {
		t.Fatalf("upload: %d", code)
	}

	if id == "" {
		t.Fatalf("upload response missing id")
	}

	return id
}

func TestUploadFileDetectsPNGFromBody(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")

	// Claim text/html in the multipart header but ship PNG bytes.
	id := uploadAndGetFileID(t, h, alice.token, "evil.html", tinyPNG)

	f, err := h.store.GetFile(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(f.MimeType, "image/png") {
		t.Errorf("expected image/png detected from body, got %q", f.MimeType)
	}

	if filepath.Ext(f.OriginalName) != ".html" {
		t.Errorf("original name should be preserved, got %q", f.OriginalName)
	}

	if filepath.Ext(f.StoragePath) != "" {
		t.Errorf("storage path must have no extension, got %q", f.StoragePath)
	}
}

func TestUploadFileDetectsHTMLFromBody(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")

	// Claim image/png but ship HTML — server should detect text/html.
	id := uploadAndGetFileID(t, h, alice.token, "doc.html", htmlDoc)

	f, err := h.store.GetFile(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(f.MimeType, "text/html") {
		t.Errorf("expected text/html detected from body, got %q", f.MimeType)
	}
}

func TestServeFileForcesAttachmentForHTML(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)
	if chatW.Code != http.StatusCreated {
		t.Fatalf("chat create: %d %s", chatW.Code, chatW.Body.String())
	}

	var resp map[string]any

	if err := json.Unmarshal(chatW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	chatID := resp["chat"].(map[string]any)["id"].(string)

	htmlFileID := uploadAndGetFileID(t, h, alice.token, "doc.html", htmlDoc)

	msg, err := h.store.AddMessage(context.Background(), chatID, "", alice.id, alice.id, "see attached", "msg-x", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := h.store.AddMessageFiles(context.Background(), msg.ID, []string{htmlFileID}); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodGet, "/api/files/"+htmlFileID, alice.token, "")
	req.SetPathValue("fileId", htmlFileID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.ServeFile)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	disp := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "attachment") {
		t.Errorf("expected attachment disposition for HTML, got %q", disp)
	}

	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("expected X-Content-Type-Options: nosniff")
	}

	if w.Header().Get("Content-Security-Policy") == "" {
		t.Error("expected Content-Security-Policy header")
	}
}

func TestServeFileAllowsInlineForImage(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)

	var resp map[string]any

	if err := json.Unmarshal(chatW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	chatID := resp["chat"].(map[string]any)["id"].(string)

	pngFileID := uploadAndGetFileID(t, h, alice.token, "image.png", tinyPNG)

	msg, err := h.store.AddMessage(context.Background(), chatID, "", alice.id, alice.id, "img", "msg-img", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := h.store.AddMessageFiles(context.Background(), msg.ID, []string{pngFileID}); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodGet, "/api/files/"+pngFileID, alice.token, "")
	req.SetPathValue("fileId", pngFileID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.ServeFile)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	disp := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "inline") {
		t.Errorf("expected inline disposition for image, got %q", disp)
	}
}

func TestServeFileRejectsNonMember(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	eve := registerTestUser(t, h, "eve", "eve@test.local")

	fileID := uploadAndGetFileID(t, h, alice.token, "x.png", tinyPNG)

	req := authReq(http.MethodGet, "/api/files/"+fileID, eve.token, "")
	req.SetPathValue("fileId", fileID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.ServeFile)(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestUploadFileRespectsSizeLimit(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")

	prev := maxUploadSize
	maxUploadSize = 100 * 1024

	t.Cleanup(func() { maxUploadSize = prev })

	big := bytes.Repeat([]byte("A"), 200*1024)

	var buf bytes.Buffer

	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "big.bin")
	_, _ = fw.Write(big)
	mw.Close()

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+alice.token)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.UploadFile)(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413, got %d", w.Code)
	}
}

func TestUploadFileCreatesFileOnDisk(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")

	id := uploadAndGetFileID(t, h, alice.token, "x.png", tinyPNG)

	f, err := h.store.GetFile(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}

	full := filepath.Join(tmp, f.StoragePath)
	if _, err := os.Stat(full); err != nil {
		t.Errorf("expected file on disk at %s: %v", full, err)
	}

	got, err := os.ReadFile(full) //nolint:gosec // controlled path
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, []byte(tinyPNG)) {
		t.Errorf("on-disk content mismatch")
	}
}

func TestUploadFileSameContentSameNameReusesRecord(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")

	firstID := uploadAndGetFileID(t, h, alice.token, "same.png", tinyPNG)

	// Same content + same name: the existing record is returned as-is.
	code, secondID := uploadFile(t, h, alice.token, "same.png", tinyPNG)
	if code != http.StatusOK {
		t.Fatalf("expected 200 for an identical upload, got %d", code)
	}
	if secondID != firstID {
		t.Fatalf("expected the existing record to be reused, got %q and %q", firstID, secondID)
	}

	// A different name creates a new record; repeating that exact
	// (hash, name) pair then reuses it instead of creating a third.
	thirdID := uploadAndGetFileID(t, h, alice.token, "other.png", tinyPNG)
	if thirdID == firstID {
		t.Fatal("expected a new record for a different name")
	}

	code, again := uploadFile(t, h, alice.token, "other.png", tinyPNG)
	if code != http.StatusOK || again != thirdID {
		t.Fatalf("expected the other.png record to be reused: code=%d got=%q want=%q", code, again, thirdID)
	}
}

func TestSaveFileSameHashKeepsSeparateRecords(t *testing.T) {
	h := newTestHandler(t)

	hash := "dedup-hash-test"

	first, err := h.store.SaveFile(context.Background(), hash, "image/png", int64(len(tinyPNG)), "first.png", "20060102/abc")
	if err != nil {
		t.Fatal(err)
	}

	second, err := h.store.SaveFile(context.Background(), hash, "image/png", int64(len(tinyPNG)), "second.png", "20060102/abc")
	if err != nil {
		t.Fatal(err)
	}

	if first.ID == second.ID {
		t.Fatalf("expected separate records for the same hash, got shared ID %q", first.ID)
	}

	if second.OriginalName != "second.png" {
		t.Errorf("expected the second record to keep its own name, got %q", second.OriginalName)
	}
}

func TestUploadFileSameContentDifferentNames(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.Uploads.Dir = tmp

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)
	if chatW.Code != http.StatusCreated {
		t.Fatalf("chat create: %d %s", chatW.Code, chatW.Body.String())
	}

	var resp map[string]any

	if err := json.Unmarshal(chatW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	chatID := resp["chat"].(map[string]any)["id"].(string)

	// Identical bytes, different names: the second upload must create a
	// separate record that reuses the physical file of the first.
	firstID := uploadAndGetFileID(t, h, alice.token, "first.png", tinyPNG)
	secondID := uploadAndGetFileID(t, h, alice.token, "second.png", tinyPNG)

	if firstID == secondID {
		t.Fatalf("expected separate records for identical content, got shared ID %q", firstID)
	}

	first, err := h.store.GetFile(context.Background(), firstID)
	if err != nil {
		t.Fatal(err)
	}

	second, err := h.store.GetFile(context.Background(), secondID)
	if err != nil {
		t.Fatal(err)
	}

	if first.StoragePath != second.StoragePath {
		t.Fatalf("expected both records to share the physical file, got %q and %q", first.StoragePath, second.StoragePath)
	}

	if first.OriginalName != "first.png" || second.OriginalName != "second.png" {
		t.Fatalf("expected per-record names, got %q and %q", first.OriginalName, second.OriginalName)
	}

	// Only one physical file on disk.
	full := filepath.Join(tmp, first.StoragePath)

	if _, err := os.Stat(full); err != nil {
		t.Fatalf("expected physical file at %s: %v", full, err)
	}

	// Serve both records: same bytes, but each keeps its own filename.
	msg, err := h.store.AddMessage(context.Background(), chatID, "", alice.id, alice.id, "attachments", "msg-files", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := h.store.AddMessageFiles(context.Background(), msg.ID, []string{firstID, secondID}); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		id   string
		name string
	}{
		{firstID, "first.png"},
		{secondID, "second.png"},
	} {
		req := authReq(http.MethodGet, "/api/files/"+tc.id, alice.token, "")
		req.SetPathValue("fileId", tc.id)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.ServeFile)(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("serve %s: %d %s", tc.id, w.Code, w.Body.String())
		}

		disp := w.Header().Get("Content-Disposition")

		if !strings.Contains(disp, `filename="`+tc.name+`"`) {
			t.Errorf("expected filename %q in Content-Disposition, got %q", tc.name, disp)
		}

		if !bytes.Equal(w.Body.Bytes(), []byte(tinyPNG)) {
			t.Errorf("expected identical bytes for %s", tc.id)
		}
	}
}
