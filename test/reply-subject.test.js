import test from "node:test";
import assert from "node:assert/strict";
import {
	GmailService,
	canonicalReplySubject,
	normalizeSubjectForThreadComparison,
} from "../dist/gmail-service.js";

function decodeRaw(raw) {
	return Buffer.from(raw, "base64url").toString();
}

test("normalizeSubjectForThreadComparison ignores reply/forward prefixes, case, and whitespace", () => {
	assert.equal(
		normalizeSubjectForThreadComparison("Re: FW: LeRoy Jeffery Thomas; 26-01103 - ISSUES"),
		normalizeSubjectForThreadComparison("RE:   fw:   leroy jeffery thomas; 26-01103 - issues"),
	);
});

test("canonicalReplySubject uses source thread spelling for equivalent reply subjects", () => {
	assert.equal(
		canonicalReplySubject(
			"Re: FW: LeRoy Jeffery Thomas, Jr & Taneshia Stacey-Ann Thomas; 26-01103 - ISSUES WITH JEEP WRANGLERS",
			"RE: FW: LeRoy Jeffery Thomas, Jr & Taneshia Stacey-Ann Thomas; 26-01103 - ISSUES WITH JEEP WRANGLERS",
		),
		"RE: FW: LeRoy Jeffery Thomas, Jr & Taneshia Stacey-Ann Thomas; 26-01103 - ISSUES WITH JEEP WRANGLERS",
	);
});

test("canonicalReplySubject does not rewrite materially different subjects", () => {
	assert.equal(
		canonicalReplySubject("New topic", "RE: FW: LeRoy Jeffery Thomas; 26-01103 - ISSUES"),
		"New topic",
	);
});

test("createDraft canonicalizes reply subject before sending raw payload to Gmail", async () => {
	const created = [];
	const fakeGmail = {
		users: {
			messages: {
				get: async ({ id, format, metadataHeaders }) => {
					if (format === "minimal") return { data: { id, threadId: "thread-1" } };
					assert.deepEqual(metadataHeaders, ["Message-ID", "References", "Subject"]);
					return {
						data: {
							threadId: "thread-1",
							payload: {
								headers: [
									{ name: "Message-ID", value: "<source@example.com>" },
									{ name: "Subject", value: "RE: FW: Canonical Subject" },
								],
							},
						},
					};
				},
			},
			drafts: {
				create: async ({ requestBody }) => {
					created.push(requestBody.message);
					return { data: { id: "draft-1", message: requestBody.message } };
				},
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("will@example.com", fakeGmail);

	await service.createDraft("will@example.com", ["to@example.com"], "Re: Fw: Canonical Subject", "Body", {
		replyToMessageId: "message-1",
	});

	assert.equal(created.length, 1);
	assert.match(decodeRaw(created[0].raw), /^Subject: RE: FW: Canonical Subject\r?$/m);
	assert.equal(created[0].threadId, "thread-1");
});
