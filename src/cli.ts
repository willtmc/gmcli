#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { formatDraftAuditMarkdown, formatDraftAuditTable } from "./drafts-audit.js";
import { GmailService, type ThreadSearchResult, collectAttachmentParts, isDraftMessage } from "./gmail-service.js";
import { type Mailbox, parseMailbox, parseMailboxList, splitMailboxList } from "./json-format.js";

const service = new GmailService();
let jsonOutput = false;

export interface ParsedComposeArgs {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	html?: boolean;
	threadId?: string;
	replyToMessageId?: string;
	attachments?: string[];
	json: boolean;
	help: boolean;
}

export interface HeaderEntry {
	name?: string | null;
	value?: string | null;
}

export interface SearchThreadSummary {
	id: string;
	date: string | null;
	dateFormatted: string;
	fromRaw: string;
	from: Mailbox | null;
	subject: string | null;
	labels: string[];
	snippet: string | null;
	messageIds: string[];
}

export function getPackageVersion(): string {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const pkgPath = path.resolve(dir, "..", "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
	return pkg.version || "0.0.0";
}

function usage(exitCode = 1): never {
	const write = exitCode === 0 ? console.log : console.error;
	write(`gmcli - Gmail CLI

USAGE

  gmcli accounts <action> [options]          Account management
  gmcli <email> <command> [options]          Gmail operations
  gmcli --help | -h                          Show this help message
  gmcli --version | -v                       Show gmcli version

GLOBAL OPTIONS

  --json                                     Emit machine-readable JSON output
                                             (supported on all commands; errors emit
                                             {"ok":false,"error":"..."})
  --help, -h                                 Show this help message
  --version, -v                              Print version and exit

ACCOUNT COMMANDS

  gmcli accounts credentials <file.json> [--json]
                                             Set OAuth credentials (once)
  gmcli accounts list [--json]               List configured accounts
  gmcli accounts add <email> [--manual] [--json]
                                             Add account (--manual for browserless OAuth)
  gmcli accounts remove <email> [--json]     Remove account (exits 1 if not found)

GMAIL COMMANDS

  gmcli <email> search <query> [--max N|-m N] [--page TOKEN|-p TOKEN] [--json]
      Search threads using Gmail query syntax.
      Returns: thread ID, latest date, latest sender, subject, thread labels.
      --max, -m sets the result limit as a positive integer (default: 10).
      --page, -p fetches a Gmail next-page token from a prior search.
      --json emits a stable machine-readable object instead of TSV/prose.

      Query examples:
        in:inbox, in:sent, in:drafts, in:trash
        is:unread, is:starred, is:important
        from:sender@example.com, to:recipient@example.com
        subject:keyword, has:attachment, filename:pdf
        after:2024/01/01, before:2024/12/31
        label:Work, label:UNREAD
        Combine: "in:inbox is:unread from:boss@company.com"

  gmcli <email> thread <threadId> [--download] [--json]
      Get thread with all messages.
      Shows: Gmail-Message-ID, Message-ID, headers (including Cc), body, attachments.
      --download saves attachments to ~/.gmcli/attachments/
      Note: 'gmcli thread' alone is not sufficient send verification because
      drafts can render inline in a thread like sent messages. Verify sent
      status with 'drafts audit --check-sent' or an 'in:sent' search.

  gmcli <email> labels list [--json]
      List all labels with ID, name, and type.

  gmcli <email> labels <threadIds...> [--add L|-a L] [--remove L|-r L] [--json]
      Modify labels on threads (comma-separated for multiple).
      Requires at least one of --add or --remove; exits 1 if any thread fails.
      Accepts label names or IDs (names are case-insensitive).
      System labels: INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM
      --add, -a adds label names or IDs; --remove, -r removes them.

  gmcli <email> drafts list [--json]
      List all drafts. Returns: draft ID, message ID.

  gmcli <email> drafts audit [--older-than 1d] [--check-sent] [--max N|-m N]
                             [--format markdown|table] [--json]
      Read-only audit of stale drafts (never sends or deletes mail).
      --older-than <dur>  Age filter: e.g. 1d (default), 12h, 2w, 1m, or all
      --check-sent        Check thread SENT messages and in:sent by normalized
                          subject + recipient for likely sent duplicates
      --max, -m <N>       Maximum stale drafts to audit (default: 50)
      --format <fmt>      Output format: markdown (default, Gavel-ready) or table
      --json              Emit machine-readable JSON audit report
      Classifications:
        likely_duplicate_sent           Matching sent message in thread or subject+recipient
        conflicting_obsolete_candidate  Older of multiple drafts for same thread/subject+recipient
        not_proven_duplicate            Checked sent mail; no matching sent duplicate found
        needs_human_decision            Unchecked, missing subject/recipients, or ambiguous match
      Note: 'gmcli thread' alone is not sufficient send verification because
      drafts can render inline like sent messages.

  gmcli <email> drafts get <draftId> [--download] [--json]
      View draft with attachments.
      --download saves attachments to ~/.gmcli/attachments/

  gmcli <email> drafts delete <draftId> [--json]
      Delete a draft.

  gmcli <email> drafts send <draftId> [--json]
      Send a draft.

  gmcli <email> drafts create --to <emails> --subject <s> (--body <b> | --body-file <path>) [options]
      Create a new draft.

  gmcli <email> send --to <emails> --subject <s> (--body <b> | --body-file <path>) [options]
      Send an email directly.

      Options for drafts create / send:
        --to <emails>             Recipients (comma-separated, required)
        --subject <s>             Subject line (required)
        --body <b>                Message body (mutually exclusive with --body-file)
        --body-file <path>        Read body from file (mutually exclusive with --body)
        --html                    Send as HTML email (default: plain text)
        --cc <emails>             CC recipients (comma-separated)
        --bcc <emails>            BCC recipients (comma-separated)
        --reply-to <messageId>    Reply to message (sets In-Reply-To /
                                  References headers AND threads the reply).
                                  Accepts a Gmail message ID OR a thread ID;
                                  thread IDs are resolved to the latest message.
        --in-reply-to <messageId> Alias for --reply-to (matches the MIME header
                                  name; either flag works identically).
        --thread <threadId>       Force a specific Gmail thread without setting
                                  reply headers. Use --reply-to in normal cases;
                                  --thread is only for unusual threading needs.
        --attach <file>           Attach file (use multiple times for multiple files)
        --json                    Emit machine-readable JSON response

      Short aliases:
        global: --help/-h, --version/-v
        search: --max/-m, --page/-p
        labels: --add/-a, --remove/-r
        drafts audit: --max/-m

  gmcli <email> url <threadIds...> [--json]
      Generate Gmail web URLs for threads.
      Uses canonical URL format with email parameter.

EXAMPLES

  gmcli --version
  gmcli accounts list --json
  gmcli you@gmail.com search "in:inbox is:unread"
  gmcli you@gmail.com search "from:boss@company.com" --max 50 --json
  gmcli you@gmail.com thread 19aea1f2f3532db5
  gmcli you@gmail.com thread 19aea1f2f3532db5 --download
  gmcli you@gmail.com labels list
  gmcli you@gmail.com labels abc123 --add Work --remove UNREAD
  gmcli you@gmail.com drafts create --to a@x.com --subject "Hi" --body "Hello"
  gmcli you@gmail.com drafts create --to a@x.com --subject "Hi" --body-file body.txt --json
  gmcli you@gmail.com drafts audit --older-than=1d --check-sent
  gmcli you@gmail.com drafts send r1234567890
  gmcli you@gmail.com send --to a@x.com --subject "Hi" --body "Hello"
  gmcli you@gmail.com send --to a@x.com --subject "Re: Topic" \\
      --body "Reply text" --reply-to 19aea1f2f3532db5 --attach file.pdf
  gmcli you@gmail.com url 19aea1f2f3532db5 19aea1f2f3532db6

DATA STORAGE

  GMCLI_CLIENT_ID / GMCLI_CLIENT_SECRET
                              Preferred OAuth client credentials via environment
                              (e.g. Doppler); checked before credentials.json
  ~/.gmcli/credentials.json   Fallback OAuth client credentials file
  ~/.gmcli/accounts.json      Account tokens
  ~/.gmcli/attachments/       Downloaded attachments`);
	process.exit(exitCode);
}

function error(msg: string): never {
	if (jsonOutput) {
		console.log(JSON.stringify({ ok: false, error: msg }));
	} else {
		console.error("Error:", msg);
	}
	process.exit(1);
}

function emitJson(payload: Record<string, unknown>): void {
	console.log(JSON.stringify(payload));
}

function hasStandaloneJsonFlag(
	args: string[],
	valueLongOptions: ReadonlySet<string>,
	valueShortOptions: ReadonlySet<string> = new Set(),
): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "--json") return true;
		if (arg.startsWith("--")) {
			if (arg.includes("=")) continue;
			const name = arg.slice(2);
			if (valueLongOptions.has(name)) {
				i++;
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			const short = arg.slice(1);
			if (valueShortOptions.has(short)) {
				i++;
			}
		}
	}
	return false;
}

function maybeEnableJsonFromError(
	args: string[],
	valueLongOptions: ReadonlySet<string> = new Set(),
	valueShortOptions: ReadonlySet<string> = new Set(),
): void {
	if (!jsonOutput && hasStandaloneJsonFlag(args, valueLongOptions, valueShortOptions)) {
		jsonOutput = true;
	}
}

export function getHeader(headers: HeaderEntry[] | undefined, name: string): string {
	if (!headers) return "";
	const lower = name.toLowerCase();
	return headers.find((h) => h.name?.toLowerCase() === lower)?.value || "";
}

export function formatInternalDate(internalDate: string | null | undefined): string {
	if (!internalDate) return "";
	const timestamp = Number(internalDate);
	if (!Number.isFinite(timestamp)) return "";
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "";
	return date.toISOString();
}

export function formatSearchDate(dateHeader: string | undefined, internalDate?: string | null | undefined): string {
	if (dateHeader) {
		const parsed = new Date(dateHeader);
		if (Number.isFinite(parsed.getTime())) {
			return parsed.toISOString().slice(0, 16).replace("T", " ");
		}
	}
	if (internalDate) {
		const timestamp = Number(internalDate);
		if (Number.isFinite(timestamp)) {
			const parsed = new Date(timestamp);
			if (Number.isFinite(parsed.getTime())) {
				return parsed.toISOString().slice(0, 16).replace("T", " ");
			}
		}
	}
	return "";
}

export function sanitizeTsvField(value: string | undefined | null): string {
	if (!value) return "";
	return value.replace(/[\r\n\t]+/g, " ").trim();
}

export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function isTextBodyPart(part: any): boolean {
	if (!part) return false;
	if (typeof part.filename === "string" && part.filename.trim().length > 0) {
		return false;
	}
	const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
	if (mimeType && !mimeType.startsWith("text/")) {
		return false;
	}
	return true;
}

export function decodeBody(payload: any): string {
	if (!payload) return "";
	if (payload.body?.data && isTextBodyPart(payload)) {
		return Buffer.from(payload.body.data, "base64url").toString();
	}
	if (Array.isArray(payload.parts)) {
		for (const part of payload.parts) {
			if (part?.mimeType?.toLowerCase() === "text/plain" && isTextBodyPart(part) && part.body?.data) {
				return Buffer.from(part.body.data, "base64url").toString();
			}
		}
		for (const part of payload.parts) {
			if (Array.isArray(part?.parts)) {
				const nested = decodeBody(part);
				if (nested) return nested;
			}
		}
		for (const part of payload.parts) {
			if (isTextBodyPart(part) && part?.body?.data) {
				return Buffer.from(part.body.data, "base64url").toString();
			}
		}
	}
	return "";
}

export function parsePositiveIntOption(name: string, raw: string | undefined, defaultValue: number): number {
	if (raw === undefined) return defaultValue;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid --${name} value '${raw}'. Expected a positive integer.`);
	}
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid --${name} value '${raw}'. Expected a positive integer.`);
	}
	return parsed;
}

export function summarizeSearchThread(
	thread: ThreadSearchResult["threads"][number],
	idToName: Map<string, string>,
): SearchThreadSummary {
	const messages = thread.messages || [];
	const latestMsg = messages[messages.length - 1];
	const firstMsg = messages[0];

	const labelIdSet = new Set<string>();
	for (const msg of messages) {
		for (const id of msg.labelIds || []) {
			labelIdSet.add(id);
		}
	}
	const labels = [...labelIdSet].map((id) => idToName.get(id) || id);

	return {
		id: thread.id,
		date: latestMsg?.date || latestMsg?.internalDate || null,
		dateFormatted: formatSearchDate(latestMsg?.date, latestMsg?.internalDate),
		fromRaw: latestMsg?.from || "",
		from: parseMailbox(latestMsg?.from),
		subject: latestMsg?.subject || firstMsg?.subject || null,
		labels,
		snippet: latestMsg?.snippet || null,
		messageIds: messages.map((m) => m.id).filter(Boolean),
	};
}

// Accept both --reply-to and its --in-reply-to alias. If the caller supplies both
// with conflicting values, fail loudly rather than silently picking one.
export function resolveReplyToFlag(replyTo: string | undefined, inReplyTo: string | undefined): string | undefined {
	if (replyTo && inReplyTo && replyTo !== inReplyTo) {
		throw new Error(
			`--reply-to (${replyTo}) and --in-reply-to (${inReplyTo}) were both supplied with different values. ` +
				"Pass only one (they are aliases for the same option).",
		);
	}
	return replyTo ?? inReplyTo;
}

const COMPOSE_VALUE_OPTIONS = new Set([
	"to",
	"cc",
	"bcc",
	"subject",
	"body",
	"body-file",
	"thread",
	"reply-to",
	"in-reply-to",
	"attach",
]);

export function parseComposeArgs(args: string[]): ParsedComposeArgs {
	let values: {
		to?: string;
		cc?: string;
		bcc?: string;
		subject?: string;
		body?: string;
		"body-file"?: string;
		html?: boolean;
		thread?: string;
		"reply-to"?: string;
		"in-reply-to"?: string;
		attach?: string[];
		json?: boolean;
		help?: boolean;
	};

	try {
		({ values } = parseArgs({
			args,
			options: {
				to: { type: "string" },
				cc: { type: "string" },
				bcc: { type: "string" },
				subject: { type: "string" },
				body: { type: "string" },
				"body-file": { type: "string" },
				html: { type: "boolean" },
				thread: { type: "string" },
				"reply-to": { type: "string" },
				"in-reply-to": { type: "string" },
				attach: { type: "string", multiple: true },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: false,
		}));
	} catch (e) {
		maybeEnableJsonFromError(args, COMPOSE_VALUE_OPTIONS);
		throw e;
	}

	const json = Boolean(values.json);
	if (json) jsonOutput = true;

	if (values.help) {
		return {
			to: [],
			subject: "",
			body: "",
			json,
			help: true,
		};
	}

	if (values.body !== undefined && values["body-file"] !== undefined) {
		throw new Error("Cannot specify both --body and --body-file. Pass only one.");
	}

	const to = splitMailboxList(values.to);
	if (to.length === 0) {
		throw new Error("Missing required option: --to");
	}
	if (!values.subject?.trim()) {
		throw new Error("Missing required option: --subject");
	}

	const hasBody = values.body !== undefined;
	const hasBodyFile = values["body-file"] !== undefined;
	if (!hasBody && !hasBodyFile) {
		throw new Error("Missing required option: --body or --body-file");
	}

	const bodyContent = hasBodyFile ? fs.readFileSync(values["body-file"]!, "utf8") : values.body!;
	if (!bodyContent) {
		throw new Error(
			hasBodyFile
				? `Message body file '${values["body-file"]}' is empty.`
				: "Missing required option: --body must not be empty",
		);
	}

	const cc = values.cc !== undefined ? splitMailboxList(values.cc) : undefined;
	const bcc = values.bcc !== undefined ? splitMailboxList(values.bcc) : undefined;
	const replyToMessageId = resolveReplyToFlag(values["reply-to"], values["in-reply-to"]);

	return {
		to,
		cc: cc && cc.length > 0 ? cc : undefined,
		bcc: bcc && bcc.length > 0 ? bcc : undefined,
		subject: values.subject,
		body: bodyContent,
		html: values.html,
		threadId: values.thread,
		replyToMessageId,
		attachments: values.attach,
		json,
		help: false,
	};
}

function consumeLeadingFlags(
	args: string[],
	allowVersion: boolean,
): { help: boolean; version: boolean; rest: string[] } {
	let help = false;
	let version = false;
	let i = 0;

	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
			i++;
		} else if (allowVersion && (arg === "--version" || arg === "-v")) {
			version = true;
			i++;
		} else if (arg === "--json") {
			jsonOutput = true;
			i++;
		} else {
			error(`Unknown option '${arg}'`);
		}
	}

	return { help, version, rest: args.slice(i) };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		usage(1);
	}

	try {
		const top = consumeLeadingFlags(args, true);
		if (top.help) {
			usage(0);
		}
		if (top.version) {
			if (top.rest.length > 0) {
				error(`Unexpected argument '${top.rest[0]}' with --version`);
			}
			const version = getPackageVersion();
			if (jsonOutput) {
				emitJson({ ok: true, version });
			} else {
				console.log(version);
			}
			return;
		}

		if (top.rest.length === 0) {
			error("Missing command. Use --help for usage.");
		}

		const first = top.rest[0];
		const rest = top.rest.slice(1);

		// Handle 'accounts' command separately (no email required)
		if (first === "accounts") {
			await handleAccounts(rest);
			return;
		}

		// All other commands: first arg is email, second is command
		const account = first;
		const afterAccount = consumeLeadingFlags(rest, false);
		if (afterAccount.help) {
			usage(0);
		}
		const command = afterAccount.rest[0];
		const commandArgs = afterAccount.rest.slice(1);

		if (!command) {
			error("Missing command. Use --help for usage.");
		}

		switch (command) {
			case "search":
				await handleSearch(account, commandArgs);
				break;
			case "thread":
				await handleThread(account, commandArgs);
				break;
			case "labels":
				await handleLabels(account, commandArgs);
				break;
			case "drafts":
				await handleDrafts(account, commandArgs);
				break;
			case "send":
				await handleSend(account, commandArgs);
				break;
			case "url":
				handleUrl(account, commandArgs);
				break;
			default:
				error(`Unknown command: ${command}`);
		}
	} catch (e) {
		error(e instanceof Error ? e.message : String(e));
	}
}

async function handleAccounts(args: string[]) {
	const leading = consumeLeadingFlags(args, false);
	if (leading.help) usage(0);

	const action = leading.rest[0];
	const actionArgs = leading.rest.slice(1);
	if (!action) error("Missing action: list|add|remove|credentials");

	switch (action) {
		case "list": {
			let values: { json?: boolean; help?: boolean };
			try {
				({ values } = parseArgs({
					args: actionArgs,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: false,
				}));
			} catch (e) {
				maybeEnableJsonFromError(actionArgs);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			const accounts = service.listAccounts();
			if (jsonOutput) {
				emitJson({
					ok: true,
					accounts: accounts.map((a) => ({ email: a.email })),
				});
				break;
			}
			if (accounts.length === 0) {
				console.log("No accounts configured");
			} else {
				for (const a of accounts) {
					console.log(a.email);
				}
			}
			break;
		}
		case "credentials": {
			let values: { json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: actionArgs,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(actionArgs);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: accounts credentials <credentials.json>");
			const credFile = positionals[0];
			const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
			const installed = creds.installed || creds.web;
			if (!installed) error("Invalid credentials file");
			service.setCredentials(installed.client_id, installed.client_secret);
			if (jsonOutput) {
				emitJson({ ok: true, saved: true });
			} else {
				console.log("Credentials saved");
			}
			break;
		}
		case "add": {
			let values: { manual?: boolean; json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: actionArgs,
					options: {
						manual: { type: "boolean" },
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(actionArgs);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: accounts add <email> [--manual]");
			const email = positionals[0];
			const manual = Boolean(values.manual);
			const creds = service.getCredentials();
			if (!creds) error("No credentials configured. Run: gmcli accounts credentials <credentials.json>");
			await service.addGmailAccount(email, creds.clientId, creds.clientSecret, manual);
			if (jsonOutput) {
				emitJson({ ok: true, email, manual });
			} else {
				console.log(`Account '${email}' added`);
			}
			break;
		}
		case "remove": {
			let values: { json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: actionArgs,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(actionArgs);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: accounts remove <email>");
			const email = positionals[0];
			const deleted = service.deleteAccount(email);
			if (!deleted) {
				error(`Account '${email}' not found`);
			}
			if (jsonOutput) {
				emitJson({ ok: true, email, removed: true });
			} else {
				console.log(`Removed '${email}'`);
			}
			break;
		}
		default:
			error(`Unknown action: ${action}`);
	}
}

async function handleSearch(account: string, args: string[]) {
	let values: { max?: string; page?: string; json?: boolean; help?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				max: { type: "string", short: "m" },
				page: { type: "string", short: "p" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		}));
	} catch (e) {
		maybeEnableJsonFromError(args, new Set(["max", "page"]), new Set(["m", "p"]));
		throw e;
	}

	if (values.json) jsonOutput = true;
	if (values.help) usage(0);

	const maxResults = parsePositiveIntOption("max", values.max, 10);
	const query = positionals.join(" ");
	if (!query) error("Usage: <email> search <query>");

	const results = await service.searchThreads(account, query, maxResults, values.page);
	const { idToName } = await service.getLabelMap(account);
	const summaries = results.threads.map((t) => summarizeSearchThread(t, idToName));

	if (jsonOutput) {
		emitJson({
			ok: true,
			query,
			threads: summaries.map((s) => ({
				id: s.id,
				date: s.date,
				from: s.from,
				subject: s.subject,
				labels: s.labels,
				snippet: s.snippet,
				message_ids: s.messageIds,
			})),
			next_page_token: results.nextPageToken || null,
		});
		return;
	}

	if (summaries.length === 0) {
		console.log("No results");
	} else {
		console.log("ID\tDATE\tFROM\tSUBJECT\tLABELS");
		for (const s of summaries) {
			const id = sanitizeTsvField(s.id);
			const date = sanitizeTsvField(s.dateFormatted);
			const from = sanitizeTsvField(s.fromRaw);
			const subject = sanitizeTsvField(s.subject) || "(no subject)";
			const labels = sanitizeTsvField(s.labels.join(","));
			console.log(`${id}\t${date}\t${from}\t${subject}\t${labels}`);
		}
		if (results.nextPageToken) {
			console.log(`\n# Next page: --page ${results.nextPageToken}`);
		}
	}
}

async function handleThread(account: string, args: string[]) {
	let values: { download?: boolean; json?: boolean; help?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				download: { type: "boolean" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		}));
	} catch (e) {
		maybeEnableJsonFromError(args);
		throw e;
	}

	if (values.json) jsonOutput = true;
	if (values.help) usage(0);

	if (positionals.length !== 1) error("Usage: <email> thread <threadId> [--download]");
	const threadId = positionals[0];
	const download = Boolean(values.download);

	const result = await service.getThread(account, threadId, download);

	if (download) {
		const attachments = result as any[];
		if (jsonOutput) {
			emitJson({
				ok: true,
				thread_id: threadId,
				attachments: attachments.map((a) => ({
					filename: a.filename,
					path: a.path,
					size: a.size,
					mime_type: a.mimeType || null,
				})),
			});
			return;
		}
		if (attachments.length === 0) {
			console.log("No attachments");
		} else {
			console.log("FILENAME\tPATH\tSIZE");
			for (const a of attachments) {
				console.log(`${a.filename}\t${a.path}\t${a.size}`);
			}
		}
	} else {
		const thread = result as any;
		if (jsonOutput) {
			emitJson({
				ok: true,
				thread_id: thread.id || threadId,
				messages: (thread.messages || []).map((msg: any) => {
					const headers = msg.payload?.headers || [];
					return {
						id: msg.id,
						rfc822_message_id: getHeader(headers, "message-id") || null,
						from: parseMailbox(getHeader(headers, "from")),
						to: parseMailboxList(getHeader(headers, "to")),
						cc: parseMailboxList(getHeader(headers, "cc")),
						date: getHeader(headers, "date") || formatInternalDate(msg.internalDate) || null,
						subject: getHeader(headers, "subject") || null,
						body: decodeBody(msg.payload),
						is_draft: isDraftMessage(msg),
						label_ids: msg.labelIds || [],
						attachments: collectAttachmentParts(msg.payload).map((att) => ({
							filename: att.filename,
							mime_type: att.mimeType,
							size: att.size,
							attachment_id: att.attachmentId || null,
						})),
					};
				}),
			});
			return;
		}
		for (const msg of thread.messages || []) {
			const headers = msg.payload?.headers || [];
			const isDraft = isDraftMessage(msg);
			console.log(`Gmail-Message-ID: ${msg.id}`);
			const rfcMessageId = getHeader(headers, "message-id");
			if (rfcMessageId) {
				console.log(`Message-ID: ${rfcMessageId}`);
			}
			if (isDraft) {
				console.log("Status: DRAFT (not sent)");
			}
			console.log(`From: ${getHeader(headers, "from")}`);
			console.log(`To: ${getHeader(headers, "to")}`);
			const cc = getHeader(headers, "cc");
			if (cc) {
				console.log(`Cc: ${cc}`);
			}
			if (isDraft) {
				console.log(`Last-saved: ${formatInternalDate(msg.internalDate) || getHeader(headers, "date")}`);
			} else {
				console.log(`Date: ${getHeader(headers, "date")}`);
			}
			console.log(`Subject: ${getHeader(headers, "subject")}`);
			console.log("");
			console.log(decodeBody(msg.payload));
			console.log("");
			const attachments = collectAttachmentParts(msg.payload);
			if (attachments.length > 0) {
				console.log("Attachments:");
				for (const att of attachments) {
					console.log(`  - ${att.filename} (${formatSize(att.size)}, ${att.mimeType})`);
				}
				console.log("");
			}
			console.log("---");
		}
	}
}

async function handleLabels(account: string, args: string[]) {
	let values: { add?: string; remove?: string; json?: boolean; help?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				add: { type: "string", short: "a" },
				remove: { type: "string", short: "r" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		}));
	} catch (e) {
		maybeEnableJsonFromError(args, new Set(["add", "remove"]), new Set(["a", "r"]));
		throw e;
	}

	if (values.json) jsonOutput = true;
	if (values.help) usage(0);

	if (positionals.length === 0) {
		error("Usage: <email> labels list | <email> labels <threadIds...> [--add L] [--remove L]");
	}

	// labels list
	if (positionals[0] === "list") {
		if (positionals.length > 1 || values.add !== undefined || values.remove !== undefined) {
			error("Usage: <email> labels list");
		}
		const labels = await service.listLabels(account);
		if (jsonOutput) {
			emitJson({
				ok: true,
				labels: labels.map((l) => ({ id: l.id, name: l.name, type: l.type })),
			});
			return;
		}
		console.log("ID\tNAME\tTYPE");
		for (const l of labels) {
			console.log(`${l.id}\t${l.name}\t${l.type}`);
		}
		return;
	}

	// labels <threadIds...> [--add] [--remove]
	const threadIds = positionals;
	const rawAdd = values.add
		? values.add
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	const rawRemove = values.remove
		? values.remove
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

	if (rawAdd.length === 0 && rawRemove.length === 0) {
		error("At least one of --add or --remove is required.");
	}

	const { nameToId } = await service.getLabelMap(account);
	const addLabels = rawAdd.length > 0 ? service.resolveLabelIds(rawAdd, nameToId) : [];
	const removeLabels = rawRemove.length > 0 ? service.resolveLabelIds(rawRemove, nameToId) : [];

	const results = await service.modifyLabels(account, threadIds, addLabels, removeLabels);
	const failed = results.filter((r) => !r.success);

	if (jsonOutput) {
		emitJson({
			ok: failed.length === 0,
			added: addLabels,
			removed: removeLabels,
			results: results.map((r) => ({
				thread_id: r.threadId,
				ok: r.success,
				...(r.error ? { error: r.error } : {}),
			})),
			errors: failed.map((r) => ({
				thread_id: r.threadId,
				error: r.error || "Unknown error",
			})),
		});
		if (failed.length > 0) {
			process.exit(1);
		}
		return;
	}

	for (const r of results) {
		if (r.success) {
			console.log(`${r.threadId}: ok`);
		} else {
			console.error(`${r.threadId}: ${r.error || "Unknown error"}`);
		}
	}
	if (failed.length > 0) {
		process.exit(1);
	}
}

async function handleDrafts(account: string, args: string[]) {
	const leading = consumeLeadingFlags(args, false);
	if (leading.help) usage(0);

	const action = leading.rest[0];
	const rest = leading.rest.slice(1);
	if (!action) error("Usage: <email> drafts <action>");

	switch (action) {
		case "list": {
			let values: { json?: boolean; help?: boolean };
			try {
				({ values } = parseArgs({
					args: rest,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: false,
				}));
			} catch (e) {
				maybeEnableJsonFromError(rest);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			const drafts = await service.listDrafts(account);
			if (jsonOutput) {
				emitJson({
					ok: true,
					drafts: drafts.map((d) => ({
						id: d.id,
						message_id: d.message?.id || null,
						thread_id: d.message?.threadId || null,
					})),
				});
				break;
			}
			if (drafts.length === 0) {
				console.log("No drafts");
			} else {
				console.log("ID\tMESSAGE_ID");
				for (const d of drafts) {
					console.log(`${d.id}\t${d.message?.id || ""}`);
				}
			}
			break;
		}
		case "audit": {
			let values: {
				"older-than"?: string;
				"check-sent"?: boolean;
				max?: string;
				format?: string;
				json?: boolean;
				help?: boolean;
			};
			try {
				({ values } = parseArgs({
					args: rest,
					options: {
						"older-than": { type: "string" },
						"check-sent": { type: "boolean" },
						max: { type: "string", short: "m" },
						format: { type: "string" },
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: false,
				}));
			} catch (e) {
				maybeEnableJsonFromError(rest, new Set(["older-than", "max", "format"]), new Set(["m"]));
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			const format = (values.format || "markdown").toLowerCase();
			if (format !== "markdown" && format !== "table") {
				error(`Invalid --format '${values.format}'. Expected 'markdown' or 'table'.`);
			}

			const maxResults = parsePositiveIntOption("max", values.max, 50);

			const result = await service.auditDrafts(account, {
				olderThan: values["older-than"] ?? "1d",
				checkSent: Boolean(values["check-sent"]),
				maxResults,
			});

			if (jsonOutput) {
				emitJson({ ok: true, ...result });
				break;
			}

			if (format === "table") {
				console.log(formatDraftAuditTable(result));
			} else {
				console.log(formatDraftAuditMarkdown(result));
			}
			break;
		}
		case "get": {
			let values: { download?: boolean; json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: rest,
					options: {
						download: { type: "boolean" },
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(rest);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: <email> drafts get <draftId> [--download]");
			const draftId = positionals[0];
			const download = Boolean(values.download);

			const draft = await service.getDraft(account, draftId);
			const msg = draft.message;
			if (!msg) {
				if (jsonOutput) {
					emitJson(
						download
							? { ok: true, draft_id: draft.id || draftId, message_id: null, attachments: [] }
							: {
									ok: true,
									draft_id: draft.id || draftId,
									message_id: null,
									thread_id: null,
									to: [],
									cc: [],
									subject: null,
									body: "",
									attachments: [],
								},
					);
				}
				break;
			}

			if (download) {
				const downloaded = await service.downloadMessageAttachments(account, msg.id!);
				if (jsonOutput) {
					emitJson({
						ok: true,
						draft_id: draft.id || draftId,
						message_id: msg.id || null,
						attachments: downloaded.map((a) => ({
							filename: a.filename,
							path: a.path,
							size: a.size,
							mime_type: a.mimeType || null,
						})),
					});
					break;
				}
				if (downloaded.length === 0) {
					console.log("No attachments");
				} else {
					console.log("FILENAME\tPATH\tSIZE");
					for (const a of downloaded) {
						console.log(`${a.filename}\t${a.path}\t${a.size}`);
					}
				}
			} else {
				const headers = msg.payload?.headers || [];
				if (jsonOutput) {
					emitJson({
						ok: true,
						draft_id: draft.id,
						message_id: msg.id || null,
						thread_id: msg.threadId || null,
						to: parseMailboxList(getHeader(headers, "to")),
						cc: parseMailboxList(getHeader(headers, "cc")),
						subject: getHeader(headers, "subject") || null,
						body: decodeBody(msg.payload),
						attachments: collectAttachmentParts(msg.payload).map((att) => ({
							filename: att.filename,
							mime_type: att.mimeType,
							size: att.size,
						})),
					});
					break;
				}
				console.log(`Draft-ID: ${draft.id}`);
				console.log(`To: ${getHeader(headers, "to")}`);
				console.log(`Cc: ${getHeader(headers, "cc")}`);
				console.log(`Subject: ${getHeader(headers, "subject")}`);
				console.log("");
				console.log(decodeBody(msg.payload));
				console.log("");
				const attachments = collectAttachmentParts(msg.payload);
				if (attachments.length > 0) {
					console.log("Attachments:");
					for (const att of attachments) {
						console.log(`  - ${att.filename} (${formatSize(att.size)}, ${att.mimeType})`);
					}
				}
			}
			break;
		}
		case "delete": {
			let values: { json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: rest,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(rest);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: <email> drafts delete <draftId>");
			const draftId = positionals[0];
			await service.deleteDraft(account, draftId);
			if (jsonOutput) {
				emitJson({ ok: true, draft_id: draftId, deleted: true });
			} else {
				console.log("Deleted");
			}
			break;
		}
		case "send": {
			let values: { json?: boolean; help?: boolean };
			let positionals: string[];
			try {
				({ values, positionals } = parseArgs({
					args: rest,
					options: {
						json: { type: "boolean" },
						help: { type: "boolean", short: "h" },
					},
					allowPositionals: true,
				}));
			} catch (e) {
				maybeEnableJsonFromError(rest);
				throw e;
			}
			if (values.json) jsonOutput = true;
			if (values.help) usage(0);

			if (positionals.length !== 1) error("Usage: <email> drafts send <draftId>");
			const draftId = positionals[0];
			const msg = await service.sendDraft(account, draftId);
			if (jsonOutput) {
				emitJson({
					ok: true,
					draft_id: draftId,
					message_id: msg.id || null,
					thread_id: msg.threadId || null,
				});
			} else {
				console.log(`Sent: ${msg.id}${msg.threadId ? ` thread: ${msg.threadId}` : ""}`);
			}
			break;
		}
		case "create": {
			const parsed = parseComposeArgs(rest);
			if (parsed.help) usage(0);

			const draft = await service.createDraft(account, parsed.to, parsed.subject, parsed.body, {
				cc: parsed.cc,
				bcc: parsed.bcc,
				threadId: parsed.threadId,
				replyToMessageId: parsed.replyToMessageId,
				attachments: parsed.attachments,
				html: parsed.html,
			});
			const draftMessage = draft.message;
			if (jsonOutput) {
				emitJson({
					ok: true,
					draft_id: draft.id || null,
					message_id: draftMessage?.id || null,
					thread_id: draftMessage?.threadId || null,
				});
			} else {
				console.log(
					`Draft created: ${draft.id}${draftMessage?.id ? ` message: ${draftMessage.id}` : ""}${draftMessage?.threadId ? ` thread: ${draftMessage.threadId}` : ""}`,
				);
			}
			break;
		}
		default:
			error(`Unknown action: ${action}`);
	}
}

async function handleSend(account: string, args: string[]) {
	const parsed = parseComposeArgs(args);
	if (parsed.help) usage(0);

	const msg = await service.sendMessage(account, parsed.to, parsed.subject, parsed.body, {
		cc: parsed.cc,
		bcc: parsed.bcc,
		threadId: parsed.threadId,
		replyToMessageId: parsed.replyToMessageId,
		attachments: parsed.attachments,
		html: parsed.html,
	});
	if (jsonOutput) {
		emitJson({
			ok: true,
			message_id: msg.id || null,
			thread_id: msg.threadId || null,
		});
		return;
	}
	console.log(`Sent: ${msg.id}${msg.threadId ? ` thread: ${msg.threadId}` : ""}`);
}

function handleUrl(account: string, args: string[]) {
	let values: { json?: boolean; help?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		}));
	} catch (e) {
		maybeEnableJsonFromError(args);
		throw e;
	}

	if (values.json) jsonOutput = true;
	if (values.help) usage(0);

	if (positionals.length === 0) {
		error("Usage: <email> url <threadIds...>");
	}

	const urls = positionals.map((id) => ({
		thread_id: id,
		url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${id}`,
	}));
	if (jsonOutput) {
		emitJson({ ok: true, urls });
		return;
	}
	for (const row of urls) {
		console.log(`${row.thread_id}\t${row.url}`);
	}
}

function isMainModule(): boolean {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	}
}

if (isMainModule()) {
	void main();
}
