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

test("scripts/install-local.sh verifies npm global binary and tolerates PATH wrapper", (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcli-install-local-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const npmPrefix = path.join(tmpDir, "npm-prefix");
	const npmBinDir = path.join(npmPrefix, "bin");
	const wrapperDir = path.join(tmpDir, "wrapper-bin");
	const toolsDir = path.join(tmpDir, "tools");
	fs.mkdirSync(npmBinDir, { recursive: true });
	fs.mkdirSync(wrapperDir, { recursive: true });
	fs.mkdirSync(toolsDir, { recursive: true });

	const logFile = path.join(tmpDir, "npm-calls.log");
	const mockNpm = path.join(toolsDir, "npm");
	fs.writeFileSync(
		mockNpm,
		`#!/usr/bin/env bash
echo "$*" >> "${logFile}"
if [[ "$*" == "prefix -g" ]]; then
	echo "${npmPrefix}"
fi
exit 0
`,
		{ mode: 0o755 },
	);

	// 1. Stale npm global gmcli binary should fail verification.
	const npmGmcli = path.join(npmBinDir, "gmcli");
	fs.writeFileSync(npmGmcli, "#!/usr/bin/env bash\necho 'stale help'\nexit 1\n", { mode: 0o755 });

	const staleRun = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${toolsDir}:${npmBinDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	assert.notEqual(staleRun.status, 0, "expected non-zero exit when npm global gmcli is stale");
	assert.match(staleRun.stderr, /does not match newly built dist\/cli\.js/);

	const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
	assert.deepEqual(calls, ["run build", "install -g .", "prefix -g"]);

	// 2. Fresh npm global gmcli symlink pointing to dist/cli.js should pass verification.
	fs.unlinkSync(npmGmcli);
	fs.symlinkSync(path.join(repoRoot, "dist", "cli.js"), npmGmcli);

	const freshRun = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${toolsDir}:${npmBinDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	assert.equal(freshRun.status, 0, `expected exit 0 when npm global gmcli matches dist/cli.js; stderr: ${freshRun.stderr}`);
	assert.match(freshRun.stdout, /Verified .* matches .*dist\/cli\.js/);
	assert.doesNotMatch(freshRun.stdout, /Note: PATH resolves gmcli to/);

	// 3. PATH wrapper (e.g. Doppler shim) shadowing npm global binary should pass without executing wrapper.
	const wrapperBin = path.join(wrapperDir, "gmcli");
	fs.writeFileSync(
		wrapperBin,
		"#!/usr/bin/env bash\necho 'wrapper should not be invoked' >&2\nexit 99\n",
		{ mode: 0o755 },
	);

	const wrapperRun = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${toolsDir}:${wrapperDir}:${npmBinDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	assert.equal(
		wrapperRun.status,
		0,
		`expected exit 0 when PATH resolves to wrapper and npm global gmcli matches dist/cli.js; stderr: ${wrapperRun.stderr}`,
	);
	assert.match(wrapperRun.stdout, /Note: PATH resolves gmcli to .* \(wrapper\); verified npm global binary at /);
	assert.match(wrapperRun.stdout, /Verified .* matches .*dist\/cli\.js/);
});
