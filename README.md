# gmcli

Minimal Gmail CLI for searching, reading threads, managing labels, drafts, and sending emails.

> **Fork Notice:** This is a fork of [@mariozechner/gmcli](https://github.com/badlogic/gmcli) by Mario Zechner with bug fixes, `--json` support across all commands, stale-draft auditing, and security hardening. See [CHANGELOG.md](CHANGELOG.md) for details.

## Install

```bash
npm install -g @willtmc/gmcli
```

### Local install from source

To install or update your local global `gmcli` binary from a source checkout, run:

```bash
npm run install-local
```

The global `gmcli` bin runs the compiled `dist/cli.js` output (not `src/` directly). `npm run install-local` rebuilds `dist/`, runs `npm install -g .`, and verifies that the `gmcli` binary resolved on `PATH` matches the newly built `dist/cli.js` (exiting non-zero if the installed binary is stale).

## Setup

Before adding an account, you need OAuth2 credentials from Google Cloud Console:

1. [Create a new project](https://console.cloud.google.com/projectcreate) (or select existing)
2. [Enable the Gmail API](https://console.cloud.google.com/apis/api/gmail.googleapis.com)
3. [Set app name](https://console.cloud.google.com/auth/branding) in OAuth branding
4. [Add test users](https://console.cloud.google.com/auth/audience) (all Gmail addresses you want to use with gmcli)
5. [Create OAuth client](https://console.cloud.google.com/auth/clients):
   - Click "Create Client"
   - Application type: "Desktop app"
   - Download the JSON file

### Env-first credentials (recommended, e.g. Doppler)

`gmcli` checks `GMCLI_CLIENT_ID` and `GMCLI_CLIENT_SECRET` in the environment before falling back to `~/.gmcli/credentials.json`. You can inject them at runtime without storing OAuth client secrets on disk:

```bash
doppler run -- gmcli accounts add you@gmail.com
doppler run -- gmcli you@gmail.com search "in:inbox"
```

### File-based credentials (fallback)

```bash
gmcli accounts credentials ~/path/to/credentials.json
gmcli accounts add you@gmail.com
```

## Usage

```
gmcli accounts <action> [options]      Account management
gmcli <email> <command> [options]      Gmail operations
gmcli --help | -h                      Show help
gmcli --version | -v                   Show version
```

### Global options & short aliases

- `--json` — Supported on all commands (`accounts`, `search`, `thread`, `labels`, `drafts`, `send`, `url`). Emits a single JSON object with `"ok": true` on success or `{"ok": false, "error": "..."}` on failure.
- `--help`, `-h` — Show usage on stdout and exit `0`. Usage errors print to stderr and exit `1`.
- `--version`, `-v` — Print the installed `gmcli` version (supports `--json`).
- Short aliases:
  - Global: `--help`/`-h`, `--version`/`-v`
  - `search`: `--max`/`-m`, `--page`/`-p`
  - `labels`: `--add`/`-a`, `--remove`/`-r`
  - `drafts audit`: `--max`/`-m`

## Commands

### accounts

```bash
gmcli accounts credentials <file.json> [--json]   # Set fallback OAuth credentials (once)
gmcli accounts list [--json]                      # List configured accounts
gmcli accounts add <email> [--json]               # Add account (opens browser)
gmcli accounts add <email> --manual [--json]      # Add account (browserless, paste redirect URL)
gmcli accounts remove <email> [--json]            # Remove account (exits 1 if not found)
```

### search

Search threads using Gmail query syntax. Returns thread ID, latest message date and sender, subject, and the union of thread labels.

```bash
gmcli <email> search <query> [--max N|-m N] [--page TOKEN|-p TOKEN] [--json]
```

`--max` / `-m` must be a positive integer (default: `10`).

Query examples:
- `in:inbox`, `in:sent`, `in:drafts`, `in:trash`, `in:spam`
- `is:unread`, `is:starred`, `is:important`
- `from:sender@example.com`, `to:recipient@example.com`
- `subject:keyword`
- `has:attachment`, `filename:pdf`
- `after:2024/01/01`, `before:2024/12/31`
- `label:Work`, `label:UNREAD`
- Combine with spaces: `in:inbox is:unread from:boss@company.com`

Examples:
```bash
gmcli you@gmail.com search "in:inbox"
gmcli you@gmail.com search "is:unread" -m 50 --json
gmcli you@gmail.com search "from:someone@example.com has:attachment"
```

### thread

Get a thread with all messages. Shows `Gmail-Message-ID`, RFC 822 `Message-ID`, headers (including `Cc`), body, and attachments for each message.

> **Send verification note:** `gmcli thread` alone is not sufficient send verification because Gmail threads can include `DRAFT` messages inline alongside sent messages. Use `gmcli <email> drafts audit --check-sent` or an explicit `in:sent` search to verify whether a message was actually sent.

```bash
gmcli <email> thread <threadId> [--json]              # View thread
gmcli <email> thread <threadId> --download [--json]   # Download attachments
```

Attachments are saved to `~/.gmcli/attachments/`.

### labels

```bash
gmcli <email> labels list [--json]                                       # List all labels (ID, name, type)
gmcli <email> labels <threadIds...> [--add L|-a L] [--remove L|-r L] [--json]  # Modify labels on threads
```

At least one of `--add` (`-a`) or `--remove` (`-r`) is required when modifying labels, and the command exits `1` if any thread fails. You can use label names or IDs (names are case-insensitive).

System labels: `INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `TRASH`, `SPAM`

Examples:
```bash
gmcli you@gmail.com labels list --json
gmcli you@gmail.com labels abc123 -r UNREAD
gmcli you@gmail.com labels abc123 --add Work --remove INBOX
gmcli you@gmail.com labels abc123 def456 -a STARRED --json
```

### drafts

```bash
gmcli <email> drafts list [--json]                      # List all drafts
gmcli <email> drafts audit [--older-than 1d] [--check-sent] [--max N|-m N] [--format markdown|table] [--json]
                                                        # Read-only stale draft audit with sent-duplicate evidence
gmcli <email> drafts get <draftId> [--json]             # View draft with attachments
gmcli <email> drafts get <draftId> --download [--json]  # Download draft attachments
gmcli <email> drafts delete <draftId> [--json]          # Delete draft
gmcli <email> drafts send <draftId> [--json]            # Send draft

gmcli <email> drafts create --to <emails> --subject <s> (--body <b> | --body-file <path>) [options]
```

`drafts audit` is strictly read-only (never sends or deletes mail) and classifies each stale draft as `likely_duplicate_sent`, `conflicting_obsolete_candidate`, `not_proven_duplicate`, or `needs_human_decision`. Default `--format markdown` produces a table ready to paste into a task note.

### send

Send an email directly.

```bash
gmcli <email> send --to <emails> --subject <s> (--body <b> | --body-file <path>) [options]
```

Options for `drafts create` and `send`:
- `--to <emails>` - Recipients (comma-separated, required)
- `--subject <s>` - Subject line (required)
- `--body <b>` - Message body (mutually exclusive with `--body-file`)
- `--body-file <path>` - Read message body from a file (mutually exclusive with `--body`; recommended for multiline bodies)
- `--html` - Send body as `text/html` instead of `text/plain`
- `--cc <emails>` - CC recipients (comma-separated)
- `--bcc <emails>` - BCC recipients (comma-separated)
- `--reply-to <messageId>` - Reply to message (sets In-Reply-To/References headers and thread; accepts Gmail message ID or thread ID; canonicalizes equivalent reply subjects to Gmail's source thread subject)
- `--in-reply-to <messageId>` - Alias for `--reply-to`
- `--thread <threadId>` - Force a specific Gmail thread without setting reply headers; prefer `--reply-to` for normal replies
- `--attach <file>` - Attach file (can be used multiple times)
- `--json` - Emit machine-readable JSON response

Examples:
```bash
# Create draft
gmcli you@gmail.com drafts create --to a@x.com --subject "Hi" --body "Hello"

# Create HTML draft from file with JSON output
gmcli you@gmail.com drafts create --to a@x.com --subject "Update" \
    --body-file update.html --html --json

# Create reply draft
gmcli you@gmail.com drafts create --to a@x.com --subject "Re: Topic" \
    --body "My reply" --reply-to 19aea1f2f3532db5

# Send draft
gmcli you@gmail.com drafts send r1234567890 --json

# Send directly
gmcli you@gmail.com send --to a@x.com --subject "Hi" --body "Hello"

# Send reply with attachment
gmcli you@gmail.com send --to a@x.com --subject "Re: Topic" \
    --body-file reply.txt --reply-to 19aea1f2f3532db5 --attach doc.pdf
```

### url

Generate Gmail web URLs for threads. Uses canonical URL format with email parameter (works regardless of account order in browser).

```bash
gmcli <email> url <threadIds...> [--json]
```

Example:
```bash
gmcli you@gmail.com url 19aea1f2f3532db5 19aea1f2f3532db6 --json
```

## Data Storage

- `GMCLI_CLIENT_ID` / `GMCLI_CLIENT_SECRET` — Env-first OAuth client credentials (e.g. via `doppler run --`), checked before `~/.gmcli/credentials.json`
- `~/.gmcli/credentials.json` — Fallback OAuth client credentials file (`0600`)
- `~/.gmcli/accounts.json` — Account refresh tokens (`0600`)
- `~/.gmcli/attachments/` — Downloaded attachments (`0700` dir, `0600` files)

## Development

```bash
npm install
npm run build
npm run check
npm test
npm run install-local   # rebuild dist/, install globally, and verify PATH binary
```

## Publishing

```bash
# Update version in package.json and CHANGELOG.md
npm run build
npm publish --access public
git tag v<version>
git push --tags
```

## License

MIT
