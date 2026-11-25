import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AccountStorage } from "../dist/account-storage.js";
import { GmailOAuthFlow, escapeHtml, verifyOAuthState } from "../dist/gmail-oauth-flow.js";
import {
	GmailService,
	MAX_TOTAL_ATTACHMENT_BYTES,
	buildRawMimeMessage,
	encodeMimeHeader,
	sanitizeAttachmentHeaderFilename,
	sanitizeInboundFilename,
} from "../dist/gmail-service.js";

function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-pr1-test-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function withTempDirAsync(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-pr1-test-"));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function decodeRfc2047(encoded) {
	// Per RFC 2047 §6.2, linear whitespace separating adjacent encoded-words is ignored.
	const collapsed = encoded.replace(/\?=\r\n[ \t]+=\?/g, "?==?");
	return collapsed.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_, b64) =>
		Buffer.from(b64, "base64").toString("utf8"),
	);
}

test("dead code updateDraft is removed from GmailService", () => {
	assert.equal(typeof GmailService.prototype.updateDraft, "undefined");
});

test("buildRawMimeMessage rejects CRLF header injection across all header fields and attachment filenames", () => {
	const base = {
		from: "will@example.com",
		to: ["buyer@example.com"],
		subject: "Normal subject",
		body: "Hello",
	};

	assert.throws(() => buildRawMimeMessage({ ...base, from: "will@example.com\r\nBcc: evil@example.com" }), /CR or LF/);
	assert.throws(
		() => buildRawMimeMessage({ ...base, to: ["buyer@example.com\r\nBcc: evil@example.com"] }),
		/CR or LF/,
	);
	assert.throws(
		() => buildRawMimeMessage({ ...base, cc: ["ok@example.com", "bad@example.com\nX-Injected: 1"] }),
		/CR or LF/,
	);
	assert.throws(() => buildRawMimeMessage({ ...base, bcc: ["bad@example.com\rX-Injected: 1"] }), /CR or LF/);
	assert.throws(
		() => buildRawMimeMessage({ ...base, subject: "Hello\r\nBcc: evil@example.com" }),
		/CR or LF/,
	);
	assert.throws(
		() => buildRawMimeMessage({ ...base, inReplyTo: "<id@example.com>\r\nX-Bad: yes" }),
		/CR or LF/,
	);
	assert.throws(
		() => buildRawMimeMessage({ ...base, references: "<a@example.com>\n<b@example.com>" }),
		/CR or LF/,
	);
	assert.throws(() => encodeMimeHeader("Line1\r\nLine2"), /CR or LF/);

	// Attachment filename CRLF injection (even on an actual file on disk)
	withTempDir((dir) => {
		const evilFile = path.join(dir, "invoice\nBcc: evil@example.com.pdf");
		fs.writeFileSync(evilFile, "pdf-bytes");
		assert.throws(() => buildRawMimeMessage({ ...base, attachments: [evilFile] }), /CR or LF/);
	});
});

test("encodeMimeHeader folds long UTF-8 subjects to <= 75 chars per encoded-word without corrupting multi-byte chars", () => {
	const subjects = [
		"Auction update — McLemore Auction Company — Lot #1042 closing soon 🎉🔥 — Final reminder for all bidders!",
		"————————————————————————————————————————",
		"🎉".repeat(30),
		`${"a".repeat(37)}—${"b".repeat(38)}🎉${"c".repeat(36)}—end`,
	];

	for (const subject of subjects) {
		const encoded = encodeMimeHeader(subject);
		const tokens = encoded.split("\r\n ");
		assert.ok(tokens.length > 1, `expected multiple folded tokens for: ${subject}`);
		for (const token of tokens) {
			assert.match(token, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
			assert.ok(token.length <= 75, `encoded-word exceeded 75 chars (${token.length}): ${token}`);
			// Each token must independently decode to valid UTF-8 with no U+FFFD replacement chars
			const b64 = token.slice("=?UTF-8?B?".length, -"?=".length);
			const decodedChunk = Buffer.from(b64, "base64").toString("utf8");
			assert.equal(decodedChunk.includes("\uFFFD"), false, `corrupted UTF-8 boundary in chunk: ${decodedChunk}`);
		}
		assert.equal(decodeRfc2047(encoded), subject);
	}
});

test("buildRawMimeMessage wraps body and attachment base64 at 76 chars, handles UTF-8 HTML, and sanitizes filenames", () => {
	withTempDir((dir) => {
		const attachFile = path.join(dir, 'Q1 "Summary" \\ Report.txt');
		const attachBytes = Buffer.alloc(300, 0x41); // 300 bytes => 400 base64 chars => multiple 76-char lines
		fs.writeFileSync(attachFile, attachBytes);

		const htmlBody = `<p>${"Long UTF-8 line — 🎉 ".repeat(20)}</p>`;
		const raw = buildRawMimeMessage({
			from: "will@example.com",
			to: ["buyer@example.com"],
			subject: "HTML + attachment",
			body: htmlBody,
			attachments: [attachFile],
			html: true,
		});

		// Verify random hex boundary (32 hex chars from 16 random bytes)
		const boundaryMatch = raw.match(/Content-Type: multipart\/mixed; boundary="(boundary_[0-9a-f]{32})"/);
		assert.ok(boundaryMatch, "expected crypto-random 16-byte hex MIME boundary");
		const boundary = boundaryMatch[1];

		// Verify escaped attachment filename in Content-Disposition
		assert.match(
			raw,
			/Content-Disposition: attachment; filename="Q1 \\"Summary\\" \\\\ Report\.txt"\r\n/,
		);

		// Verify every line in the raw MIME message respects RFC line wrapping
		for (const line of raw.split("\r\n")) {
			assert.ok(line.length <= 200, `unexpectedly long MIME line (${line.length}): ${line.slice(0, 80)}`);
		}

		// Extract parts and verify 76-char wrapping + exact round-trip decoding
		const parts = raw.split(`--${boundary}`).slice(1, -1);
		assert.equal(parts.length, 2);

		const [bodyPart, attachPart] = parts;
		assert.match(bodyPart, /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
		const bodyB64Lines = bodyPart.split("\r\n\r\n")[1].trim().split("\r\n");
		assert.ok(bodyB64Lines.length > 1);
		for (const line of bodyB64Lines) {
			assert.ok(line.length <= 76, `body base64 line exceeded 76 chars: ${line.length}`);
		}
		assert.equal(Buffer.from(bodyB64Lines.join(""), "base64").toString("utf8"), htmlBody);

		const attachB64Lines = attachPart.split("\r\n\r\n")[1].trim().split("\r\n");
		assert.ok(attachB64Lines.length > 1);
		for (const line of attachB64Lines) {
			assert.ok(line.length <= 76, `attachment base64 line exceeded 76 chars: ${line.length}`);
		}
		assert.deepEqual(Buffer.from(attachB64Lines.join(""), "base64"), attachBytes);
	});
});

test("sanitizeAttachmentHeaderFilename strips control chars and path separators and escapes quotes/backslashes", () => {
	assert.equal(sanitizeAttachmentHeaderFilename('a/b\0\r\n"c"\\d.pdf'), 'ab\\"c\\"\\\\d.pdf');
	assert.equal(sanitizeAttachmentHeaderFilename("\r\n\0/"), "attachment");
});

test("buildRawMimeMessage and GmailService preflight-validate missing, directory, and >25MB attachments before API calls", async () => {
	await withTempDirAsync(async (dir) => {
		const missingPath = path.join(dir, "does-not-exist.pdf");
		const subDir = path.join(dir, "a-directory");
		fs.mkdirSync(subDir);

		// Create sparse file > 25 MB (uses negligible disk space on APFS/ext4)
		const oversizePath = path.join(dir, "too-big.bin");
		const fd = fs.openSync(oversizePath, "w");
		try {
			fs.ftruncateSync(fd, MAX_TOTAL_ATTACHMENT_BYTES + 1);
		} finally {
			fs.closeSync(fd);
		}

		const base = {
			from: "will@example.com",
			to: ["buyer@example.com"],
			subject: "Test",
			body: "Body",
		};

		assert.throws(() => buildRawMimeMessage({ ...base, attachments: [missingPath] }), /not found/i);
		assert.throws(() => buildRawMimeMessage({ ...base, attachments: [subDir] }), /not a regular file/i);
		assert.throws(() => buildRawMimeMessage({ ...base, attachments: [oversizePath] }), /25 MB/);

		// Ensure Gmail API is never invoked when attachment validation fails
		let apiCalled = false;
		const fakeGmail = {
			users: {
				messages: {
					get: async () => {
						apiCalled = true;
						throw new Error("should not be called");
					},
					send: async () => {
						apiCalled = true;
						throw new Error("should not be called");
					},
				},
				drafts: {
					create: async () => {
						apiCalled = true;
						throw new Error("should not be called");
					},
				},
			},
		};

		const service = new GmailService({ configDir: dir });
		service.gmailClients.set("will@example.com", fakeGmail);

		await assert.rejects(
			() =>
				service.createDraft("will@example.com", ["buyer@example.com"], "Subj", "Body", {
					attachments: [missingPath],
					replyToMessageId: "msg-1",
				}),
			/not found/i,
		);
		await assert.rejects(
			() =>
				service.sendMessage("will@example.com", ["buyer@example.com"], "Subj", "Body", {
					attachments: [oversizePath],
				}),
			/25 MB/,
		);
		assert.equal(apiCalled, false);
	});
});

test("sanitizeInboundFilename blocks traversal, Windows separators, leading dots, and control chars", () => {
	assert.equal(sanitizeInboundFilename("../../../../etc/passwd"), "passwd");
	assert.equal(sanitizeInboundFilename("..\\..\\evil.exe"), "evil.exe");
	assert.equal(sanitizeInboundFilename("nested/dir/report.pdf"), "report.pdf");
	assert.equal(sanitizeInboundFilename(".../.bashrc"), "bashrc");
	assert.equal(sanitizeInboundFilename(".."), "attachment");
	assert.equal(sanitizeInboundFilename("   "), "attachment");
	assert.equal(sanitizeInboundFilename("file\x00name\r\n.txt"), "filename.txt");
});

test("downloadAttachments contains traversal filenames inside attachmentDir with 0700 dir and 0600 file perms", async () => {
	await withTempDirAsync(async (dir) => {
		const attachmentDir = path.join(dir, "attachments");
		fs.mkdirSync(attachmentDir, { mode: 0o755 });
		fs.chmodSync(attachmentDir, 0o755);

		const apiPayload = Buffer.from("api-attachment-content");
		const inlinePayload = Buffer.from("inline-attachment-content");

		const fakeGmail = {
			users: {
				messages: {
					get: async () => ({
						data: {
							id: "msg-99",
							payload: {
								mimeType: "multipart/mixed",
								parts: [
									{
										filename: "../../../../etc/passwd",
										mimeType: "application/octet-stream",
										body: { attachmentId: "att123456789", size: apiPayload.length },
									},
									{
										filename: "..\\..\\evil",
										mimeType: "text/plain",
										body: { data: inlinePayload.toString("base64url"), size: inlinePayload.length },
									},
									{
										filename: "a/b/c/nested.pdf",
										mimeType: "application/pdf",
										body: { data: inlinePayload.toString("base64url"), size: inlinePayload.length },
									},
								],
							},
						},
					}),
					attachments: {
						get: async () => ({
							data: { data: apiPayload.toString("base64url"), size: apiPayload.length },
						}),
					},
				},
			},
		};

		const service = new GmailService({ configDir: dir, attachmentDir });
		service.gmailClients.set("will@example.com", fakeGmail);

		const downloaded = await service.downloadMessageAttachments("will@example.com", "msg-99");
		assert.equal(downloaded.length, 3);

		// Attachment directory permissions tightened to 0700
		const dirMode = fs.statSync(attachmentDir).mode & 0o777;
		assert.equal(dirMode, 0o700);

		const resolvedDir = path.resolve(attachmentDir);
		for (const item of downloaded) {
			const resolvedPath = path.resolve(item.path);
			assert.ok(
				resolvedPath.startsWith(resolvedDir + path.sep),
				`attachment escaped attachmentDir: ${resolvedPath}`,
			);
			assert.equal(path.dirname(resolvedPath), resolvedDir);
			const fileMode = fs.statSync(resolvedPath).mode & 0o777;
			assert.equal(fileMode, 0o600);
		}

		// Verify sanitized basenames
		assert.ok(path.basename(downloaded[0].path).endsWith("_passwd"));
		assert.ok(path.basename(downloaded[1].path).endsWith("_evil"));
		assert.ok(path.basename(downloaded[2].path).endsWith("_nested.pdf"));
	});
});

test("AccountStorage enforces 0700/0600 permissions, atomic writes, ENOENT empty list, and loud error on corrupt JSON", () => {
	withTempDir((dir) => {
		const configDir = path.join(dir, "gmcli-config");
		fs.mkdirSync(configDir, { mode: 0o755 });
		fs.chmodSync(configDir, 0o755);

		// ENOENT -> empty accounts list, dir tightened to 0700
		const storage = new AccountStorage(configDir);
		assert.deepEqual(storage.getAllAccounts(), []);
		assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);

		// Atomic write with 0600 permissions and stripped clientId/clientSecret
		storage.addAccount({
			email: "will@example.com",
			oauth2: {
				clientId: "should-not-persist",
				clientSecret: "secret-should-not-persist",
				refreshToken: "refresh-123",
			},
		});

		const accountsFile = path.join(configDir, "accounts.json");
		assert.equal(fs.statSync(accountsFile).mode & 0o777, 0o600);

		// No stray temp files left behind
		const entries = fs.readdirSync(configDir);
		assert.deepEqual(entries, ["accounts.json"]);

		const saved = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
		assert.equal(saved.length, 1);
		assert.equal(saved[0].email, "will@example.com");
		assert.equal(saved[0].oauth2.refreshToken, "refresh-123");
		assert.equal("clientId" in saved[0].oauth2, false);
		assert.equal("clientSecret" in saved[0].oauth2, false);

		// Corrupt JSON throws loud, actionable error instead of silently returning []
		fs.writeFileSync(accountsFile, "{not valid json", { mode: 0o600 });
		assert.throws(() => new AccountStorage(configDir), /Failed to parse accounts file.*corrupted/i);

		// Non-array JSON also throws loudly
		fs.writeFileSync(accountsFile, JSON.stringify({ email: "wrong-shape" }), { mode: 0o600 });
		assert.throws(() => new AccountStorage(configDir), /expected a JSON array/i);
	});
});

test("OAuth helpers escape HTML and verify CSRF state strictly", () => {
	assert.equal(
		escapeHtml(`<script>alert("x" & 'y')</script>`),
		"&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
	);
	assert.equal(verifyOAuthState("abc123", "abc123"), true);
	assert.equal(verifyOAuthState("abc123", "abc124"), false);
	assert.equal(verifyOAuthState("abc123", "abc12"), false);
	assert.equal(verifyOAuthState("abc123", ""), false);
	assert.equal(verifyOAuthState("abc123", null), false);
	assert.equal(verifyOAuthState("", ""), false);
});

test("GmailOAuthFlow sends prompt=consent + CSRF state, rejects state mismatch, and escapes callback errors", async () => {
	// 1. State mismatch rejects without calling getToken
	{
		let capturedAuthUrl = null;
		let tokenCalled = false;
		const flow = new GmailOAuthFlow("cid", "csec");
		flow.createOAuth2Client = (redirectUri) => ({
			generateAuthUrl: (opts) => {
				const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				u.searchParams.set("redirect_uri", redirectUri);
				u.searchParams.set("access_type", opts.access_type);
				u.searchParams.set("prompt", opts.prompt);
				u.searchParams.set("state", opts.state);
				return u.toString();
			},
			getToken: async () => {
				tokenCalled = true;
				return { tokens: { refresh_token: "should-not-happen" } };
			},
		});
		flow.openBrowser = (authUrl) => {
			capturedAuthUrl = authUrl;
			const parsedAuth = new URL(authUrl);
			const redirectUri = parsedAuth.searchParams.get("redirect_uri");
			void fetch(`${redirectUri}/?code=abc&state=wrong-state`);
		};

		await assert.rejects(() => flow.authorize(false), /OAuth state mismatch/);
		assert.equal(tokenCalled, false);
		assert.ok(capturedAuthUrl);
		const authParams = new URL(capturedAuthUrl).searchParams;
		assert.equal(authParams.get("prompt"), "consent");
		assert.match(authParams.get("state") || "", /^[0-9a-f]{48}$/);
	}

	// 2. Callback error message HTML is escaped (no reflected XSS)
	{
		let responseHtml = "";
		let responseStatus = 0;
		const flow = new GmailOAuthFlow("cid", "csec");
		flow.createOAuth2Client = (redirectUri) => ({
			generateAuthUrl: (opts) => {
				const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				u.searchParams.set("redirect_uri", redirectUri);
				u.searchParams.set("state", opts.state);
				return u.toString();
			},
			getToken: async () => {
				throw new Error('<img src=x onerror="alert(1)">');
			},
		});
		flow.openBrowser = (authUrl) => {
			const parsedAuth = new URL(authUrl);
			const redirectUri = parsedAuth.searchParams.get("redirect_uri");
			const state = parsedAuth.searchParams.get("state");
			void fetch(`${redirectUri}/?code=abc&state=${state}`).then(async (res) => {
				responseStatus = res.status;
				responseHtml = await res.text();
			});
		};

		await assert.rejects(() => flow.authorize(false), /onerror/);
		// Wait a tick for fetch text promise to resolve
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(responseStatus, 500);
		assert.equal(responseHtml.includes("<img"), false);
		assert.ok(responseHtml.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
	}

	// 3. Valid state exchanges code and returns refresh token
	{
		let receivedCode = null;
		const flow = new GmailOAuthFlow("cid", "csec");
		flow.createOAuth2Client = (redirectUri) => ({
			generateAuthUrl: (opts) => {
				const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				u.searchParams.set("redirect_uri", redirectUri);
				u.searchParams.set("state", opts.state);
				return u.toString();
			},
			getToken: async (code) => {
				receivedCode = code;
				return { tokens: { refresh_token: "fresh-refresh-token" } };
			},
		});
		flow.openBrowser = (authUrl) => {
			const parsedAuth = new URL(authUrl);
			const redirectUri = parsedAuth.searchParams.get("redirect_uri");
			const state = parsedAuth.searchParams.get("state");
			void fetch(`${redirectUri}/?code=good-code&state=${state}`);
		};

		const token = await flow.authorize(false);
		assert.equal(token, "fresh-refresh-token");
		assert.equal(receivedCode, "good-code");
	}
});
