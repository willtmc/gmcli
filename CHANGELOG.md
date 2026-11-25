# Changelog

## Unreleased

### Added
- `gmcli --version` / `-v` flag reading version from `package.json` (with `--json` support).
- Unified `--json` output across all remaining commands: `labels <threadIds>`, `drafts get --download`, `drafts create`, `drafts delete`, `drafts send`, `send`, and `accounts list|add|remove|credentials`.
- `drafts audit` read-only stale-draft auditor with `--check-sent` duplicate detection, markdown/table/JSON outputs, and short alias `-m` (#17).
- Canonical `npm run install-local` script to rebuild, install globally, and verify the `gmcli` binary on `PATH` (#16).
- Help and `parseArgs` short-alias parity tests (#15) and CLI ergonomics test suite.

### Changed
- Strict `parseArgs` parsing across all commands (`accounts`, `thread`, `drafts get/delete/send`, `url`, `search`, `labels`, `drafts create`, `send`); unknown flags fail cleanly instead of being silently ignored or treated as positional IDs.
- Shared compose argument parser for `drafts create` and `send`: rejects specifying both `--body` and `--body-file` together and reports the exact missing required option (`--to`, `--subject`, `--body` or `--body-file`).
- Error usage (`usage(1)`) now writes to `stderr`, while explicit `--help` / `-h` writes to `stdout`.
- `thread` output now displays `Gmail-Message-ID:` separately from RFC 822 `Message-ID:` and includes `Cc:` when present.
- `search` now summarizes each thread using its latest message for sender/date and the union of labels across all messages in the thread, validates `--max` as a positive integer, guards malformed `Date` headers, and sanitizes control/tab characters in TSV columns.
- CI now runs tests and non-mutating lint/typecheck checks; cleaned Biome and `package.json` config (#18).
- Refreshed `--help` output and `README.md` for `--json`, `--version`, `--body-file`, `--html`, short aliases, and env-first Doppler credentials.

### Fixed
- Stopped global `-h` / `--help` and `--json` scanning from hijacking option values (e.g., `--subject "foo --json"` or `--body=-h`).
- `labels <threadIds>` now exits `1` if neither `--add` nor `--remove` is provided or if any thread modification fails (printing errors to `stderr` in text mode or structured `results`/`errors` in `--json` mode).
- `accounts remove <email>` now exits `1` when the account is not found.
- `decodeBody` now skips named attachments and non-`text/*` MIME parts so inline binary attachments are never dumped as message text.
- `formatSize` now clamps unit indexes so sizes >= 1 TB never format as `undefined`.
- `parseMailboxList` now respects quoted display names containing commas (e.g. `"McLemore, Will" <will@mclemoreauction.com>, jane@example.com`).
- `drafts create --reply-to` now preserves the Gmail thread when given a `threadId` (#14).

### Security
- Hardened MIME header/body encoding, inbound/outbound attachment path validation, OAuth CSRF state and HTML error escaping, and `0700`/`0600` atomic token storage (#19).

## 0.5.0

### Added
- `--json` on programmatic read commands: `search`, `thread`, `url`, `drafts list`, `drafts get`, and `labels list`. Errors emit `{ ok: false, error }` instead of prose when `--json` is set.

## 0.4.2

### Fixed
- Replies created with `--reply-to` / `--in-reply-to` now fetch the source message subject and reuse Gmail's canonical thread subject when the requested subject only differs by common reply/forward prefix casing or spacing. This avoids Gmail API `Subject does not match` failures for threaded drafts/sends.
- `thread --download` now recursively walks nested MIME parts, so attachments inside `multipart/related` / inline-style layouts are discovered and downloaded instead of incorrectly reporting `No attachments`.
- Attachment detection is now shared between metadata listing, search result summaries, and download flows, preventing traversal mismatches.
- When attachment metadata exists but download yields zero files, `gmcli` now emits a warning to stderr instead of silently failing.

### Added
- Regression tests covering nested `multipart/related` attachments and inline filename parts with embedded body data.

## 0.4.1

### Added
- `--in-reply-to <messageId>` accepted as an alias for `--reply-to` on both `drafts create` and `send`. Matches the MIME header name; either flag works identically. Passing both with different values is now a hard error rather than silently picking one.

### Changed
- Help text for reply / threading flags rewritten to clarify that `--reply-to` accepts both message IDs and thread IDs (thread IDs are resolved to the latest message), and that `--thread` is the escape hatch for forcing a thread without setting reply headers.

## 0.4.0

Env-first OAuth credentials. `gmcli` now reads `GMCLI_CLIENT_ID` and `GMCLI_CLIENT_SECRET` from the environment before falling back to `~/.gmcli/credentials.json`, which makes it usable under secret-injection tools like `doppler run --` without a credentials file on disk.

## 0.3.0

- `--html` flag for sending HTML-bodied messages from `drafts create` and `send`.
- `--body-file <path>` flag for reading the message body from a file (useful for long bodies and avoiding shell quoting issues).

## 0.2.0

Fork of @mariozechner/gmcli with bug fixes.

### Fixed
- `--reply-to` now accepts both thread IDs and message IDs. Previously it only worked with message IDs, but `search` returns thread IDs. Now automatically detects thread IDs and fetches the last message in the thread for proper reply threading.
- `drafts send` no longer crashes with "Cannot read property 'id' of undefined". Fixed response handling from Gmail API.

### Changed
- Published as `@willtmc/gmcli` (fork of `@mariozechner/gmcli`)

## 0.1.0

Initial release (original author: Mario Zechner).

- Account management (add, remove, list)
  - `--manual` flag for browserless OAuth (paste redirect URL)
- Search threads with Gmail query syntax
  - Returns thread ID, date, sender, subject, labels (human-readable names)
- View threads with message IDs and attachment info
- Download attachments
- Labels management
  - List all labels with `labels list`
  - Modify labels by name or ID (case-insensitive)
- Drafts (create, list, get, delete, send)
  - Support for replies (`--reply-to <messageId>`)
  - Support for attachments (`--attach <file>`)
- Send emails directly
  - Same options as draft creation
- Generate Gmail web URLs for threads (`url` command)
  - Uses canonical URL format with `authuser` parameter
