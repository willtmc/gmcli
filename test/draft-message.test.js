import test from "node:test";
import assert from "node:assert/strict";
import { isDraftMessage } from "../dist/gmail-service.js";

test("isDraftMessage identifies Gmail draft messages by DRAFT label", () => {
	assert.equal(isDraftMessage({ labelIds: ["INBOX", "DRAFT"] }), true);
	assert.equal(isDraftMessage({ labelIds: ["SENT"] }), false);
	assert.equal(isDraftMessage({ labelIds: [] }), false);
	assert.equal(isDraftMessage(null), false);
});
