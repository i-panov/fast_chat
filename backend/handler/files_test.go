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

func uploadAndGetFileID(t *testing.T, h *Handler, token, filename, body string) string {
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

	if w.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}

	bodyBytes := w.Body.Bytes()

	var resp struct {
		File struct {
			ID string `json:"id"`
		} `json:"file"`
	}

	if err := json.Unmarshal(bodyBytes, &resp); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, string(bodyBytes))
	}

	if resp.File.ID == "" {
		t.Fatalf("upload response missing id: %s", string(bodyBytes))
	}

	return resp.File.ID
}

func TestUploadFileDetectsPNGFromBody(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")

	// Claim text/html in the multipart header but ship PNG bytes.
	id := uploadAndGetFileID(t, h, alice.token, "evil.html", tinyPNG)

	f, err := h.store.GetFile(id)
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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")

	// Claim image/png but ship HTML — server should detect text/html.
	id := uploadAndGetFileID(t, h, alice.token, "doc.html", htmlDoc)

	f, err := h.store.GetFile(id)
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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")
	bob := registerTestUser(t, h, "bob")

	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)
	if chatW.Code != http.StatusCreated {
		t.Fatalf("chat create: %d %s", chatW.Code, chatW.Body.String())
	}

	var resp map[string]interface{}

	if err := json.Unmarshal(chatW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	chatID := resp["chat"].(map[string]interface{})["id"].(string)

	htmlFileID := uploadAndGetFileID(t, h, alice.token, "doc.html", htmlDoc)

	msg, err := h.store.AddMessage(chatID, alice.id, alice.id, "see attached", "msg-x", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := h.store.AddMessageFiles(msg.ID, []string{htmlFileID}); err != nil {
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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")
	bob := registerTestUser(t, h, "bob")

	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)

	var resp map[string]interface{}

	if err := json.Unmarshal(chatW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	chatID := resp["chat"].(map[string]interface{})["id"].(string)

	pngFileID := uploadAndGetFileID(t, h, alice.token, "image.png", tinyPNG)

	msg, err := h.store.AddMessage(chatID, alice.id, alice.id, "img", "msg-img", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := h.store.AddMessageFiles(msg.ID, []string{pngFileID}); err != nil {
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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")
	eve := registerTestUser(t, h, "eve")

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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")

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
	h.cfg.UploadDir = tmp

	alice := registerTestUser(t, h, "alice")

	id := uploadAndGetFileID(t, h, alice.token, "x.png", tinyPNG)

	f, err := h.store.GetFile(id)
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

func TestUploadFileDeduplicatesByHash(t *testing.T) {
	tmp := t.TempDir()
	h := newTestHandler(t)
	h.cfg.UploadDir = tmp

	// Write a single byte sequence to disk as if it had been
	// uploaded, then call SaveFile twice with the same hash. The
	// second call must return the same File without inserting a row.
	hash := "dedup-hash-test"

	first, err := h.store.SaveFile(hash, "image/png", int64(len(tinyPNG)), "first.png", "20060102/abc")
	if err != nil {
		t.Fatal(err)
	}

	second, err := h.store.SaveFile(hash, "image/png", int64(len(tinyPNG)), "second.png", "20060102/def")
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != second.ID {
		t.Fatalf("dedup failed: first.ID=%q second.ID=%q", first.ID, second.ID)
	}
}
