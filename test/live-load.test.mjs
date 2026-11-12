import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

/**
 * The package as users get it: the tarball `npm pack` builds, outside this checkout, so no node_modules is in reach and
 * every import must resolve through Pi's extension loader alone.
 */
function packedTarball(directory) {
	const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }));
	return join(directory, filename);
}

/** Start a real `pi --mode rpc --no-session` on an agent directory with these settings; return its exit, output and tool names. */
function startPi(directory, settings) {
	const agent = join(directory, "agent");
	const toolsFile = join(directory, "tools.json");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	const run = spawnSync(
		join(root, "node_modules/.bin/pi"),
		["--mode", "rpc", "--no-session", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp", "-e", join(root, "test/fixtures/list-tools.ts")],
		{ cwd: directory, encoding: "utf8", input: '{"id":"state","type":"get_state"}\n', env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agent, LIST_TOOLS_FILE: toolsFile }, timeout: 60_000 },
	);
	const output = `exit ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`;
	return { run, output, tools: () => JSON.parse(readFileSync(toolsFile, "utf8")) };
}

function assertLoaded({ run, output, tools }) {
	assert.equal(run.status, 0, `Pi should start with the extension loaded:\n${output}`);
	assert.ok(!/Failed to load extension|Cannot find module/.test(output), `the extension should load:\n${output}`);
	assert.match(run.stdout, /"command":"get_state","success":true/, `Pi should answer an RPC command:\n${output}`);
	for (const tool of ["context_outline", "edit_context"]) assert.ok(tools().includes(tool), `Pi should list ${tool}: ${tools()}`);
}

// Issue 7, reopened: an import that only dev dependencies resolve passes every other test and breaks every Pi start.
test("a real Pi start loads the packed extension from a local path in settings, with no node_modules in reach", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-edit-live-load-"));
	execFileSync("tar", ["-xzf", packedTarball(directory), "-C", directory]);
	assertLoaded(startPi(directory, { packages: [join(directory, "package")] }));
});

test("a real Pi start loads the extension as Pi's Git install leaves it, with dependencies installed but no dev or peer dependencies", () => {
	// The package is not on the npm registry; the README installs it from Git. Pi's Git install clones the repository and
	// runs `npm install --omit=dev --legacy-peer-deps` in it, so pi-ai and pi-coding-agent are left to Pi's own loader.
	const directory = mkdtempSync(join(tmpdir(), "self-edit-live-load-"));
	const clone = join(directory, "clone");
	mkdirSync(clone);
	// The clone's files are what Git tracks here, so the package root must be its own Git work tree, as in CI and a real install.
	const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).stdout.trim();
	assert.equal(realpathSync(toplevel || "."), realpathSync(root), `this test needs the package root ${root} to be the top of its own Git work tree; git rev-parse --show-toplevel gave "${toplevel}". Run it in a Git clone of the package, not in an export inside another repository.`);
	const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
	for (const file of files) cpSync(join(root, file), join(clone, file));
	execFileSync("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: clone, stdio: "pipe" });
	assertLoaded(startPi(directory, { packages: [clone] }));
});
