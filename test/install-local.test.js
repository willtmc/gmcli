import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "install-local.sh");

test("package.json defines canonical install-local script", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	assert.equal(pkg.scripts["install-local"], "bash scripts/install-local.sh");
});

test("scripts/install-local.sh is executable and passes bash -n syntax check", () => {
	const stat = fs.statSync(scriptPath);
	assert.notEqual(stat.mode & 0o111, 0, "scripts/install-local.sh must be executable");
	execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" });
});

test("scripts/install-local.sh runs build + global install and fails when PATH gmcli is stale", (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-install-local-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const logFile = path.join(tmpDir, "npm-calls.log");
	const mockNpm = path.join(tmpDir, "npm");
	fs.writeFileSync(
		mockNpm,
		`#!/usr/bin/env bash\necho "$*" >> "${logFile}"\nexit 0\n`,
		{ mode: 0o755 },
	);

	// 1. Stale gmcli on PATH should fail verification.
	const staleBin = path.join(tmpDir, "gmcli");
	fs.writeFileSync(staleBin, "#!/usr/bin/env bash\necho 'stale help'\nexit 1\n", { mode: 0o755 });

	const staleRun = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	assert.notEqual(staleRun.status, 0, "expected non-zero exit when PATH gmcli is stale");
	assert.match(staleRun.stderr, /does not match newly built dist\/cli\.js/);

	const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
	assert.deepEqual(calls, ["run build", "install -g ."]);

	// 2. Fresh gmcli symlink pointing to dist/cli.js should pass verification.
	fs.unlinkSync(staleBin);
	fs.symlinkSync(path.join(repoRoot, "dist", "cli.js"), staleBin);

	const freshRun = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	assert.equal(freshRun.status, 0, `expected exit 0 when PATH gmcli matches dist/cli.js; stderr: ${freshRun.stderr}`);
	assert.match(freshRun.stdout, /Verified .* matches .*dist\/cli\.js/);
});
