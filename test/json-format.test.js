import test from "node:test";
import assert from "node:assert/strict";
import { consumeJsonFlag, parseMailbox, parseMailboxList } from "../dist/json-format.js";

test("parseMailbox reads name and address", () => {
	assert.deepEqual(parseMailbox("Bob Mendes <bob@example.com>"), {
		name: "Bob Mendes",
		email: "bob@example.com",
	});
	assert.deepEqual(parseMailbox("bob@example.com"), {
		name: null,
		email: "bob@example.com",
	});
});

test("parseMailboxList splits recipients", () => {
	assert.deepEqual(parseMailboxList("A <a@x.com>, b@y.com"), [
		{ name: "A", email: "a@x.com" },
		{ name: null, email: "b@y.com" },
	]);
});

test("consumeJsonFlag strips --json from anywhere", () => {
	assert.deepEqual(consumeJsonFlag(["search", "--json", "in:inbox"]), {
		json: true,
		args: ["search", "in:inbox"],
	});
	assert.deepEqual(consumeJsonFlag(["search", "in:inbox"]), {
		json: false,
		args: ["search", "in:inbox"],
	});
});
