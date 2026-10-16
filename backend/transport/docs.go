package transport

import (
	"embed"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Self-hosted Stoplight Elements assets for the /docs page. Vendored from
// @stoplight/elements@9.0.15 (Apache-2.0, see docs-assets/LICENSE) so the API
// documentation works without any third-party CDN. Integrity is verified
// against the SRI hashes pinned in huma's default renderer.
//
//go:embed docs-assets
var docsAssets embed.FS

// docsHTML is the Stoplight Elements page. It points the component at the
// locally served OpenAPI document; no external origins are contacted.
const docsHTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Fast Chat Reference</title>
    <link rel="stylesheet" href="/docs/assets/styles.min.css">
    <script src="/docs/assets/web-components.min.js" defer></script>
  </head>
  <body>
    <elements-api
      apiDescriptionUrl="/openapi.json"
      router="hash"
      layout="sidebar"
    ></elements-api>
  </body>
</html>
`

// registerDocs wires the self-hosted API documentation: an HTML page plus the
// vendored Stoplight Elements bundle. Huma's own DocsPath stays disabled (it
// hardcodes unpkg), while the OpenAPI document and schema browser remain
// served by Huma itself.
func registerDocs(mux *chi.Mux) {
	mux.Get("/docs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// The page only references same-origin assets; inline styles are
		// required by the Stoplight web components, and connect-src 'self' is
		// required for the component to fetch /openapi.json.
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write([]byte(docsHTML)) //nolint:errcheck // best-effort: static page
	})

	mux.Get("/docs/assets/{file}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("file")

		var (
			data        []byte
			contentType string
		)

		switch name {
		case "web-components.min.js":
			data = mustAsset("docs-assets/web-components.min.js")
			contentType = "application/javascript; charset=utf-8"
		case "styles.min.css":
			data = mustAsset("docs-assets/styles.min.css")
			contentType = "text/css; charset=utf-8"
		default:
			http.NotFound(w, r)

			return
		}

		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Static-asset response: data comes from the embedded docs bundle
		// (allowlisted file names only), never from user input; Content-Type
		// is explicit with nosniff. Not an XSS sink.
		// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter
		_, _ = w.Write(data) //nolint:errcheck // best-effort: static asset
	})
}

// mustAsset reads an embedded docs asset; the files are compiled in, so a
// miss is a programming error.
func mustAsset(name string) []byte {
	data, err := docsAssets.ReadFile(name)
	if err != nil {
		panic("docs asset missing: " + err.Error())
	}

	return data
}
