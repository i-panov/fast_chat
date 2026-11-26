package transport

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fast_chat/federation"
)

func TestWriteFederatedFileRelaysRangeHeaders(t *testing.T) {
	recorder := httptest.NewRecorder()
	released := 0
	resp := &http.Response{
		StatusCode:    http.StatusPartialContent,
		Header:        http.Header{"Content-Range": []string{"bytes 0-2/10"}},
		Body:          io.NopCloser(strings.NewReader("abc")),
		ContentLength: 3,
	}

	writeFederatedFile(recorder, resp, func() { released++ }, "f1")

	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", recorder.Code)
	}
	if got := recorder.Body.String(); got != "abc" {
		t.Fatalf("body = %q, want abc", got)
	}
	if got := recorder.Header().Get("Content-Range"); got != "bytes 0-2/10" {
		t.Errorf("Content-Range = %q", got)
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", got)
	}
	if released != 1 {
		t.Errorf("released = %d, want 1", released)
	}
}

func TestWriteFederatedFileReleasesOnNotModified(t *testing.T) {
	recorder := httptest.NewRecorder()
	released := 0
	header := http.Header{}
	header.Set("ETag", `"v1"`)
	resp := &http.Response{
		StatusCode: http.StatusNotModified,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader("")),
	}

	writeFederatedFile(recorder, resp, func() { released++ }, "f1")

	if recorder.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", recorder.Code)
	}
	if got := recorder.Header().Get("ETag"); got != `"v1"` {
		t.Errorf("ETag = %q", got)
	}
	if released != 1 {
		t.Errorf("released = %d, want 1", released)
	}
}

var errFederatedTestFailure = errors.New("test failure")

func asStatusError(t *testing.T, err error) *statusError {
	t.Helper()
	var statusErr *statusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("error %#v is not *statusError", err)
	}
	return statusErr
}

func TestFederatedFileStreamErrorMapsPeerStatus(t *testing.T) {
	_, err := federatedFileStreamError(&federation.StatusError{Status: http.StatusNotFound})
	if got := asStatusError(t, err).code; got != http.StatusNotFound {
		t.Fatalf("404 mapped to %d", got)
	}

	resp, err := federatedFileStreamError(&federation.StatusError{
		Status: http.StatusRequestedRangeNotSatisfiable,
		Header: http.Header{"Content-Range": []string{"bytes */10"}},
	})
	if err != nil || resp == nil {
		t.Fatalf("416 must be a stream response, got resp=%v err=%v", resp, err)
	}

	_, err = federatedFileStreamError(ErrFederatedFileBusy)
	if got := asStatusError(t, err).code; got != http.StatusServiceUnavailable {
		t.Fatalf("busy mapped to %d", got)
	}

	_, err = federatedFileStreamError(federation.ErrResponseTooLarge)
	if got := asStatusError(t, err).code; got != http.StatusBadGateway {
		t.Fatalf("oversize mapped to %d", got)
	}

	_, err = federatedFileStreamError(errFederatedTestFailure)
	if got := asStatusError(t, err).code; got != http.StatusBadGateway {
		t.Fatalf("unknown error mapped to %d", got)
	}
}
