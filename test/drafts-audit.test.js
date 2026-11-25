import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildSentSearchQuery,
	formatDraftAuditMarkdown,
	formatDraftAuditTable,
	parseOlderThan,
} from "../dist/drafts-audit.js";
import { GmailService } from "../dist/gmail-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

const NOW_MS = Date.parse("2026-04-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function makeMutatingTrap(name) {
	return async () => {
		throw new Error(`Mutating Gmail API method must never be called during drafts audit: ${name}`);
	};
}

function makeFakeGmail({ draftsList = [], draftsById = {}, threadsById = {}, sentSearch = () => [], messagesById = {} }) {
	const readCalls = [];
	const gmail = {
		users: {
			drafts: {
				list: async (params) => {
					readCalls.push({ method: "drafts.list", params });
					return { data: { drafts: draftsList } };
				},
				get: async (params) => {
					readCalls.push({ method: "drafts.get", params });
					const draft = draftsById[params.id];
					if (!draft) throw new Error(`Draft not found: ${params.id}`);
					return { data: draft };
				},
				create: makeMutatingTrap("drafts.create"),
				update: makeMutatingTrap("drafts.update"),
				delete: makeMutatingTrap("drafts.delete"),
				send: makeMutatingTrap("drafts.send"),
			},
			threads: {
				get: async (params) => {
					readCalls.push({ method: "threads.get", params });
					const thread = threadsById[params.id];
					if (!thread) throw new Error(`Thread not found: ${params.id}`);
					return { data: thread };
				},
				delete: makeMutatingTrap("threads.delete"),
				trash: makeMutatingTrap("threads.trash"),
				modify: makeMutatingTrap("threads.modify"),
			},
			messages: {
				list: async (params) => {
					readCalls.push({ method: "messages.list", params });
					return { data: { messages: sentSearch(params.q) } };
				},
				get: async (params) => {
					readCalls.push({ method: "messages.get", params });
					const msg = messagesById[params.id];
					if (!msg) throw new Error(`Message not found: ${params.id}`);
					return { data: msg };
				},
				send: makeMutatingTrap("messages.send"),
				delete: makeMutatingTrap("messages.delete"),
				trash: makeMutatingTrap("messages.trash"),
				modify: makeMutatingTrap("messages.modify"),
			},
		},
	};
	return { gmail, readCalls };
}

test("parseOlderThan parses d/h/w/m/y and all, and rejects invalid values", () => {
	const oneDay = parseOlderThan("1d", NOW_MS);
	assert.equal(oneDay.cutoffMs, NOW_MS - DAY_MS);
	assert.equal(oneDay.gmailQueryToken, "older_than:1d");

	const twelveHours = parseOlderThan("12h", NOW_MS);
	assert.equal(twelveHours.cutoffMs, NOW_MS - 12 * 60 * 60 * 1000);
	assert.equal(twelveHours.gmailQueryToken, null);

	const twoWeeks = parseOlderThan("2w", NOW_MS);
	assert.equal(twoWeeks.cutoffMs, NOW_MS - 14 * DAY_MS);
	assert.equal(twoWeeks.gmailQueryToken, "older_than:14d");

	const all = parseOlderThan("all", NOW_MS);
	assert.equal(all.cutoffMs, null);
	assert.equal(all.gmailQueryToken, null);

	assert.throws(() => parseOlderThan("bogus", NOW_MS), /Invalid --older-than/);
});

test("buildSentSearchQuery uses normalized subject and primary recipient", () => {
	assert.equal(
		buildSentSearchQuery('fhl1145 "settlement" summary', [{ name: "Caleb", email: "caleb@example.com" }]),
		'in:sent subject:"fhl1145 settlement summary" to:caleb@example.com',
	);
	assert.equal(buildSentSearchQuery("", []), null);
});

test("buildSentSearchQuery matches multiple To/Cc recipients with OR and caps at 5 unique emails", () => {
	assert.equal(
		buildSentSearchQuery("settlement update", [
			{ name: "Alice", email: "alice@example.com" },
			{ name: "Bob", email: "BOB@example.com" },
			{ name: "Alice Dup", email: "alice@example.com" },
		]),
		'in:sent subject:"settlement update" (to:alice@example.com OR to:bob@example.com)',
	);

	const sevenRecipients = Array.from({ length: 7 }, (_, i) => ({
		name: `User ${i + 1}`,
		email: `user${i + 1}@example.com`,
	}));
	assert.equal(
		buildSentSearchQuery("group notice", sevenRecipients),
		'in:sent subject:"group notice" (to:user1@example.com OR to:user2@example.com OR to:user3@example.com OR to:user4@example.com OR to:user5@example.com)',
	);
});

test("auditDrafts finds sent duplicate sent to a CC recipient via multi-recipient search", async () => {
	const twoDaysAgo = String(NOW_MS - 2 * DAY_MS);
	const queries = [];
	const { gmail } = makeFakeGmail({
		draftsList: [{ id: "r-cc-dup" }],
		draftsById: {
			"r-cc-dup": {
				id: "r-cc-dup",
				message: {
					id: "m-cc-draft",
					threadId: "t-cc-draft",
					internalDate: twoDaysAgo,
					labelIds: ["DRAFT"],
					payload: {
						headers: [
							{ name: "To", value: "primary@example.com" },
							{ name: "Cc", value: "secondary@example.com" },
							{ name: "Subject", value: "Closing docs" },
						],
					},
				},
			},
		},
		threadsById: {
			"t-cc-draft": {
				id: "t-cc-draft",
				messages: [{ id: "m-cc-draft", threadId: "t-cc-draft", labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
			},
		},
		sentSearch: (q) => {
			queries.push(q);
			if (q.includes("to:secondary@example.com")) {
				return [{ id: "m-sent-to-cc" }];
			}
			return [];
		},
		messagesById: {
			"m-sent-to-cc": {
				id: "m-sent-to-cc",
				threadId: "t-sent-separate",
				labelIds: ["SENT"],
				internalDate: String(NOW_MS - 1.5 * DAY_MS),
				payload: {
					headers: [
						{ name: "To", value: "secondary@example.com" },
						{ name: "Subject", value: "Closing docs" },
					],
				},
			},
		},
	});

	const service = new GmailService();
	service.gmailClients.set("will@mclemoreauction.com", gmail);
	const result = await service.auditDrafts("will@mclemoreauction.com", {
		olderThan: "1d",
		checkSent: true,
		nowMs: NOW_MS,
	});

	assert.equal(queries.length, 1);
	assert.equal(queries[0], 'in:sent subject:"closing docs" (to:primary@example.com OR to:secondary@example.com)');
	assert.equal(result.drafts[0].disposition, "likely_duplicate_sent");
	assert.equal(result.drafts[0].sent_candidates[0].message_id, "m-sent-to-cc");
	assert.equal(result.drafts[0].sent_candidates[0].match_kind, "subject_and_recipient");
});

test("auditDrafts returns null on 404 thread/message lookups but propagates 401 and 429 errors", async () => {
	const twoDaysAgo = String(NOW_MS - 2 * DAY_MS);
	const baseDraft = {
		id: "r-err",
		message: {
			id: "m-err",
			threadId: "t-err",
			internalDate: twoDaysAgo,
			labelIds: ["DRAFT"],
			payload: {
				headers: [
					{ name: "To", value: "client@example.com" },
					{ name: "Subject", value: "Status update" },
				],
			},
		},
	};

	// Genuine 404 on threads.get and messages.get is handled gracefully
	const notFoundErr = Object.assign(new Error("Not Found"), { code: 404, response: { status: 404 } });
	const { gmail: gmail404 } = makeFakeGmail({
		draftsList: [{ id: "r-err" }],
		draftsById: { "r-err": baseDraft },
		sentSearch: () => [{ id: "m-vanished" }],
	});
	gmail404.users.threads.get = async () => {
		throw notFoundErr;
	};
	gmail404.users.messages.get = async () => {
		throw notFoundErr;
	};

	const svc404 = new GmailService();
	svc404.gmailClients.set("will@mclemoreauction.com", gmail404);
	const res404 = await svc404.auditDrafts("will@mclemoreauction.com", {
		olderThan: "1d",
		checkSent: true,
		nowMs: NOW_MS,
	});
	assert.equal(res404.drafts.length, 1);
	assert.equal(res404.drafts[0].disposition, "not_proven_duplicate");

	// 401 on threads.get must propagate, NEVER silently produce not_proven_duplicate
	const authErr = Object.assign(new Error("Invalid Credentials"), { code: 401, response: { status: 401 } });
	const { gmail: gmail401 } = makeFakeGmail({
		draftsList: [{ id: "r-err" }],
		draftsById: { "r-err": baseDraft },
	});
	gmail401.users.threads.get = async () => {
		throw authErr;
	};
	const svc401 = new GmailService();
	svc401.gmailClients.set("will@mclemoreauction.com", gmail401);
	await assert.rejects(
		() => svc401.auditDrafts("will@mclemoreauction.com", { olderThan: "1d", checkSent: true, nowMs: NOW_MS }),
		/Invalid Credentials/,
	);

	// 429 on messages.get must propagate, NEVER silently produce not_proven_duplicate
	const rateLimitErr = Object.assign(new Error("Rate Limit Exceeded"), { status: 429, response: { status: 429 } });
	const { gmail: gmail429 } = makeFakeGmail({
		draftsList: [{ id: "r-err" }],
		draftsById: { "r-err": baseDraft },
		threadsById: {
			"t-err": { id: "t-err", messages: [{ id: "m-err", threadId: "t-err", labelIds: ["DRAFT"] }] },
		},
		sentSearch: () => [{ id: "m-sent-1" }],
	});
	gmail429.users.messages.get = async () => {
		throw rateLimitErr;
	};
	const svc429 = new GmailService();
	svc429.gmailClients.set("will@mclemoreauction.com", gmail429);
	await assert.rejects(
		() => svc429.auditDrafts("will@mclemoreauction.com", { olderThan: "1d", checkSent: true, nowMs: NOW_MS }),
		/Rate Limit Exceeded/,
	);
});

test("auditDrafts fetches drafts and threads with bounded concurrency while preserving order", async () => {
	const twoDaysAgo = String(NOW_MS - 2 * DAY_MS);
	const count = 12;
	const draftsList = Array.from({ length: count }, (_, i) => ({ id: `r-${i}` }));
	const draftsById = {};
	const threadsById = {};
	for (let i = 0; i < count; i++) {
		draftsById[`r-${i}`] = {
			id: `r-${i}`,
			message: {
				id: `m-${i}`,
				threadId: `t-${i}`,
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: `user${i}@example.com` },
						{ name: "Subject", value: `Draft ${i}` },
					],
				},
			},
		};
		threadsById[`t-${i}`] = {
			id: `t-${i}`,
			messages: [{ id: `m-${i}`, threadId: `t-${i}`, labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
		};
	}

	let draftInFlight = 0;
	let maxDraftInFlight = 0;
	let threadInFlight = 0;
	let maxThreadInFlight = 0;

	const { gmail } = makeFakeGmail({ draftsList, draftsById, threadsById });
	const origDraftGet = gmail.users.drafts.get;
	gmail.users.drafts.get = async (params) => {
		draftInFlight++;
		maxDraftInFlight = Math.max(maxDraftInFlight, draftInFlight);
		await new Promise((r) => setTimeout(r, 15 - (Number(params.id.slice(2)) % 5) * 2));
		try {
			return await origDraftGet(params);
		} finally {
			draftInFlight--;
		}
	};
	const origThreadGet = gmail.users.threads.get;
	gmail.users.threads.get = async (params) => {
		threadInFlight++;
		maxThreadInFlight = Math.max(maxThreadInFlight, threadInFlight);
		await new Promise((r) => setTimeout(r, 15 - (Number(params.id.slice(2)) % 5) * 2));
		try {
			return await origThreadGet(params);
		} finally {
			threadInFlight--;
		}
	};

	const service = new GmailService();
	service.gmailClients.set("will@mclemoreauction.com", gmail);
	const result = await service.auditDrafts("will@mclemoreauction.com", {
		olderThan: "1d",
		checkSent: true,
		nowMs: NOW_MS,
	});

	assert.equal(result.drafts.length, count);
	assert.deepEqual(
		result.drafts.map((d) => d.draft_id),
		draftsList.map((d) => d.id),
	);
	assert.ok(maxDraftInFlight >= 2 && maxDraftInFlight <= 5, `Expected 2..5 concurrent draft fetches, got ${maxDraftInFlight}`);
	assert.ok(maxThreadInFlight >= 2 && maxThreadInFlight <= 5, `Expected 2..5 concurrent thread fetches, got ${maxThreadInFlight}`);
});

test("auditDrafts classifies all 4 dispositions, extracts attachments, and makes zero mutating calls", async () => {
	const twoDaysAgo = String(NOW_MS - 2 * DAY_MS);
	const threeDaysAgo = String(NOW_MS - 3 * DAY_MS);
	const twoHoursAgo = String(NOW_MS - 2 * 60 * 60 * 1000);

	const draftsList = [
		{ id: "r-fresh" },
		{ id: "r-fhl-dup" },
		{ id: "r-dwayne-newer" },
		{ id: "r-dwayne-older" },
		{ id: "r-legit" },
		{ id: "r-missing-to" },
		{ id: "r-ambiguous-subj" },
		{ id: "r-earlier-thread-sent" },
	];

	const draftsById = {
		"r-fresh": {
			id: "r-fresh",
			message: {
				id: "m-fresh",
				threadId: "t-fresh",
				internalDate: twoHoursAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "someone@example.com" },
						{ name: "Subject", value: "Brand new draft" },
					],
				},
			},
		},
		// 1) likely_duplicate_sent via in:sent subject + recipient (with attachment metadata)
		"r-fhl-dup": {
			id: "r-fhl-dup",
			message: {
				id: "m-fhl-draft",
				threadId: "t-fhl-draft",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "Caleb <caleb@example.com>" },
						{ name: "Cc", value: "eric@example.com" },
						{ name: "Subject", value: "Re: FHL1145/SUN76 Settlement" },
					],
					parts: [
						{ mimeType: "text/plain", body: { data: Buffer.from("Attached").toString("base64url") } },
						{
							filename: "FHL1145_Statement.pdf",
							mimeType: "application/pdf",
							body: { size: 25600, attachmentId: "att-1" },
						},
					],
				},
			},
		},
		// 2) Dwayne #3403: newer draft matches thread SENT (likely_duplicate_sent), older draft is conflicting_obsolete_candidate
		"r-dwayne-newer": {
			id: "r-dwayne-newer",
			message: {
				id: "m-dwayne-new",
				threadId: "t-dwayne",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "dwayne@example.com" },
						{ name: "Subject", value: "Dwayne #3403 payout" },
					],
				},
			},
		},
		"r-dwayne-older": {
			id: "r-dwayne-older",
			message: {
				id: "m-dwayne-old",
				threadId: "t-dwayne",
				internalDate: threeDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "dwayne@example.com" },
						{ name: "Subject", value: "Dwayne #3403 payout" },
					],
				},
			},
		},
		// 3) not_proven_duplicate: checked sent mail, nothing matching
		"r-legit": {
			id: "r-legit",
			message: {
				id: "m-legit",
				threadId: "t-legit",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "client@example.com" },
						{ name: "Subject", value: "Estate appraisal follow-up | Phase 2" },
					],
				},
			},
		},
		// 4a) needs_human_decision: missing recipients
		"r-missing-to": {
			id: "r-missing-to",
			message: {
				id: "m-missing-to",
				threadId: "t-missing-to",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [{ name: "Subject", value: "Scratch note" }],
				},
			},
		},
		// 4b) needs_human_decision: ambiguous subject-only sent match (different recipient)
		"r-ambiguous-subj": {
			id: "r-ambiguous-subj",
			message: {
				id: "m-ambig",
				threadId: "t-ambig",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "buyer-b@example.com" },
						{ name: "Subject", value: "Auction Pickup Instructions" },
					],
				},
			},
		},
		// 4c) needs_human_decision: earlier SENT in same thread followed by a newer inbound reply
		"r-earlier-thread-sent": {
			id: "r-earlier-thread-sent",
			message: {
				id: "m-reply-draft",
				threadId: "t-back-and-forth",
				internalDate: twoDaysAgo,
				labelIds: ["DRAFT"],
				payload: {
					headers: [
						{ name: "To", value: "broker@example.com" },
						{ name: "Subject", value: "Re: Cyber Insurance Renewal" },
					],
				},
			},
		},
	};

	const threadsById = {
		"t-fhl-draft": {
			id: "t-fhl-draft",
			messages: [{ id: "m-fhl-draft", threadId: "t-fhl-draft", labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
		},
		"t-dwayne": {
			id: "t-dwayne",
			messages: [
				{ id: "m-dwayne-old", threadId: "t-dwayne", labelIds: ["DRAFT"], internalDate: threeDaysAgo },
				{
					id: "19dd57c6fe93d851",
					threadId: "t-dwayne",
					labelIds: ["SENT"],
					internalDate: String(NOW_MS - 1.5 * DAY_MS),
					payload: {
						headers: [
							{ name: "To", value: "dwayne@example.com" },
							{ name: "Subject", value: "Dwayne #3403 payout" },
						],
					},
				},
				{ id: "m-dwayne-new", threadId: "t-dwayne", labelIds: ["DRAFT"], internalDate: twoDaysAgo },
			],
		},
		"t-legit": {
			id: "t-legit",
			messages: [{ id: "m-legit", threadId: "t-legit", labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
		},
		"t-missing-to": {
			id: "t-missing-to",
			messages: [{ id: "m-missing-to", threadId: "t-missing-to", labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
		},
		"t-ambig": {
			id: "t-ambig",
			messages: [{ id: "m-ambig", threadId: "t-ambig", labelIds: ["DRAFT"], internalDate: twoDaysAgo }],
		},
		"t-back-and-forth": {
			id: "t-back-and-forth",
			messages: [
				{
					id: "m-sent-day5",
					threadId: "t-back-and-forth",
					labelIds: ["SENT"],
					internalDate: String(NOW_MS - 5 * DAY_MS),
					payload: {
						headers: [
							{ name: "To", value: "broker@example.com" },
							{ name: "Subject", value: "Cyber Insurance Renewal" },
						],
					},
				},
				{
					id: "m-inbound-day3",
					threadId: "t-back-and-forth",
					labelIds: ["INBOX"],
					internalDate: threeDaysAgo,
					payload: {
						headers: [
							{ name: "From", value: "broker@example.com" },
							{ name: "Subject", value: "Re: Cyber Insurance Renewal" },
						],
					},
				},
				{
					id: "m-reply-draft",
					threadId: "t-back-and-forth",
					labelIds: ["DRAFT"],
					internalDate: twoDaysAgo,
				},
			],
		},
	};

	const messagesById = {
		"19dd5772aff9ec5f": {
			id: "19dd5772aff9ec5f",
			threadId: "t-fhl-sent-separate",
			labelIds: ["SENT"],
			internalDate: String(NOW_MS - 1.5 * DAY_MS),
			payload: {
				headers: [
					{ name: "To", value: "caleb@example.com" },
					{ name: "Subject", value: "FHL1145/SUN76 Settlement" },
				],
			},
		},
		"m-sent-other-buyer": {
			id: "m-sent-other-buyer",
			threadId: "t-other-buyer",
			labelIds: ["SENT"],
			internalDate: String(NOW_MS - 1.5 * DAY_MS),
			payload: {
				headers: [
					{ name: "To", value: "buyer-a@example.com" },
					{ name: "Subject", value: "Auction Pickup Instructions" },
				],
			},
		},
	};

	const sentSearch = (q) => {
		if (q.includes("fhl1145/sun76 settlement")) {
			return [{ id: "19dd5772aff9ec5f" }];
		}
		if (q.includes("auction pickup instructions")) {
			return [{ id: "m-sent-other-buyer" }];
		}
		return [];
	};

	const { gmail, readCalls } = makeFakeGmail({ draftsList, draftsById, threadsById, sentSearch, messagesById });
	const service = new GmailService();
	service.gmailClients.set("will@mclemoreauction.com", gmail);

	const result = await service.auditDrafts("will@mclemoreauction.com", {
		olderThan: "1d",
		checkSent: true,
		nowMs: NOW_MS,
	});

	assert.equal(result.read_only, true);
	assert.equal(result.check_sent, true);
	assert.equal(result.older_than, "1d");
	assert.match(result.verification_note, /gmcli thread/i);

	// Fresh draft (2h old) must be filtered out; 7 stale drafts remain.
	assert.equal(result.drafts.length, 7);
	assert.equal(
		result.drafts.find((d) => d.draft_id === "r-fresh"),
		undefined,
	);

	const byId = new Map(result.drafts.map((d) => [d.draft_id, d]));

	// likely_duplicate_sent via subject + recipient + attachment metadata
	const fhl = byId.get("r-fhl-dup");
	assert.equal(fhl.disposition, "likely_duplicate_sent");
	assert.deepEqual(fhl.attachments, [
		{ filename: "FHL1145_Statement.pdf", size: 25600, mime_type: "application/pdf" },
	]);
	assert.equal(fhl.sent_candidates.length, 1);
	assert.equal(fhl.sent_candidates[0].message_id, "19dd5772aff9ec5f");
	assert.equal(fhl.sent_candidates[0].match_kind, "subject_and_recipient");

	// Dwayne pair: newer is likely_duplicate_sent (same_thread_sent), older is conflicting_obsolete_candidate
	const dwayneNew = byId.get("r-dwayne-newer");
	assert.equal(dwayneNew.disposition, "likely_duplicate_sent");
	assert.equal(dwayneNew.sent_candidates[0].message_id, "19dd57c6fe93d851");
	assert.equal(dwayneNew.sent_candidates[0].match_kind, "same_thread_sent");
	assert.deepEqual(dwayneNew.conflict_draft_ids, ["r-dwayne-older"]);

	const dwayneOld = byId.get("r-dwayne-older");
	assert.equal(dwayneOld.disposition, "conflicting_obsolete_candidate");
	assert.deepEqual(dwayneOld.conflict_draft_ids, ["r-dwayne-newer"]);

	// not_proven_duplicate
	const legit = byId.get("r-legit");
	assert.equal(legit.disposition, "not_proven_duplicate");
	assert.equal(legit.sent_candidates.length, 0);

	// needs_human_decision variants
	assert.equal(byId.get("r-missing-to").disposition, "needs_human_decision");
	assert.match(byId.get("r-missing-to").reason, /Missing recipients/i);

	assert.equal(byId.get("r-ambiguous-subj").disposition, "needs_human_decision");
	assert.equal(byId.get("r-ambiguous-subj").sent_candidates[0].match_kind, "subject_only");

	assert.equal(byId.get("r-earlier-thread-sent").disposition, "needs_human_decision");
	assert.equal(byId.get("r-earlier-thread-sent").sent_candidates[0].match_kind, "same_thread_earlier_sent");

	// Summary counts
	assert.deepEqual(result.summary, {
		total: 7,
		likely_duplicate_sent: 2,
		conflicting_obsolete_candidate: 1,
		not_proven_duplicate: 1,
		needs_human_decision: 3,
	});

	// Verify strictly read-only Gmail API methods were invoked
	const allowedMethods = new Set(["drafts.list", "drafts.get", "threads.get", "messages.list", "messages.get"]);
	assert.ok(readCalls.length > 0);
	for (const call of readCalls) {
		assert.ok(allowedMethods.has(call.method), `Unexpected method: ${call.method}`);
	}

	// Markdown rendering check (Gavel task note friendly, escapes pipe in subject, shows attachment size & sent ID)
	const md = formatDraftAuditMarkdown(result);
	assert.match(md, /### Stale Draft Audit \(will@mclemoreauction\.com\)/);
	assert.match(md, /\| Disposition \| Draft ID \| Message ID \| Thread ID \| Date \| Recipients \| Subject \| Attachments \| Sent Evidence \| Notes \|/);
	assert.match(md, /FHL1145_Statement\.pdf \(25\.0 KB\)/);
	assert.match(md, /`19dd5772aff9ec5f`/);
	assert.match(md, /`conflicting_obsolete_candidate`/);
	assert.match(md, /Estate appraisal follow-up \\\| Phase 2/);
	assert.match(md, /gmcli thread/);

	// Table (TSV) rendering check
	const tsv = formatDraftAuditTable(result);
	assert.match(tsv, /^DISPOSITION\tDRAFT_ID\tMESSAGE_ID\tTHREAD_ID\tDATE\tRECIPIENTS\tSUBJECT\tATTACHMENTS\tSENT_EVIDENCE\tNOTES/m);
	assert.match(tsv, /likely_duplicate_sent\tr-fhl-dup\tm-fhl-draft\tt-fhl-draft/);

	// JSON serialization check (clean round-trip)
	const jsonRoundTrip = JSON.parse(JSON.stringify({ ok: true, ...result }));
	assert.equal(jsonRoundTrip.ok, true);
	assert.equal(jsonRoundTrip.summary.total, 7);
	assert.equal(jsonRoundTrip.drafts.length, 7);
});

test("auditDrafts without --check-sent marks single drafts as needs_human_decision and skips sent lookups", async () => {
	const twoDaysAgo = String(NOW_MS - 2 * DAY_MS);
	const { gmail, readCalls } = makeFakeGmail({
		draftsList: [{ id: "r-only" }],
		draftsById: {
			"r-only": {
				id: "r-only",
				message: {
					id: "m-only",
					threadId: "t-only",
					internalDate: twoDaysAgo,
					labelIds: ["DRAFT"],
					payload: {
						headers: [
							{ name: "To", value: "alice@example.com" },
							{ name: "Subject", value: "Follow-up" },
						],
					},
				},
			},
		},
	});

	const service = new GmailService();
	service.gmailClients.set("will@mclemoreauction.com", gmail);

	const result = await service.auditDrafts("will@mclemoreauction.com", {
		olderThan: "1d",
		checkSent: false,
		nowMs: NOW_MS,
	});

	assert.equal(result.check_sent, false);
	assert.equal(result.drafts.length, 1);
	assert.equal(result.drafts[0].disposition, "needs_human_decision");
	assert.match(result.drafts[0].reason, /--check-sent/);
	assert.deepEqual(
		readCalls.map((c) => c.method),
		["drafts.list", "drafts.get"],
	);
});

test("formatDraftAuditMarkdown handles empty audit cleanly", () => {
	const md = formatDraftAuditMarkdown({
		account: "will@mclemoreauction.com",
		older_than: "1d",
		check_sent: true,
		read_only: true,
		verification_note: "Note: gmcli thread alone is not sufficient.",
		summary: {
			total: 0,
			likely_duplicate_sent: 0,
			conflicting_obsolete_candidate: 0,
			not_proven_duplicate: 0,
			needs_human_decision: 0,
		},
		drafts: [],
	});
	assert.match(md, /No stale drafts found\./);
	assert.equal(formatDraftAuditTable({
		account: "will@mclemoreauction.com",
		older_than: "1d",
		check_sent: true,
		read_only: true,
		verification_note: "Note",
		summary: {
			total: 0,
			likely_duplicate_sent: 0,
			conflicting_obsolete_candidate: 0,
			not_proven_duplicate: 0,
			needs_human_decision: 0,
		},
		drafts: [],
	}), "No stale drafts");
});

test("CLI --help documents drafts audit, short aliases, and thread verification caveat", () => {
	const output = execFileSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
	assert.match(output, /drafts audit \[--older-than 1d\] \[--check-sent\]/);
	assert.match(output, /drafts audit: --max\/-m/);
	assert.match(output, /gmcli thread.*not sufficient send verification/i);
});
