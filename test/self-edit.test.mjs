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

test("the outline nests an assistant's blocks under it and each tool result under its call", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	// The second outline call sees the first, two-call assistant entry and both of its results.
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries/.test(text)).at(-1);
	assert.ok(outline, "no outline result reached the model");
	assert.match(outline, /^\d+ entries, ~[\d.]+k? tokens total/, `outline header: ${outline.split("\n")[0]}`);
	const callEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	const resultIds = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").map((entry) => entry.id);
	const lines = outline.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`- ${callEntry.id} assistant`));
	const expected = [
		/^  - thinking, ~1\.0k tokens$/,
		/^  - call, ~\d+ tokens: context_outline\(\{\}\)$/,
		new RegExp(`^    - ${resultIds[0]} result, `),
		/^  - call, ~\d+ tokens: context_outline\(\{\}\)$/,
		new RegExp(`^    - ${resultIds[1]} result, `),
	];
	const block = lines.slice(start + 1, start + 1 + expected.length);
	expected.forEach((pattern, index) => assert.match(block[index] ?? "", pattern, `line ${index + 1} under the assistant:\n${block.join("\n")}`));
	assert.equal(lines.filter((line) => line.includes(" result")).length, 2, "each result should appear once, nested under its call");
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
