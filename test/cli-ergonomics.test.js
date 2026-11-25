import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	decodeBody,
	formatSearchDate,
	formatSize,
	parseComposeArgs,
	parsePositiveIntOption,
	sanitizeTsvField,
	summarizeSearchThread,
} from "../dist/cli.js";
import { parseMailboxList } from "../dist/json-format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliDistPath = path.join(repoRoot, "dist", "cli.js");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function runCli(args, envOverrides = {}) {
	return spawnSync(process.execPath, [cliDistPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...envOverrides },
	});
}

function withFakeHome(fn) {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-ergonomics-"));
	try {
		return fn(fakeHome);
	} finally {
		fs.rmSync(fakeHome, { recursive: true, force: true });
	}
}

test("parseMailboxList preserves quoted display-name commas and escaped quotes", () => {
	assert.deepEqual(parseMailboxList('"McLemore, Will" <will@mclemoreauction.com>, jane@example.com'), [
		{ name: "McLemore, Will", email: "will@mclemoreauction.com" },
		{ name: null, email: "jane@example.com" },
	]);

	assert.deepEqual(
		parseMailboxList('"Smith, Jr., John" <john@example.com>, "Doe, \\"Jane\\"" <jane@example.com>'),
		[
			{ name: "Smith, Jr., John", email: "john@example.com" },
			{ name: 'Doe, "Jane"', email: "jane@example.com" },
		],
	);
});

test("parseComposeArgs rejects --body + --body-file conflict and names exact missing required options", () => {
	withFakeHome((dir) => {
		const bodyFile = path.join(dir, "body.txt");
		fs.writeFileSync(bodyFile, "Body from file", "utf8");

		assert.throws(
			() =>
				parseComposeArgs([
					"--to",
					"a@x.com",
					"--subject",
					"Test",
					"--body",
					"Inline",
					"--body-file",
					bodyFile,
				]),
			/Cannot specify both --body and --body-file/,
		);

		assert.throws(() => parseComposeArgs(["--subject", "Test", "--body", "Hi"]), /Missing required option: --to/);
		assert.throws(() => parseComposeArgs(["--to", "a@x.com", "--body", "Hi"]), /Missing required option: --subject/);
		assert.throws(
			() => parseComposeArgs(["--to", "a@x.com", "--subject", "Test"]),
			/Missing required option: --body or --body-file/,
		);

		const parsed = parseComposeArgs([
			"--to",
			'"McLemore, Will" <will@example.com>, jane@example.com',
			"--subject",
			"Hello",
			"--body-file",
			bodyFile,
		]);
		assert.deepEqual(parsed.to, ['"McLemore, Will" <will@example.com>', "jane@example.com"]);
		assert.equal(parsed.body, "Body from file");
	});
});

test("CLI rejects --body + --body-file conflict and names exact missing field for both drafts create and send", () => {
	withFakeHome((fakeHome) => {
		const bodyFile = path.join(fakeHome, "msg.txt");
		fs.writeFileSync(bodyFile, "From file", "utf8");
		const account = "will@example.invalid";

		for (const cmd of [["drafts", "create"], ["send"]]) {
			const conflict = runCli(
				[account, ...cmd, "--to", "a@x.com", "--subject", "Hi", "--body", "Inline", "--body-file", bodyFile],
				{ HOME: fakeHome },
			);
			assert.equal(conflict.status, 1);
			assert.match(conflict.stderr, /Cannot specify both --body and --body-file/);

			const missingTo = runCli([account, ...cmd, "--subject", "Hi", "--body", "Hello"], { HOME: fakeHome });
			assert.equal(missingTo.status, 1);
			assert.match(missingTo.stderr, /Missing required option: --to/);
			assert.doesNotMatch(missingTo.stderr, /DATA STORAGE/);

			const missingSubj = runCli([account, ...cmd, "--to", "a@x.com", "--body", "Hello"], { HOME: fakeHome });
			assert.equal(missingSubj.status, 1);
			assert.match(missingSubj.stderr, /Missing required option: --subject/);

			const missingBody = runCli([account, ...cmd, "--to", "a@x.com", "--subject", "Hi"], { HOME: fakeHome });
			assert.equal(missingBody.status, 1);
			assert.match(missingBody.stderr, /Missing required option: --body or --body-file/);
		}
	});
});

test("search validates --max as a positive integer", () => {
	assert.equal(parsePositiveIntOption("max", "25", 10), 25);
	assert.equal(parsePositiveIntOption("max", undefined, 10), 10);
	assert.throws(() => parsePositiveIntOption("max", "bogus", 10), /Invalid --max value 'bogus'/);
	assert.throws(() => parsePositiveIntOption("max", "0", 10), /Invalid --max value '0'/);
	assert.throws(() => parsePositiveIntOption("max", "-3", 10), /Invalid --max value '-3'/);
	assert.throws(() => parsePositiveIntOption("max", "1.5", 10), /Invalid --max value '1\.5'/);

	withFakeHome((fakeHome) => {
		for (const args of [
			["user@example.invalid", "search", "in:inbox", "--max", "bogus"],
			["user@example.invalid", "search", "in:inbox", "--max", "0"],
			["user@example.invalid", "search", "in:inbox", "--max=-5"],
		]) {
			const res = runCli(args, { HOME: fakeHome });
			assert.equal(res.status, 1);
			assert.match(res.stderr, /Invalid --max value/);
		}
	});
});

test("strict parseArgs rejects unknown flags on thread, drafts get/delete/send, url, and accounts", () => {
	withFakeHome((fakeHome) => {
		const account = "user@example.invalid";
		const cases = [
			[account, "thread", "t123", "--bogus"],
			[account, "drafts", "get", "d123", "--bogus"],
			[account, "drafts", "delete", "d123", "--bogus"],
			[account, "drafts", "send", "d123", "--bogus"],
			[account, "drafts", "list", "--bogus"],
			[account, "url", "t123", "--bogus"],
			["accounts", "list", "--bogus"],
			["accounts", "add", "a@x.com", "--bogus"],
			["accounts", "remove", "a@x.com", "--bogus"],
			["--bogus"],
		];

		for (const args of cases) {
			const res = runCli(args, { HOME: fakeHome });
			assert.equal(res.status, 1, `Expected exit 1 for: ${args.join(" ")}`);
			assert.match(res.stderr, /Unknown option '--bogus'/, `Unexpected stderr for ${args.join(" ")}: ${res.stderr}`);
		}

		const jsonUnknown = runCli([account, "thread", "t123", "--json", "--bogus"], { HOME: fakeHome });
		assert.equal(jsonUnknown.status, 1);
		assert.equal(jsonUnknown.stderr, "");
		const parsedErr = JSON.parse(jsonUnknown.stdout);
		assert.equal(parsedErr.ok, false);
		assert.match(parsedErr.error, /Unknown option '--bogus'/);
	});
});

test("-h and --json inside option values do not hijack help or JSON mode", () => {
	withFakeHome((fakeHome) => {
		const account = "missing@example.invalid";

		// Option values containing --json or starting with - via = syntax reach account lookup without triggering help/JSON
		const okVal = runCli(
			[account, "send", "--to", "a@x.com", "--subject", "foo --json", "--body=-h"],
			{ HOME: fakeHome },
		);
		assert.equal(okVal.status, 1);
		assert.equal(okVal.stdout, "");
		assert.match(okVal.stderr, /Account 'missing@example\.invalid' not found/);
		assert.doesNotMatch(okVal.stderr, /gmcli - Gmail CLI/);

		const exactJsonVal = runCli(
			[account, "drafts", "create", "--to", "a@x.com", "--subject=--json", "--body=-h"],
			{ HOME: fakeHome },
		);
		assert.equal(exactJsonVal.status, 1);
		assert.equal(exactJsonVal.stdout, "");
		assert.match(exactJsonVal.stderr, /Account 'missing@example\.invalid' not found/);

		// Separate --body "-h" / --subject "--json" fail cleanly in parseArgs without printing help or JSON
		const spaceDashHelp = runCli(
			[account, "send", "--to", "a@x.com", "--subject", "Test", "--body", "-h"],
			{ HOME: fakeHome },
		);
		assert.equal(spaceDashHelp.status, 1);
		assert.equal(spaceDashHelp.stdout, "");
		assert.doesNotMatch(spaceDashHelp.stderr, /gmcli - Gmail CLI/);
		assert.match(spaceDashHelp.stderr, /Option '--body' argument is ambiguous/);

		const spaceDashJson = runCli(
			[account, "send", "--to", "a@x.com", "--subject", "--json", "--body", "Hello"],
			{ HOME: fakeHome },
		);
		assert.equal(spaceDashJson.status, 1);
		assert.equal(spaceDashJson.stdout, "");
		assert.match(spaceDashJson.stderr, /Option '--subject' argument is ambiguous/);
	});
});

test("--version / -v prints package version and error usage writes to stderr while --help writes to stdout", () => {
	for (const flag of ["--version", "-v"]) {
		const res = runCli([flag]);
		assert.equal(res.status, 0);
		assert.equal(res.stdout.trim(), pkg.version);
		assert.equal(res.stderr, "");
	}

	const versionJson = runCli(["--json", "--version"]);
	assert.equal(versionJson.status, 0);
	assert.deepEqual(JSON.parse(versionJson.stdout), { ok: true, version: pkg.version });

	const noArgs = runCli([]);
	assert.equal(noArgs.status, 1);
	assert.equal(noArgs.stdout, "");
	assert.match(noArgs.stderr, /gmcli - Gmail CLI/);

	const help = runCli(["--help"]);
	assert.equal(help.status, 0);
	assert.equal(help.stderr, "");
	assert.match(help.stdout, /gmcli - Gmail CLI/);
	assert.match(help.stdout, /GMCLI_CLIENT_ID/);
	assert.match(help.stdout, /GMCLI_CLIENT_SECRET/);
	assert.match(help.stdout, /--version, -v/);
});

test("honest exit codes and --json on accounts list/remove, labels validation, and url", () => {
	withFakeHome((fakeHome) => {
		const listJson = runCli(["accounts", "list", "--json"], { HOME: fakeHome });
		assert.equal(listJson.status, 0);
		assert.deepEqual(JSON.parse(listJson.stdout), { ok: true, accounts: [] });

		const removeMissing = runCli(["accounts", "remove", "nobody@example.com"], { HOME: fakeHome });
		assert.equal(removeMissing.status, 1);
		assert.match(removeMissing.stderr, /Account 'nobody@example\.com' not found/);

		const removeMissingJson = runCli(["accounts", "remove", "nobody@example.com", "--json"], { HOME: fakeHome });
		assert.equal(removeMissingJson.status, 1);
		assert.deepEqual(JSON.parse(removeMissingJson.stdout), {
			ok: false,
			error: "Account 'nobody@example.com' not found",
		});

		const labelsNoOps = runCli(["user@example.invalid", "labels", "thread123"], { HOME: fakeHome });
		assert.equal(labelsNoOps.status, 1);
		assert.match(labelsNoOps.stderr, /At least one of --add or --remove is required/);

		const labelsNoOpsJson = runCli(["user@example.invalid", "labels", "thread123", "--json"], { HOME: fakeHome });
		assert.equal(labelsNoOpsJson.status, 1);
		assert.deepEqual(JSON.parse(labelsNoOpsJson.stdout), {
			ok: false,
			error: "At least one of --add or --remove is required.",
		});

		const urlJson = runCli(["you@gmail.com", "url", "t1", "t2", "--json"], { HOME: fakeHome });
		assert.equal(urlJson.status, 0);
		assert.deepEqual(JSON.parse(urlJson.stdout), {
			ok: true,
			urls: [
				{ thread_id: "t1", url: "https://mail.google.com/mail/?authuser=you%40gmail.com#all/t1" },
				{ thread_id: "t2", url: "https://mail.google.com/mail/?authuser=you%40gmail.com#all/t2" },
			],
		});
	});
});

test("decodeBody skips binary and named attachments while extracting nested text bodies", () => {
	const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64url");

	// Only a binary inline attachment => must return empty string, not raw PNG bytes
	assert.equal(
		decodeBody({
			mimeType: "multipart/related",
			parts: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					body: { data: pngBytes },
				},
			],
		}),
		"",
	);

	// Unnamed non-text binary part => skipped
	assert.equal(
		decodeBody({
			mimeType: "application/octet-stream",
			body: { data: pngBytes },
		}),
		"",
	);

	// Named text/plain attachment skipped in favor of actual HTML body
	assert.equal(
		decodeBody({
			mimeType: "multipart/mixed",
			parts: [
				{
					filename: "notes.txt",
					mimeType: "text/plain",
					body: { data: Buffer.from("attachment text").toString("base64url") },
				},
				{
					mimeType: "text/html",
					body: { data: Buffer.from("<p>Real body</p>").toString("base64url") },
				},
			],
		}),
		"<p>Real body</p>",
	);

	// Prefers nested text/plain over sibling HTML or attachments
	assert.equal(
		decodeBody({
			mimeType: "multipart/mixed",
			parts: [
				{
					filename: "logo.png",
					mimeType: "image/png",
					body: { data: pngBytes },
				},
				{
					mimeType: "multipart/alternative",
					parts: [
						{
							mimeType: "text/plain",
							body: { data: Buffer.from("Plain text body").toString("base64url") },
						},
						{
							mimeType: "text/html",
							body: { data: Buffer.from("<p>HTML body</p>").toString("base64url") },
						},
					],
				},
			],
		}),
		"Plain text body",
	);
});

test("formatSize clamps at largest unit for >= 1 TB", () => {
	assert.equal(formatSize(0), "0 B");
	assert.equal(formatSize(512), "512 B");
	assert.equal(formatSize(1024 ** 4), "1.0 TB");
	assert.equal(formatSize(1024 ** 5), "1024.0 TB");
	assert.equal(formatSize(1024 ** 5).includes("undefined"), false);
});

test("search summary selects latest message, unions labels, guards malformed dates, and sanitizes TSV", () => {
	const idToName = new Map([
		["INBOX", "INBOX"],
		["Label_1", "Clients"],
		["SENT", "SENT"],
	]);

	const summary = summarizeSearchThread(
		{
			id: "thread-1",
			historyId: "100",
			messages: [
				{
					id: "m1",
					threadId: "thread-1",
					labelIds: ["INBOX", "Label_1"],
					snippet: "First",
					historyId: "99",
					internalDate: "1700000000000",
					from: "First Sender <first@example.com>",
					to: "will@example.com",
					subject: "Original\tSubject\nLine2",
					date: "Tue, 14 Nov 2023 22:13:20 +0000",
					hasAttachments: false,
				},
				{
					id: "m2",
					threadId: "thread-1",
					labelIds: ["SENT", "Label_1"],
					snippet: "Latest snippet",
					historyId: "100",
					internalDate: "1700086400000",
					from: '"McLemore, Will" <will@example.com>',
					to: "first@example.com",
					subject: "Re: Original\tSubject\r\nLine2",
					date: "not-a-valid-date",
					hasAttachments: false,
				},
			],
		},
		idToName,
	);

	assert.equal(summary.id, "thread-1");
	assert.deepEqual(summary.from, { name: "McLemore, Will", email: "will@example.com" });
	assert.deepEqual(summary.labels, ["INBOX", "Clients", "SENT"]);
	assert.equal(summary.snippet, "Latest snippet");
	assert.deepEqual(summary.messageIds, ["m1", "m2"]);
	// Malformed Date header falls back safely to internalDate instead of throwing RangeError
	assert.equal(summary.dateFormatted, "2023-11-15 22:13");
	assert.equal(formatSearchDate("totally-invalid-date", undefined), "");
	assert.equal(sanitizeTsvField("Re: Original\tSubject\r\nLine2"), "Re: Original Subject Line2");
});
