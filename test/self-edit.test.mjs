import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

/** Run a real `pi -p` whose model is a scripted stand-in; return what the model saw and the session file. */
function runAgent(script, prompt) {
	const directory = mkdtempSync(join(tmpdir(), "self-edit-"));
	const log = join(directory, "contexts.jsonl");
	execFileSync(
		"pi",
		["-p", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp",
			"-e", join(root, "index.ts"), "-e", join(root, "test/fixtures/scripted-model.ts"),
			"--model", "scripted/agent", "--session-dir", directory, prompt],
		{ cwd: directory, env: { ...process.env, SCRIPTED_MODEL_SCRIPT: script, SCRIPTED_MODEL_LOG: log }, stdio: "pipe" },
	);
	const sessionFile = readdirSync(directory).find((name) => name.endsWith(".jsonl") && name !== "contexts.jsonl");
	const contexts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const entries = readFileSync(join(directory, sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { contextAfterEdit: contexts.at(-1), entries };
}

const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));

test("an edit the agent makes applies to its very next request in the same run", () => {
	const { contextAfterEdit, entries } = runAgent("pirate-first-request", "ORIGINAL-REQUEST: summarize the repo");
	const firstUser = contextAfterEdit.find((message) => message.role === "user");
	assert.equal(textOf(firstUser), "Arr, PIRATE-REQUEST, matey", `model saw: ${textOf(firstUser)}`);
	// The outline's own tool result quotes the original line, so check the user messages only.
	const userTexts = contextAfterEdit.filter((message) => message.role === "user").map(textOf);
	assert.ok(!userTexts.some((text) => text.includes("ORIGINAL-REQUEST")), `original user text still reached the model: ${userTexts}`);
	const storedUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.match(textOf(storedUser.message), /ORIGINAL-REQUEST/, "the stored original must stay intact");
	assert.ok(entries.some((entry) => entry.type === "context_edit" && entry.targetId === storedUser.id), "no context_edit entry was persisted");
});

test("the outline gives a total and pairs each tool result with the entry holding its call", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	// The second outline call sees the first call and its result.
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries/.test(text)).at(-1);
	assert.match(outline, /^\d+ entries, ~\d+ tokens total/, `outline header: ${outline.split("\n")[0]}`);
	const callEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	assert.ok(outline, "no outline result reached the model");
	const resultLine = outline.split("\n").find((line) => line.includes(" toolResult "));
	assert.ok(resultLine?.includes(`answers ${callEntry.id}`), `result line should name call entry ${callEntry.id}: ${resultLine}`);
});

test("a dry run reports the outcome without changing the context", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a dry run persisted an edit");
	const report = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(report.isError, false);
	assert.match(textOf(report), /dry run/i, `report: ${textOf(report)}`);
	assert.match(textOf(contextAfterEdit.find((message) => message.role === "user")), /ORIGINAL-REQUEST/);
});

test("an edit that would separate tool calls from their results is refused and changes nothing", () => {
	const { contextAfterEdit, entries } = runAgent("orphan-tool-results", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a broken edit was persisted");
	const refusal = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(refusal.isError, true, `edit_context should report an error, got: ${textOf(refusal)}`);
	assert.match(textOf(refusal), /tool result/i);
});
