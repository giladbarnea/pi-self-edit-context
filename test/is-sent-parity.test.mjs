import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("isSent agrees with Pi's own transformMessages on every block shape, on the installed Pi", () => {
	// index.ts cannot import transformMessages, which Pi does not serve to extensions, so it mirrors the rule; this catches drift.
	const directory = mkdtempSync(join(tmpdir(), "self-edit-parity-"));
	const parityFile = join(directory, "parity.json");
	const run = spawnSync(
		join(root, "node_modules/.bin/pi"),
		["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp", "-e", join(root, "test/fixtures/is-sent-parity.ts")],
		{ cwd: directory, encoding: "utf8", input: '{"id":"state","type":"get_state"}\n', env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PARITY_FILE: parityFile }, timeout: 60_000 },
	);
	assert.equal(run.status, 0, `Pi should start: ${run.stderr}`);
	const { cases, differences } = JSON.parse(readFileSync(parityFile, "utf8"));
	assert.equal(cases, 240);
	assert.deepEqual(differences, [], "isSent and Pi's transformMessages disagree");
});
