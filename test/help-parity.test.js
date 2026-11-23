import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliSourcePath = path.join(repoRoot, "src", "cli.ts");
const cliDistPath = path.join(repoRoot, "dist", "cli.js");

function findMatchingBrace(source, openBraceIndex) {
	let depth = 0;
	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error(`Unclosed brace starting at index ${openBraceIndex}`);
}

function extractParseArgsShortOptions(source) {
	const results = [];
	const parseArgsRe = /\bparseArgs\s*\(\s*\{/g;
	let match;

	while ((match = parseArgsRe.exec(source)) !== null) {
		const callObjStart = source.indexOf("{", match.index);
		const callObjEnd = findMatchingBrace(source, callObjStart);
		const callBody = source.slice(callObjStart + 1, callObjEnd);

		const optionsMatch = /\boptions\s*:\s*\{/.exec(callBody);
		if (!optionsMatch) continue;

		const optionsObjStart = callBody.indexOf("{", optionsMatch.index);
		const optionsObjEnd = findMatchingBrace(callBody, optionsObjStart);
		const optionsBody = callBody.slice(optionsObjStart + 1, optionsObjEnd);

		const optionEntryRe = /(?:["']([^"']+)["']|([A-Za-z0-9_-]+))\s*:\s*\{([^}]*)\}/g;
		let entryMatch;
		while ((entryMatch = optionEntryRe.exec(optionsBody)) !== null) {
			const longName = entryMatch[1] || entryMatch[2];
			const descriptor = entryMatch[3];
			const shortMatch = /\bshort\s*:\s*["']([^"']+)["']/.exec(descriptor);
			if (shortMatch) {
				results.push({ longName, shortFlag: shortMatch[1] });
			}
		}
	}

	return results;
}

function runCli(args, envOverrides = {}) {
	return spawnSync(process.execPath, [cliDistPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...envOverrides },
	});
}

test("every parseArgs short alias in src/cli.ts is documented in --help output", () => {
	const source = fs.readFileSync(cliSourcePath, "utf8");
	const shortOptions = extractParseArgsShortOptions(source);

	assert.ok(shortOptions.length >= 4, `Expected at least 4 parseArgs short options, found ${shortOptions.length}`);

	const help = runCli(["--help"]);
	assert.equal(help.status, 0, `Expected --help to exit 0, got ${help.status}\nstderr: ${help.stderr}`);
	assert.match(help.stdout, /gmcli - Gmail CLI/);

	for (const { longName, shortFlag } of shortOptions) {
		const shortRe = new RegExp(`(?:^|[\\s|,/\\[])-${shortFlag}(?=[\\s|,\\]/]|$)`);
		const longRe = new RegExp(`--${longName}\\b`);
		assert.match(
			help.stdout,
			shortRe,
			`Missing short alias -${shortFlag} (for --${longName}) in gmcli --help output`,
		);
		assert.match(help.stdout, longRe, `Missing long option --${longName} in gmcli --help output`);
	}
});

test("dist/cli.js --help and -h exit 0 and list documented short aliases", () => {
	for (const flag of ["--help", "-h"]) {
		const res = runCli([flag]);
		assert.equal(res.status, 0, `Expected ${flag} to exit 0, got ${res.status}`);
		for (const alias of ["-m", "-p", "-a", "-r"]) {
			assert.ok(res.stdout.includes(alias), `Expected ${flag} output to include ${alias}`);
		}
	}
});

test("argument parsing accepts documented short aliases cleanly before account lookup", () => {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-help-parity-"));
	const fakeAccount = "missing-account@example.invalid";

	try {
		const validCases = [
			["search", "in:inbox", "-m", "5"],
			["search", "in:inbox", "-p", "page-token-123"],
			["search", "in:inbox", "-m", "5", "-p", "page-token-123"],
			["labels", "thread123", "-a", "Work"],
			["labels", "thread123", "-r", "UNREAD"],
			["labels", "thread123", "-a", "Work", "-r", "UNREAD"],
		];

		for (const cmdArgs of validCases) {
			const res = runCli([fakeAccount, ...cmdArgs], { HOME: fakeHome });
			assert.equal(res.status, 1, `Expected missing account failure for: ${cmdArgs.join(" ")}`);
			assert.match(
				res.stderr,
				new RegExp(`Account '${fakeAccount}' not found`),
				`Expected account-lookup error (not arg-parse error) for: ${cmdArgs.join(" ")}\nstderr: ${res.stderr}`,
			);
			assert.doesNotMatch(res.stderr, /Unknown option/i);
		}

		const invalidRes = runCli([fakeAccount, "search", "in:inbox", "-z"], { HOME: fakeHome });
		assert.equal(invalidRes.status, 1);
		assert.match(invalidRes.stderr, /Unknown option '-z'/);
	} finally {
		fs.rmSync(fakeHome, { recursive: true, force: true });
	}
});
