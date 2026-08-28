#!/usr/bin/env bash
# Deep static analysis of the TypeScript/React frontend with CodeQL.
# Emits SARIF to .codeql/sarif/. The JS/TS extractor needs no build.
#
# Usage: scripts/codeql-js.sh          # recreate DB, analyze
#        scripts/codeql-js.sh analyze # keep existing DB, re-analyze
set -euo pipefail

CODEQL="${CODEQL:-${HOME}/Apps/codeql/codeql}"
PACKS="${CODEQL_PACKS:-${HOME}/.cache/codeql-packs}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${ROOT}/.codeql/javascript"
SARIF="${ROOT}/.codeql/sarif/javascript.sarif"

mkdir -p "${PACKS}" "$(dirname "${SARIF}")"

echo ">> [codeql] ensuring javascript query pack"
"${CODEQL}" pack download codeql/javascript-queries:javascript-code-scanning --dir="${PACKS}" >/dev/null

shopt -s nullglob
SUITE=("${PACKS}"/javascript-queries/*/codeql-suites/javascript-code-scanning.qls)
shopt -u nullglob
if ((${#SUITE[@]} == 0)); then
	echo "!! [codeql] javascript query suite not found under ${PACKS}" >&2
	exit 1
fi
SUITE="${SUITE[0]}"

if [[ "${1:-}" != "analyze" ]]; then
	echo ">> [codeql] creating JS/TS database (frontend/src)"
	rm -rf "${DB}"
	"${CODEQL}" database create "${DB}" \
		--language=javascript \
		--source-root="${ROOT}/frontend/src" \
		--build-mode=none \
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