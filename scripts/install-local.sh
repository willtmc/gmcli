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

NPM_PREFIX="$(npm prefix -g)"
if [[ -z "${NPM_PREFIX}" ]]; then
	echo "Error: could not determine npm global prefix via 'npm prefix -g'." >&2
	exit 1
fi

NPM_BIN="${NPM_PREFIX}/bin/gmcli"
if [[ ! -e "${NPM_BIN}" ]]; then
	echo "Error: expected npm global gmcli binary at ${NPM_BIN} after 'npm install -g .', but it does not exist." >&2
	exit 1
fi

if [[ ! -x "${NPM_BIN}" ]]; then
	echo "Error: npm global gmcli binary is not executable: ${NPM_BIN}" >&2
	exit 1
fi

if ! cmp -s "${BUILT_CLI}" "${NPM_BIN}"; then
	RESOLVED_REALPATH="$(node -e 'const fs = require("fs"); console.log(fs.realpathSync(process.argv[1]));' "${NPM_BIN}" 2>/dev/null || echo "${NPM_BIN}")"
	echo "Error: npm global gmcli binary does not match newly built dist/cli.js." >&2
	echo "  npm binary: ${NPM_BIN} (realpath: ${RESOLVED_REALPATH})" >&2
	echo "  Built CLI:  ${BUILT_CLI}" >&2
	exit 1
fi

EXPECTED_HELP="$(node "${BUILT_CLI}" --help 2>&1 || true)"
INSTALLED_HELP="$("${NPM_BIN}" --help 2>&1 || true)"

if [[ -z "${EXPECTED_HELP}" || "${INSTALLED_HELP}" != "${EXPECTED_HELP}" ]]; then
	echo "Error: '${NPM_BIN} --help' output does not match 'node ${BUILT_CLI} --help'." >&2
	exit 1
fi

PATH_BIN="$(command -v gmcli || true)"
NPM_BIN_REALPATH="$(node -e 'const fs = require("fs"); console.log(fs.realpathSync(process.argv[1]));' "${NPM_BIN}" 2>/dev/null || echo "${NPM_BIN}")"
if [[ -n "${PATH_BIN}" ]]; then
	PATH_BIN_REALPATH="$(node -e 'const fs = require("fs"); console.log(fs.realpathSync(process.argv[1]));' "${PATH_BIN}" 2>/dev/null || echo "${PATH_BIN}")"
	if [[ "${PATH_BIN}" != "${NPM_BIN}" && "${PATH_BIN_REALPATH}" != "${NPM_BIN_REALPATH}" ]]; then
		echo "Note: PATH resolves gmcli to ${PATH_BIN} (wrapper); verified npm global binary at ${NPM_BIN}."
	fi
else
	echo "Note: 'gmcli' is not on PATH; verified npm global binary at ${NPM_BIN}."
fi

echo "Verified ${NPM_BIN} matches ${BUILT_CLI}."
