#!/usr/bin/env bash
# Deep static analysis of the Go backend with CodeQL (SSRF / path
# traversal / cross-cutting taint). Creates a database and analyzes it
# with the code-scanning query suite, emitting SARIF to .codeql/sarif/.
#
# Usage: scripts/codeql-go.sh          # recreate DB, analyze
#        scripts/codeql-go.sh analyze # keep existing DB, re-analyze
set -euo pipefail

CODEQL="${CODEQL:-${HOME}/Apps/codeql/codeql}"
PACKS="${CODEQL_PACKS:-${HOME}/.cache/codeql-packs}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${ROOT}/.codeql/go"
SARIF="${ROOT}/.codeql/sarif/go.sarif"

mkdir -p "${PACKS}" "$(dirname "${SARIF}")"

echo ">> [codeql] ensuring go query pack"
"${CODEQL}" pack download codeql/go-queries:go-code-scanning --dir="${PACKS}" >/dev/null

shopt -s nullglob
SUITE=("${PACKS}"/go-queries/*/codeql-suites/go-code-scanning.qls)
shopt -u nullglob
if ((${#SUITE[@]} == 0)); then
	echo "!! [codeql] go query suite not found under ${PACKS}" >&2
	exit 1
fi
SUITE="${SUITE[0]}"

if [[ "${1:-}" != "analyze" ]]; then
	echo ">> [codeql] creating Go database (backend/, go build ./...)"
	rm -rf "${DB}"
	"${CODEQL}" database create "${DB}" \
		--language=go \
		--source-root="${ROOT}/backend" \
		--command="go build ./..." \
		--search-path="${PACKS}"
fi

echo ">> [codeql] running ${SUITE}"
"${CODEQL}" database analyze "${DB}" \
	--format=sarif-latest \
	--output="${SARIF}" \
	--search-path="${PACKS}" \
	--threads=0 \
	"${SUITE}"

echo ">> done: ${SARIF}"