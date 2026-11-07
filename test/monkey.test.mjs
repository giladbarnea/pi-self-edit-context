import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const SEEDS = (process.env.MONKEY_SEEDS ?? "1,2,3").split(",").map(Number);
const ACTS = Number(process.env.MONKEY_ACTS ?? 40);

/** Run the seeded monkey agent through a real `pi -p`; return its exit, stderr, recorded contexts and session entries. */
function runMonkey(seed) {
	const directory = mkdtempSync(join(tmpdir(), "self-edit-monkey-"));
	const log = join(directory, "contexts.jsonl");
	const run = spawnSync(
		join(root, "node_modules/.bin/pi"),
		["-p", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp",
			"-e", join(root, "index.ts"), "-e", join(root, "test/fixtures/scripted-model.ts"),
			"--model", "scripted/agent", "--session-dir", directory, "ORIGINAL-REQUEST: monkey"],
		{ cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), SCRIPTED_MODEL_SCRIPT: "monkey", SCRIPTED_MODEL_LOG: log, SCRIPTED_MODEL_SEED: String(seed), SCRIPTED_MODEL_ACTS: String(ACTS) }, timeout: 60_000 },
	);
	const sessionFile = readdirSync(directory).find((name) => name.endsWith(".jsonl") && name !== "contexts.jsonl");
	const contexts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const entries = readFileSync(join(directory, sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { run, contexts, entries, directory };
}

const textOf = (content) => (typeof content === "string" ? content : content.map((block) => block.text ?? "").join(""));
const isOutlineMessage = (message) =>
	(message.role === "toolResult" && message.toolName === "context_outline") ||
	(message.role === "assistant" && message.content.some((block) => (block.type === "toolCall" && block.name === "context_outline") || (block.type === "text" && block.text.includes("context_outline result folded"))));

/** Problems that would make a request unsendable: not starting with a user message, or a call and result that do not pair up. */
function sendProblems(context) {
	const problems = [];
	if (context[0]?.role !== "user") problems.push(`starts with ${context[0]?.role}`);
	let open = new Set();
	for (const message of context) {
		if (message.role === "assistant") {
			if (open.size > 0) problems.push(`calls without results: ${[...open]}`);
			open = new Set(message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
		}
		if (message.role === "toolResult" && !open.delete(message.toolCallId)) problems.push(`result without call: ${message.toolCallId}`);
	}
	if (open.size > 0) problems.push(`calls without results at the end: ${[...open]}`);
	return problems;
}

/** Each edit_context call with its result entry and the context_edit entries Pi appended after it. */
function editCalls(entries) {
	const calls = [];
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "edit_context") return;
		const callEntry = entries.slice(0, index).findLast((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
		const call = callEntry.message.content.find((block) => block.id === entry.message.toolCallId);
		const nextMessage = entries.findIndex((candidate, position) => position > index && candidate.type === "message");
		const batch = entries.slice(index + 1, nextMessage < 0 ? undefined : nextMessage).filter((candidate) => candidate.type === "context_edit");
		calls.push({ call, result: entry.message, batch });
	});
	return calls;
}

for (const seed of SEEDS) {
	test(`monkey seed ${seed}: arbitrary edit sequences keep the context sound and fully restorable`, () => {
		const { run, contexts, entries, directory } = runMonkey(seed);
		const where = `(seed ${seed}, session in ${directory})`;
		assert.equal(run.status, 0, `pi exited ${run.status} ${where}: ${run.stderr}`);
		assert.ok(!run.stderr.includes("Extension error"), `extension error ${where}: ${run.stderr}`);

		contexts.forEach((context, index) => {
			const problems = sendProblems(context);
			assert.deepEqual(problems, [], `request ${index + 1} was unsendable ${where}`);
		});

		const calls = editCalls(entries);
		const applied = calls.filter(({ result }) => !result.isError && textOf(result.content).startsWith("Applied"));
		assert.ok(applied.length >= ACTS / 4, `the monkey should land a fair share of edits; only ${applied.length} of ${calls.length} applied ${where}`);
		for (const { call, result, batch } of calls) {
			const changesNothing = result.isError || textOf(result.content).startsWith("Dry run");
			if (changesNothing) assert.deepEqual(batch, [], `a refused or dry-run edit persisted entries ${where}: ${JSON.stringify(call.arguments)} → ${textOf(result.content)}`);
			else assert.ok(batch.length > 0, `an applied edit persisted nothing ${where}: ${JSON.stringify(call.arguments)}`);
		}

		// fold E.cK must remove the result of E's K-th original call, however E was edited before.
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		for (const { call, result, batch } of applied) {
			for (const operation of call.arguments.operations ?? []) {
				if (!operation.fold) continue;
				const [entryId, block] = operation.fold.split(".");
				const original = byId.get(entryId).message.content.filter((candidate) => candidate.type === "toolCall")[Number(block.slice(1))];
				const resultEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === original.id);
				assert.ok(batch.some((edit) => edit.targetId === resultEntry.id && edit.replacement === null), `fold ${operation.fold} did not remove the result of that original call ${where}: ${textOf(result.content)}`);
			}
		}

		// Every outline's header count of removed entries matches the removed list taken at the same moment.
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const outlineCalls = entry.message.content.filter((block) => block.type === "toolCall" && block.name === "context_outline");
			if (outlineCalls.length !== 2) continue;
			const [outlineText, removedText] = outlineCalls.map((block) => textOf(entries.find((candidate) => candidate.type === "message" && candidate.message.toolCallId === block.id).message.content));
			const headerCount = Number(outlineText.split("\n")[0].match(/, (\d+) removed by edits/)?.[1] ?? 0);
			const listCount = removedText.split("\n").filter((line) => /^- [0-9a-f]{8} /.test(line)).length;
			assert.equal(headerCount, listCount, `outline header and removed list disagree ${where}`);
		}

		// After restoring everything, every non-outline message is back exactly as stored.
		const finalContext = contexts.at(-1).filter((message) => !isOutlineMessage(message));
		const stored = entries
			.filter((entry) => entry.type === "message" && entry.message.role !== "system")
			.slice(0, -1)
			.map((entry) => entry.message)
			.filter((message) => !isOutlineMessage(message));
		const shape = (message) => ({ role: message.role, content: message.content, toolCallId: message.toolCallId });
		assert.equal(finalContext.length, stored.length, `restored context has ${finalContext.length} non-outline messages, the session ${stored.length} ${where}`);
		finalContext.forEach((message, index) => assert.deepEqual(shape(message), shape(stored[index]), `message ${index + 1} differs after restoring everything ${where}`));
	});
}
