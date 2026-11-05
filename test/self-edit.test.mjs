import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

/** Run a real `pi -p` whose model is a scripted stand-in; return each context the model recorded and the session file. */
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
	return { contexts, contextAfterEdit: contexts.at(-1), entries };
}

const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));
const messageEntries = (entries, role) => entries.filter((entry) => entry.type === "message" && entry.message.role === role);

test("an edit the agent makes applies to its very next request in the same run", () => {
	const { contextAfterEdit, entries } = runAgent("pirate-first-request", "ORIGINAL-REQUEST: summarize the repo");
	const firstUser = contextAfterEdit.find((message) => message.role === "user");
	assert.equal(textOf(firstUser), "Arr, PIRATE-REQUEST, matey", `model saw: ${textOf(firstUser)}`);
	// The outline's own tool result quotes the original line, so check the user messages only.
	const userTexts = contextAfterEdit.filter((message) => message.role === "user").map(textOf);
	assert.ok(!userTexts.some((text) => text.includes("ORIGINAL-REQUEST")), `original user text still reached the model: ${userTexts}`);
	const storedUser = messageEntries(entries, "user")[0];
	assert.match(textOf(storedUser.message), /ORIGINAL-REQUEST/, "the stored original must stay intact");
	assert.ok(entries.some((entry) => entry.type === "context_edit" && entry.targetId === storedUser.id), "no context_edit entry was persisted");
});

test("the outline gives blocks their own IDs and sizes, and nests each tool result under its call", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	// The second outline call sees the first, two-call assistant entry and both of its results.
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries/.test(text)).at(-1);
	assert.ok(outline, "no outline result reached the model");
	assert.match(outline, /^\d+ entries, ~[\d.]+k? tokens total/, `outline header: ${outline.split("\n")[0]}`);
	const callEntry = messageEntries(entries, "assistant")[0];
	const resultIds = messageEntries(entries, "toolResult").map((entry) => entry.id);
	const lines = outline.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`- ${callEntry.id} assistant`));
	// 400 characters of thinking plus a 3,600-character signature is ~1.0k tokens, and the entry total must include it.
	const expected = [
		new RegExp(`^- ${callEntry.id} assistant, .*, ~1\\.0k tokens$`),
		new RegExp(`^  - ${callEntry.id}\\.t0 thinking, ~1\\.0k tokens, signed$`),
		new RegExp(`^  - ${callEntry.id}\\.c0 call, ~\\d+ tokens: context_outline\\(\\{\\}\\)$`),
		new RegExp(`^    - ${resultIds[0]} result, `),
		new RegExp(`^  - ${callEntry.id}\\.c1 call, ~\\d+ tokens: context_outline\\(\\{\\}\\)$`),
		new RegExp(`^    - ${resultIds[1]} result, `),
	];
	const block = lines.slice(start, start + expected.length);
	expected.forEach((pattern, index) => assert.match(block[index] ?? "", pattern, `line ${index + 1} of the assistant block:\n${block.join("\n")}`));
	assert.equal(lines.filter((line) => line.includes(" result")).length, 2, "each result should appear once, nested under its call");
});

test("a dry run reports the effect without changing the context", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a dry run persisted an edit");
	const report = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(report.isError, false);
	for (const fact of [/Dry run, nothing applied/, /Frees ~[\d.]+k? tokens/, /Earliest change: \w+, entry \d+ of \d+; ~[\d.]+k? tokens from there on/, /Every tool call still has its result/, /"apply": "plan-\d+"/]) {
		assert.match(textOf(report), fact, `report: ${textOf(report)}`);
	}
	assert.match(textOf(contextAfterEdit.find((message) => message.role === "user")), /ORIGINAL-REQUEST/);
});

test("applying a dry-run plan by its ID commits exactly that plan", () => {
	const { contexts, contextAfterEdit, entries } = runAgent("dry-run-then-apply", "ORIGINAL-REQUEST: anything");
	assert.match(textOf(contexts[0].find((message) => message.role === "user")), /ORIGINAL-REQUEST/, "the dry run changed the context");
	assert.equal(textOf(contextAfterEdit.find((message) => message.role === "user")), "APPLIED-LATER");
	assert.equal(entries.filter((entry) => entry.type === "context_edit").length, 1, "the plan should be persisted exactly once");
});

test("dropThinking removes old thinking except what the agent names, and keeps every call", () => {
	const { contextAfterEdit } = runAgent("drop-thinking", "ORIGINAL-REQUEST: anything");
	const thinking = contextAfterEdit.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "thinking") : [])).map((block) => block.thinking.slice(0, 7));
	assert.deepEqual(thinking, ["THINK-B", "THINK-C"], `thinking the model still saw: ${thinking}`);
	const calls = contextAfterEdit.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : []));
	const results = contextAfterEdit.filter((message) => message.role === "toolResult");
	assert.equal(calls.length, 4, "every call should survive");
	assert.deepEqual(results.map((result) => result.toolCallId), calls.map((call) => call.id), "every call should keep its result");
});

test("fold replaces a call with a note and removes its result in one step", () => {
	const { contextAfterEdit, entries } = runAgent("fold-call", "ORIGINAL-REQUEST: anything");
	const foldedCallId = messageEntries(entries, "assistant")[0].message.content[0].id;
	const firstAssistant = contextAfterEdit.find((message) => message.role === "assistant");
	assert.equal(textOf(firstAssistant), "FOLDED-NOTE", `first assistant message: ${JSON.stringify(firstAssistant.content)}`);
	assert.ok(!firstAssistant.content.some((block) => block.type === "toolCall"), "the folded call is still there");
	assert.ok(!contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === foldedCallId), "the folded call's result is still there");
});

test("a block ID edits just that block and leaves the entry's call and result", () => {
	const { contextAfterEdit } = runAgent("replace-thinking-block", "ORIGINAL-REQUEST: anything");
	const firstAssistant = contextAfterEdit.find((message) => message.role === "assistant");
	assert.deepEqual(firstAssistant.content.map((block) => block.type), ["text", "toolCall"], `blocks: ${JSON.stringify(firstAssistant.content)}`);
	assert.equal(firstAssistant.content[0].text, "SHORT-NOTE");
	assert.ok(contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === firstAssistant.content[1].id), "the call lost its result");
});

test("an edit that would separate tool calls from their results is refused and changes nothing", () => {
	const { contextAfterEdit, entries } = runAgent("orphan-tool-results", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a broken edit was persisted");
	const refusal = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(refusal.isError, true, `edit_context should report an error, got: ${textOf(refusal)}`);
	assert.match(textOf(refusal), /tool result/i);
});
