import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;

/**
 * Run a real `pi -p` whose model is a scripted stand-in; return each context the model recorded and the session file.
 * `model` is "provider/id"; `session` is an existing session file to open instead of starting a new one.
 */
export function runAgent(script, prompt, extraEnvironment = {}, { model = "scripted/agent", session } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "self-edit-"));
	const log = join(directory, "contexts.jsonl");
	execFileSync(
		join(root, "node_modules/.bin/pi"),
		["-p", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp",
			"-e", join(root, "index.ts"), "-e", join(root, "test/fixtures/scripted-model.ts"),
			"--model", model, "--session-dir", directory, ...(session ? ["--session", session] : []), prompt],
		{ cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), SCRIPTED_MODEL_SCRIPT: script, SCRIPTED_MODEL_LOG: log, ...extraEnvironment }, stdio: "pipe", timeout: 60_000 },
	);
	const sessionFile = session ?? join(directory, readdirSync(directory).find((name) => name.endsWith(".jsonl") && name !== "contexts.jsonl"));
	const contexts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { contexts, contextAfterEdit: contexts.at(-1), entries, sessionFile };
}

