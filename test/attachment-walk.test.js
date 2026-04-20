import test from "node:test";
import assert from "node:assert/strict";
import { collectAttachmentParts, hasAttachmentParts } from "../dist/gmail-service.js";

test("collectAttachmentParts finds attachments nested under multipart/related", () => {
	const payload = {
		mimeType: "multipart/mixed",
		parts: [
			{
				mimeType: "multipart/alternative",
				parts: [
					{
						mimeType: "multipart/related",
						parts: [
							{
								mimeType: "text/html",
								body: { data: Buffer.from("<p>hi</p>").toString("base64url") },
							},
							{
								filename: "cert-1.pdf",
								mimeType: "application/pdf",
								body: { attachmentId: "att-1", size: 111 },
							},
							{
								filename: "cert-2.pdf",
								mimeType: "application/pdf",
								body: { attachmentId: "att-2", size: 222 },
							},
						],
					},
				],
			},
		],
	};

	const attachments = collectAttachmentParts(payload);

	assert.equal(attachments.length, 2);
	assert.deepEqual(
		attachments.map((attachment) => ({
			filename: attachment.filename,
			attachmentId: attachment.attachmentId,
			size: attachment.size,
		})),
		[
			{ filename: "cert-1.pdf", attachmentId: "att-1", size: 111 },
			{ filename: "cert-2.pdf", attachmentId: "att-2", size: 222 },
		],
	);
	assert.equal(hasAttachmentParts(payload), true);
});

test("collectAttachmentParts includes inline-style filename parts with embedded data", () => {
	const inlineBytes = Buffer.from("hello inline attachment");
	const payload = {
		mimeType: "multipart/related",
		parts: [
			{
				filename: "logo.png",
				mimeType: "image/png",
				body: {
					data: inlineBytes.toString("base64url"),
					size: inlineBytes.length,
				},
			},
		],
	};

	const [attachment] = collectAttachmentParts(payload);

	assert.ok(attachment);
	assert.equal(attachment.filename, "logo.png");
	assert.equal(attachment.inlineData, inlineBytes.toString("base64url"));
	assert.equal(attachment.attachmentId, undefined);
	assert.equal(attachment.size, inlineBytes.length);
});
