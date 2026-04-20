# Changelog

## 0.4.2

### Fixed
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
