import assert from "node:assert/strict";
import test from "node:test";
import { GmailService, selectLatestReplyMessage } from "../dist/gmail-service.js";

function decodeRaw(raw) {
	return Buffer.from(raw, "base64url").toString();
}

test("selectLatestReplyMessage skips trailing DRAFT messages and falls back if all are drafts", () => {
	assert.equal(
		selectLatestReplyMessage([
			{ id: "m1", labelIds: ["INBOX"] },
			{ id: "m2", labelIds: ["SENT"] },
			{ id: "m3", labelIds: ["DRAFT"] },
		])?.id,
		"m2",
	);

	assert.equal(
		selectLatestReplyMessage([
			{ id: "d1", labelIds: ["DRAFT"] },
			{ id: "d2", labelIds: ["DRAFT"] },
		])?.id,
		"d2",
	);

	assert.equal(selectLatestReplyMessage([]), undefined);
});

test("createDraft --reply-to with a threadId that also matches root messageId resolves latest non-draft message", async () => {
	const created = [];
	const messagesById = {
		"19d6851a5e2b7eb3": {
			id: "19d6851a5e2b7eb3",
			threadId: "19d6851a5e2b7eb3",
			labelIds: ["INBOX"],
			payload: {
				headers: [
					{ name: "Message-Id", value: "<root@example.com>" },
					{ name: "Subject", value: "ROOF DOG BEVERAGES LLC" },
				],
			},
		},
		"19d6851a5e2b7eb9": {
			id: "19d6851a5e2b7eb9",
			threadId: "19d6851a5e2b7eb3",
			labelIds: ["SENT"],
			payload: {
				headers: [
					{ name: "Message-Id", value: "<second@example.com>" },
					{ name: "references", value: "<root@example.com>" },
					{ name: "Subject", value: "Re: ROOF DOG BEVERAGES LLC" },
				],
			},
		},
	};

	const fakeGmail = {
		users: {
			messages: {
				get: async ({ id }) => {
					const msg = messagesById[id];
					if (!msg) throw new Error(`404: ${id}`);
					return { data: msg };
				},
			},
			threads: {
				get: async ({ id }) => {
					assert.equal(id, "19d6851a5e2b7eb3");
					return {
						data: {
							id: "19d6851a5e2b7eb3",
							messages: [
								{ id: "19d6851a5e2b7eb3", labelIds: ["INBOX"] },
								{ id: "19d6851a5e2b7eb9", labelIds: ["SENT"] },
								{ id: "19d6851a5e2b7ec0", labelIds: ["DRAFT"] },
							],
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

	await service.createDraft("will@example.com", ["wilson@example.com"], "Re: ROOF DOG BEVERAGES LLC", "Reply body", {
		replyToMessageId: "19d6851a5e2b7eb3",
	});

	assert.equal(created.length, 1);
	assert.equal(created[0].threadId, "19d6851a5e2b7eb3");
	const raw = decodeRaw(created[0].raw);
	assert.match(raw, /^In-Reply-To: <second@example\.com>\r?$/m);
	assert.match(raw, /^References: <root@example\.com> <second@example\.com>\r?$/m);
	assert.match(raw, /^Subject: Re: ROOF DOG BEVERAGES LLC\r?$/m);
});

test("createDraft --reply-to with a threadId whose root message is missing falls back to threads.get", async () => {
	const created = [];
	const fakeGmail = {
		users: {
			messages: {
				get: async ({ id }) => {
					if (id === "thread-only-id") {
						throw new Error("Requested entity was not found.");
					}
					if (id === "msg-latest") {
						return {
							data: {
								id: "msg-latest",
								threadId: "thread-only-id",
								payload: {
									headers: [
										{ name: "message-id", value: "<latest@example.com>" },
										{ name: "References", value: "<first@example.com>" },
										{ name: "Subject", value: "Re: Existing Topic" },
									],
								},
							},
						};
					}
					throw new Error(`Unexpected message id: ${id}`);
				},
			},
			threads: {
				get: async ({ id }) => {
					assert.equal(id, "thread-only-id");
					return {
						data: {
							id: "thread-only-id",
							messages: [
								{ id: "msg-older", labelIds: ["INBOX"] },
								{ id: "msg-latest", labelIds: ["INBOX"] },
							],
						},
					};
				},
			},
			drafts: {
				create: async ({ requestBody }) => {
					created.push(requestBody.message);
					return { data: { id: "draft-2", message: requestBody.message } };
				},
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("will@example.com", fakeGmail);

	await service.createDraft("will@example.com", ["to@example.com"], "Re: Existing Topic", "Body", {
		replyToMessageId: "thread-only-id",
	});

	assert.equal(created.length, 1);
	assert.equal(created[0].threadId, "thread-only-id");
	const raw = decodeRaw(created[0].raw);
	assert.match(raw, /^In-Reply-To: <latest@example\.com>\r?$/m);
	assert.match(raw, /^References: <first@example\.com> <latest@example\.com>\r?$/m);
});

test("createDraft --reply-to with a non-root messageId targets that exact message and sets threadId", async () => {
	const created = [];
	let threadsGetCalled = false;
	const fakeGmail = {
		users: {
			messages: {
				get: async ({ id }) => {
					assert.equal(id, "msg-specific");
					return {
						data: {
							id: "msg-specific",
							threadId: "thread-root",
							payload: {
								headers: [
									{ name: "Message-Id", value: "<specific@example.com>" },
									{ name: "References", value: "<root@example.com> <specific@example.com>" },
									{ name: "Subject", value: "Re: Specific Thread" },
								],
							},
						},
					};
				},
			},
			threads: {
				get: async () => {
					threadsGetCalled = true;
					throw new Error("threads.get should not be called for non-root messageId");
				},
			},
			drafts: {
				create: async ({ requestBody }) => {
					created.push(requestBody.message);
					return { data: { id: "draft-3", message: requestBody.message } };
				},
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("will@example.com", fakeGmail);

	await service.createDraft("will@example.com", ["to@example.com"], "Re: Specific Thread", "Body", {
		replyToMessageId: "msg-specific",
	});

	assert.equal(threadsGetCalled, false);
	assert.equal(created.length, 1);
	assert.equal(created[0].threadId, "thread-root");
	const raw = decodeRaw(created[0].raw);
	assert.match(raw, /^In-Reply-To: <specific@example\.com>\r?$/m);
	assert.match(raw, /^References: <root@example\.com> <specific@example\.com>\r?$/m);
});

test("sendMessage --reply-to with a threadId resolves latest message and sets case-insensitive headers", async () => {
	const sent = [];
	const fakeGmail = {
		users: {
			messages: {
				get: async ({ id }) => {
					if (id === "thread-root-id") {
						return {
							data: {
								id: "thread-root-id",
								threadId: "thread-root-id",
								payload: {
									headers: [{ name: "Message-Id", value: "<root@example.com>" }],
								},
							},
						};
					}
					if (id === "msg-2") {
						return {
							data: {
								id: "msg-2",
								threadId: "thread-root-id",
								payload: {
									headers: [
										{ name: "Message-Id", value: "<msg2@example.com>" },
										{ name: "References", value: "<root@example.com>" },
										{ name: "Subject", value: "Re: Direct Send Thread" },
									],
								},
							},
						};
					}
					throw new Error(`Unexpected message id: ${id}`);
				},
				send: async ({ requestBody }) => {
					sent.push(requestBody);
					return { data: { id: "sent-1", threadId: requestBody.threadId } };
				},
			},
			threads: {
				get: async () => ({
					data: {
						id: "thread-root-id",
						messages: [
							{ id: "thread-root-id", labelIds: ["INBOX"] },
							{ id: "msg-2", labelIds: ["INBOX"] },
						],
					},
				}),
			},
		},
	};

	const service = new GmailService();
	service.gmailClients.set("will@example.com", fakeGmail);

	await service.sendMessage("will@example.com", ["to@example.com"], "Re: Direct Send Thread", "Body", {
		replyToMessageId: "thread-root-id",
	});

	assert.equal(sent.length, 1);
	assert.equal(sent[0].threadId, "thread-root-id");
	const raw = decodeRaw(sent[0].raw);
	assert.match(raw, /^In-Reply-To: <msg2@example\.com>\r?$/m);
	assert.match(raw, /^References: <root@example\.com> <msg2@example\.com>\r?$/m);
});
