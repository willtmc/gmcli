#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILT_CLI="${REPO_ROOT}/dist/cli.js"

cd "${REPO_ROOT}"

echo "Building gmcli (dist/cli.js)..."
npm run build

if [[ ! -f "${BUILT_CLI}" ]]; then
	echo "Error: expected built CLI at ${BUILT_CLI}, but it does not exist." >&2
	exit 1
fi

echo "Installing gmcli globally from ${REPO_ROOT}..."
npm install -g .

INSTALLED_BIN="$(command -v gmcli || true)"
if [[ -z "${INSTALLED_BIN}" ]]; then
	echo "Error: 'gmcli' was not found on PATH after 'npm install -g .'." >&2
	exit 1
fi

if [[ ! -x "${INSTALLED_BIN}" ]]; then
	echo "Error: resolved gmcli binary is not executable: ${INSTALLED_BIN}" >&2
	exit 1
fi

if ! cmp -s "${BUILT_CLI}" "${INSTALLED_BIN}"; then
	RESOLVED_REALPATH="$(node -e 'const fs = require("fs"); console.log(fs.realpathSync(process.argv[1]));' "${INSTALLED_BIN}" 2>/dev/null || echo "${INSTALLED_BIN}")"
	echo "Error: installed gmcli binary does not match newly built dist/cli.js." >&2
	echo "  PATH binary: ${INSTALLED_BIN} (realpath: ${RESOLVED_REALPATH})" >&2
	echo "  Built CLI:   ${BUILT_CLI}" >&2
	exit 1
fi

EXPECTED_HELP="$(node "${BUILT_CLI}" --help 2>&1 || true)"
INSTALLED_HELP="$("${INSTALLED_BIN}" --help 2>&1 || true)"

if [[ -z "${EXPECTED_HELP}" || "${INSTALLED_HELP}" != "${EXPECTED_HELP}" ]]; then
	echo "Error: '${INSTALLED_BIN} --help' output does not match 'node ${BUILT_CLI} --help'." >&2
	exit 1
fi

echo "Verified ${INSTALLED_BIN} matches ${BUILT_CLI}."
