import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_HTTP_TIMEOUT_MS,
	GMAIL_CLIENT_RETRY_CONFIG,
	GmailService,
	METADATA_HEADERS,
	isGmailNotFoundError,
} from "../dist/gmail-service.js";

function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-perf-test-"));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test("downloadAttachments hits cache with 0 API calls when expected size matches disk", async () => {
	await withTempDir(async (dir) => {
		const attachmentDir = path.join(dir, "attachments");
		const payload = Buffer.from("cached-pdf-content");
		let apiCalls = 0;

		const gmail = {
			users: {
				messages: {
					attachments: {
						get: async () => {
							apiCalls++;
							return { data: { size: payload.length, data: payload.toString("base64url") } };
						},
					},
				},
			},
		};

		const service = new GmailService({ configDir: dir, attachmentDir });
		service.gmailClients.set("test@example.com", gmail);

		// First download populates cache (1 API call)
		const first = await service.downloadAttachments("test@example.com", [
			{
				messageId: "msg123",
				attachmentId: "att1234567890",
				filename: "report.pdf",
				partPath: "0.1",
				size: payload.length,
			},
		]);
		assert.equal(first[0].success, true);
		assert.equal(first[0].cached, false);
		assert.equal(apiCalls, 1);

		// Second download with matching size must make ZERO API calls
		const second = await service.downloadAttachments("test@example.com", [
			{
				messageId: "msg123",
				attachmentId: "att1234567890",
				filename: "report.pdf",
				partPath: "0.1",
				size: payload.length,
			},
		]);
		assert.equal(second[0].success, true);
		assert.equal(second[0].cached, true);
		assert.equal(second[0].path, first[0].path);
		assert.equal(apiCalls, 1, "Expected 0 additional attachments.get calls on size-matched cache hit");
	});
});

test("downloadAttachments fetches ONCE (not twice) on cache size mismatch or unknown size", async () => {
	await withTempDir(async (dir) => {
		const attachmentDir = path.join(dir, "attachments");
		fs.mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });

		const freshPayload = Buffer.from("full-valid-attachment-bytes");
		let apiCalls = 0;

		const gmail = {
			users: {
				messages: {
					attachments: {
						get: async () => {
							apiCalls++;
							return { data: { size: freshPayload.length, data: freshPayload.toString("base64url") } };
						},
					},
				},
			},
		};

		const service = new GmailService({ configDir: dir, attachmentDir });
		service.gmailClients.set("test@example.com", gmail);

		// Pre-populate a truncated/corrupt cached file on disk
		const expectedPath = path.join(attachmentDir, "msg456_att99999_invoice.pdf");
		fs.writeFileSync(expectedPath, Buffer.from("short"), { mode: 0o600 });

		// 1) Mismatched known size -> exactly 1 API call, overwrites stale file
		const resMismatch = await service.downloadAttachments("test@example.com", [
			{
				messageId: "msg456",
				attachmentId: "att99999abcdef",
				filename: "invoice.pdf",
				partPath: "0.1",
				size: freshPayload.length,
			},
		]);
		assert.equal(resMismatch[0].success, true);
		assert.equal(resMismatch[0].cached, false);
		assert.equal(apiCalls, 1, "Expected exactly 1 attachments.get call on cache mismatch, not 2");
		assert.deepEqual(fs.readFileSync(expectedPath), freshPayload);

		// 2) Unknown size (size omitted) with matching disk file -> exactly 1 API call, returns cached: true
		apiCalls = 0;
		const resUnknownMatch = await service.downloadAttachments("test@example.com", [
			{
				messageId: "msg456",
				attachmentId: "att99999abcdef",
				filename: "invoice.pdf",
				partPath: "0.1",
			},
		]);
		assert.equal(resUnknownMatch[0].success, true);
		assert.equal(resUnknownMatch[0].cached, true);
		assert.equal(apiCalls, 1, "Expected exactly 1 attachments.get call when expected size is unknown");
	});
});

test("getThread(--download) forwards part size so repeat downloads make 0 attachment API calls", async () => {
	await withTempDir(async (dir) => {
		const attachmentDir = path.join(dir, "attachments");
		const content = Buffer.from("hello-thread-attachment");
		let attachmentCalls = 0;

		const gmail = {
			users: {
				threads: {
					get: async () => ({
						data: {
							id: "t-1",
							messages: [
								{
									id: "m-1",
									payload: {
										parts: [
											{
												filename: "doc.txt",
												mimeType: "text/plain",
												body: { attachmentId: "att-abc12345", size: content.length },
											},
										],
									},
								},
							],
						},
					}),
				},
				messages: {
					attachments: {
						get: async () => {
							attachmentCalls++;
							return { data: { size: content.length, data: content.toString("base64url") } };
						},
					},
				},
			},
		};

		const service = new GmailService({ configDir: dir, attachmentDir });
		service.gmailClients.set("test@example.com", gmail);

		const first = await service.getThread("test@example.com", "t-1", true);
		assert.equal(first.length, 1);
		assert.equal(first[0].cached, false);
		assert.equal(attachmentCalls, 1);

		const second = await service.getThread("test@example.com", "t-1", true);
		assert.equal(second.length, 1);
		assert.equal(second[0].cached, true);
		assert.equal(attachmentCalls, 1);
	});
});

test("modifyLabels sends addLabelIds and removeLabelIds in one atomic call and trims whitespace", async () => {
	const modifyCalls = [];
	const gmail = {
		users: {
			threads: {
				modify: async (params) => {
					modifyCalls.push(params);
					return { data: { id: params.id } };
				},
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("test@example.com", gmail);

	// Verify resolveLabelIds trims whitespace and drops empties
	const nameToId = new Map([
		["work", "Label_Work"],
		["tax", "Label_Tax"],
		["unread", "UNREAD"],
	]);
	const resolvedAdd = service.resolveLabelIds(" Work , Tax , , Work ".split(","), nameToId);
	assert.deepEqual(resolvedAdd, ["Label_Work", "Label_Tax"]);

	// Verify modifyLabels trims raw inputs and merges add + remove into a SINGLE request
	const results = await service.modifyLabels(
		"test@example.com",
		["t-1", "t-2"],
		[" Label_Work ", "  ", "Label_Tax", "Label_Work"],
		[" UNREAD ", "", " INBOX "],
	);

	assert.deepEqual(results, [
		{ threadId: "t-1", success: true },
		{ threadId: "t-2", success: true },
	]);
	assert.equal(modifyCalls.length, 2, "Expected 1 atomic threads.modify call per thread");
	assert.deepEqual(modifyCalls[0], {
		userId: "me",
		id: "t-1",
		requestBody: {
			addLabelIds: ["Label_Work", "Label_Tax"],
			removeLabelIds: ["UNREAD", "INBOX"],
		},
	});
	assert.deepEqual(modifyCalls[1], {
		userId: "me",
		id: "t-2",
		requestBody: {
			addLabelIds: ["Label_Work", "Label_Tax"],
			removeLabelIds: ["UNREAD", "INBOX"],
		},
	});

	// Whitespace-only labels make zero API calls
	modifyCalls.length = 0;
	const noop = await service.modifyLabels("test@example.com", ["t-3"], ["  ", ""], [""]);
	assert.deepEqual(noop, [{ threadId: "t-3", success: true }]);
	assert.equal(modifyCalls.length, 0);
});

test("searchThreads uses format=metadata + metadataHeaders and preserves order under bounded concurrency", async () => {
	const threadCount = 12;
	const listThreads = Array.from({ length: threadCount }, (_, i) => ({ id: `t-${i}` }));
	const getCalls = [];
	let inFlight = 0;
	let maxInFlight = 0;

	const gmail = {
		users: {
			threads: {
				list: async () => ({
					data: {
						threads: listThreads,
						nextPageToken: "next-page-123",
					},
				}),
				get: async (params) => {
					getCalls.push(params);
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					// Reverse delay so later threads resolve faster than earlier threads
					const idx = Number(params.id.slice(2));
					await new Promise((r) => setTimeout(r, (threadCount - idx) * 3));
					try {
						return {
							data: {
								id: params.id,
								historyId: `h-${idx}`,
								messages: [
									{
										id: `m-${idx}`,
										threadId: params.id,
										labelIds: ["INBOX"],
										snippet: `snippet ${idx}`,
										historyId: `mh-${idx}`,
										internalDate: String(1700000000000 + idx),
										payload: {
											headers: [
												{ name: "From", value: `sender${idx}@example.com` },
												{ name: "To", value: "me@example.com" },
												{ name: "Subject", value: `Subject ${idx}` },
												{ name: "Date", value: "Mon, 20 Apr 2026 10:00:00 +0000" },
											],
										},
									},
								],
							},
						};
					} finally {
						inFlight--;
					}
				},
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("test@example.com", gmail);

	const result = await service.searchThreads("test@example.com", "in:inbox", threadCount);

	assert.equal(result.nextPageToken, "next-page-123");
	assert.equal(result.threads.length, threadCount);
	assert.deepEqual(
		result.threads.map((t) => t.id),
		listThreads.map((t) => t.id),
		"Threads must preserve list order despite out-of-order async completion",
	);
	assert.equal(result.threads[0].messages[0].from, "sender0@example.com");
	assert.equal(result.threads[0].messages[0].to, "me@example.com");
	assert.equal(result.threads[0].messages[0].subject, "Subject 0");
	assert.equal(result.threads[0].messages[0].hasAttachments, false);

	assert.equal(getCalls.length, threadCount);
	for (const call of getCalls) {
		assert.equal(call.format, "metadata");
		assert.deepEqual(call.metadataHeaders, METADATA_HEADERS);
	}
	assert.ok(
		maxInFlight >= 2 && maxInFlight <= DEFAULT_CONCURRENCY,
		`Expected 2..${DEFAULT_CONCURRENCY} concurrent requests, got ${maxInFlight}`,
	);
});

test("getGmailClient configures HTTP timeout and safe retryConfig excluding POST", async () => {
	await withTempDir(async (dir) => {
		const service = new GmailService({ configDir: dir });
		service.setCredentials("test-client-id", "test-client-secret");
		service.accountStorage.addAccount({
			email: "retry-test@example.com",
			oauth2: {
				clientId: "test-client-id",
				clientSecret: "test-client-secret",
				refreshToken: "test-refresh-token",
			},
		});

		const gmail = service.getGmailClient("retry-test@example.com");
		const opts = gmail.context._options;

		assert.equal(opts.timeout, DEFAULT_HTTP_TIMEOUT_MS);
		assert.equal(opts.timeout, 30_000);
		assert.equal(opts.retry, true);
		assert.equal(opts.retryConfig.retry, GMAIL_CLIENT_RETRY_CONFIG.retry);
		assert.deepEqual(opts.retryConfig.statusCodesToRetry, [
			[429, 429],
			[500, 599],
		]);
		assert.deepEqual(opts.retryConfig.httpMethodsToRetry, ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
		assert.equal(
			opts.retryConfig.httpMethodsToRetry.includes("POST"),
			false,
			"POST must never be auto-retried to prevent duplicate sends/drafts",
		);
		assert.equal(opts.auth.transporter.defaults.timeout, DEFAULT_HTTP_TIMEOUT_MS);
	});
});

test("isGmailNotFoundError identifies 404 responses and rejects auth/rate-limit/network errors", () => {
	assert.equal(isGmailNotFoundError({ code: 404 }), true);
	assert.equal(isGmailNotFoundError({ code: "404" }), true);
	assert.equal(isGmailNotFoundError({ status: 404 }), true);
	assert.equal(isGmailNotFoundError({ response: { status: 404 } }), true);
	assert.equal(isGmailNotFoundError({ response: { data: { error: { code: 404 } } } }), true);

	assert.equal(isGmailNotFoundError({ code: 401, response: { status: 401 } }), false);
	assert.equal(isGmailNotFoundError({ code: 403, response: { status: 403 } }), false);
	assert.equal(isGmailNotFoundError({ status: 429, response: { status: 429 } }), false);
	assert.equal(isGmailNotFoundError({ status: 503, response: { status: 503 } }), false);
	assert.equal(isGmailNotFoundError({ code: "ECONNRESET" }), false);
	assert.equal(isGmailNotFoundError(new Error("Thread not found")), false);
	assert.equal(isGmailNotFoundError(null), false);
});
