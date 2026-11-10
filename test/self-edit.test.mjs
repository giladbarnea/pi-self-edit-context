import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GPT_MODEL, GPT_THINKING_BLOCKS, writeCrossModelSession } from "./fixtures/cross-model-session.mjs";

const root = new URL("..", import.meta.url).pathname;

/**
 * Run a real `pi -p` whose model is a scripted stand-in; return each context the model recorded and the session file.
 * `model` is "provider/id"; `session` is an existing session file to open instead of starting a new one.
 */
function runAgent(script, prompt, extraEnvironment = {}, { model = "scripted/agent", session } = {}) {
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
	assert.match(outline, /^\d+ entries shown \(~[\d.]+k? est\.\)\. Context/, `outline header: ${outline.split("\n")[0]}`);
	const callEntry = messageEntries(entries, "assistant")[0];
	const resultIds = messageEntries(entries, "toolResult").map((entry) => entry.id);
	const lines = outline.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`- ${callEntry.id} assistant`));
	// 400 characters of thinking plus a 3,600-character signature is ~1.0k tokens, and the entry total must include it.
	const expected = [
		new RegExp(`^- ${callEntry.id} assistant, .*, ~1\\.0k est\\.$`),
		new RegExp(`^  - ${callEntry.id}\\.t0 thinking, ~1\\.0k est\\., signed$`),
		new RegExp(`^  - ${callEntry.id}\\.c0 call, ~\\d+ est\\.: context_outline\\(\\{"minTokens":0\\}\\)$`),
		new RegExp(`^    - ${resultIds[0]} result, `),
		new RegExp(`^  - ${callEntry.id}\\.c1 call, ~\\d+ est\\.: context_outline\\(\\{"minTokens":0\\}\\)$`),
		new RegExp(`^    - ${resultIds[1]} result, `),
	];
	const block = lines.slice(start, start + expected.length);
	expected.forEach((pattern, index) => assert.match(block[index] ?? "", pattern, `line ${index + 1} of the assistant block:\n${block.join("\n")}`));
	assert.equal(lines.filter((line) => line.includes(" result")).length, 2, "each result should appear once, nested under its call");
});

test("the outline header reports the context size from Pi's usage meter, not the character estimate", () => {
	// The provider reports 400k prompt tokens while the messages are a few hundred characters,
	// so an estimate-based header would say well under 1k.
	const { contextAfterEdit } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything", { SCRIPTED_MODEL_PROMPT_TOKENS: "400000" });
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries shown/.test(text)).at(-1);
	const header = outline.split("\n")[0];
	const meter = Number(header.match(/Context: ([\d.]+)k tokens by Pi's usage meter/)?.[1]);
	assert.ok(meter >= 400 && meter < 410, `header should report about 400k from the meter: ${header}`);
	assert.match(header, /estimates at ~4 characters per token/, `header should say entry sizes are estimates: ${header}`);
});

test("a dry run reports the effect without changing the context", () => {
	const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a dry run persisted an edit");
	const report = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(report.isError, false);
	for (const fact of [/Dry run, nothing applied/, /Frees ~[\d.]+k? est\. tokens/, /Earliest change: \w+, entry \d+ of \d+; ~[\d.]+k? est\. tokens from there on/, /Every tool call still has its result/, /"apply": "plan-\d+"/]) {
		assert.match(textOf(report), fact, `report: ${textOf(report)}`);
	}
	assert.match(textOf(contextAfterEdit.find((message) => message.role === "user")), /ORIGINAL-REQUEST/);
});

test("dry-run and apply results report Pi's usage meter, so the agent need not outline again to read it", () => {
	// The provider reports 400k prompt tokens while the messages are a few hundred characters, so only the meter says ~400k.
	const { contexts, contextAfterEdit } = runAgent("dry-run-then-apply", "ORIGINAL-REQUEST: anything", { SCRIPTED_MODEL_PROMPT_TOKENS: "400000" });
	const dryRun = textOf(contexts[0].findLast((message) => message.role === "toolResult"));
	assert.match(dryRun, /^Dry run, nothing applied\. Context now: 40\d\.\dk tokens by Pi's usage meter\. \d+ entr/, `dry run: ${dryRun}`);
	const applied = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	assert.match(applied, /^Applied from your next request\. Context before this edit: 40\d\.\dk tokens by Pi's usage meter; the meter updates after your next response\. \d+ entr/, `apply: ${applied}`);
});

test("both tool descriptions recommend planning the whole reduction, then applying it in one edit_context call", () => {
	// The descriptions as Pi sends them to the model.
	const { contextAfterEdit: tools } = runAgent("record-tool-descriptions", "anything");
	const descriptionOf = (name) => tools.find((tool) => tool.name === name)?.description ?? `no ${name} tool reached the model: ${JSON.stringify(tools)}`;
	const edit = descriptionOf("edit_context");
	const outline = descriptionOf("context_outline");
	assert.ok(edit.startsWith("Plan the whole reduction before you apply any of it, then apply it in one call."), `edit_context description: ${edit}`);
	for (const phrase of ["once an edit applies you can no longer see the original", "never refer to a summary you have not written yet", "several small calls cost far more than one large call", "if you must edit in steps, outline again before the next step"]) {
		assert.ok(edit.includes(phrase), `edit_context description lacks "${phrase}": ${edit}`);
	}
	assert.ok(!edit.includes("so batch edits into one call"), `the old cache-only wording should be replaced: ${edit}`);
	assert.ok(outline.includes("Take one outline, plan the full set of edits from it, and apply them in a single edit_context call"), `context_outline description: ${outline}`);
});

test("a dry run of several operations reports what each frees on its own", () => {
	const { contextAfterEdit, entries } = runAgent("dry-run-breakdown", "ORIGINAL-REQUEST: anything");
	const report = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	const first = messageEntries(entries, "assistant")[0].id;
	// The first entry's thinking is 400 characters plus a 3,600-character signature: ~1.0k tokens.
	assert.match(report, new RegExp(`Per operation, each measured alone: fold ${first}\\.c0 ~\\d+; dropThinking before \\w+ ~1\\.0k\\.`), `report: ${report}`);
});

test("applying a dry-run plan by its ID commits exactly that plan", () => {
	const { contexts, contextAfterEdit, entries } = runAgent("dry-run-then-apply", "ORIGINAL-REQUEST: anything");
	assert.match(textOf(contexts[0].find((message) => message.role === "user")), /ORIGINAL-REQUEST/, "the dry run changed the context");
	assert.equal(textOf(contextAfterEdit.find((message) => message.role === "user")), "APPLIED-LATER");
	const userEntry = messageEntries(entries, "user")[0];
	assert.equal(entries.filter((entry) => entry.type === "context_edit" && entry.targetId === userEntry.id).length, 1, "the plan's edit should be persisted exactly once");
	const planned = Number(textOf(contexts[0].findLast((message) => message.role === "toolResult")).match(/(\d+) entr(?:y|ies) changed/)[1]);
	assert.equal(entries.filter((entry) => entry.type === "context_edit").length, planned, "apply should persist exactly what the dry run planned");
});

test("dropThinking removes old thinking except what the agent names, and keeps every call", () => {
	const { contextAfterEdit } = runAgent("drop-thinking", "ORIGINAL-REQUEST: anything");
	const thinking = contextAfterEdit.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "thinking") : [])).map((block) => block.thinking.slice(0, 7));
	assert.deepEqual(thinking, ["THINK-B", "THINK-C"], `thinking the model still saw: ${thinking}`);
	const reads = contextAfterEdit.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall" && block.name === "read") : []));
	assert.equal(reads.length, 2, "dropping thinking must keep the calls in those entries");
	for (const read of reads) assert.ok(contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === read.id), `read ${read.id} lost its result`);
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

test("block IDs from an old outline still name the same blocks after an earlier edit in the entry", () => {
	// Folding .c0 turns that call into a note. If IDs were renumbered by position, the second call would become .c0
	// and the agent's .c1 from its old outline would miss or hit the wrong block.
	const { contextAfterEdit, entries } = runAgent("stable-block-ids", "ORIGINAL-REQUEST: anything");
	const entry = messageEntries(entries, "assistant")[0];
	const [callA, callB] = entry.message.content.filter((block) => block.type === "toolCall");
	const seen = contextAfterEdit.find((message) => message.role === "assistant");
	assert.deepEqual(seen.content.map((block) => block.type === "text" ? block.text : block.type), ["thinking", "FOLD-A", "FOLD-B"], `blocks: ${JSON.stringify(seen.content)}`);
	const resultIds = contextAfterEdit.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
	assert.ok(!resultIds.includes(callA.id) && !resultIds.includes(callB.id), "a folded call's result is still in context");
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries shown/.test(text)).at(-1);
	const lines = outline.split("\n");
	assert.match(outline, /, 2 removed by edits/, `header: ${lines[0]}`);
	assert.ok(lines.includes(`  - ${entry.id}.t0 thinking, ~1.0k est., signed`), `thinking should keep .t0:\n${outline}`);
	assert.ok(lines.some((line) => line.startsWith(`  - ${entry.id}.n0 note, `) && line.endsWith(": FOLD-A")), `first note should be .n0:\n${outline}`);
	assert.ok(lines.some((line) => line.startsWith(`- ${entry.id} assistant, `) && line.endsWith(", edited")), `the entry should be marked edited:\n${outline}`);
});

test("restore brings a folded call back with its result, exactly as stored, and clears the edited marks", () => {
	const { contexts, contextAfterEdit, entries } = runAgent("fold-then-restore", "ORIGINAL-REQUEST: anything");
	const entry = messageEntries(entries, "assistant")[0];
	const result = messageEntries(entries, "toolResult")[0];
	const removedList = textOf(contexts[0].findLast((message) => message.role === "toolResult"));
	assert.match(removedList, new RegExp(`^- ${result.id} toolResult, `, "m"), `the removed list should name the folded result:\n${removedList}`);
	const seen = contextAfterEdit.find((message) => message.role === "assistant");
	assert.deepEqual(seen.content, entry.message.content, "the restored call is not byte-identical to the stored original");
	const seenResult = contextAfterEdit.find((message) => message.role === "toolResult" && message.toolCallId === result.message.toolCallId);
	assert.deepEqual(seenResult?.content, result.message.content, "the folded result did not come back as stored");
	const outline = contextAfterEdit.filter((message) => message.role === "toolResult").map(textOf).filter((text) => /^\d+ entries shown/.test(text)).at(-1);
	const lines = outline.split("\n");
	// The removed-entries listing is itself an outline, so the restore batch folds it; the restored pair must read as unedited.
	for (const id of [entry.id, result.id]) {
		const line = lines.find((candidate) => candidate.trim().startsWith(`- ${id} `));
		assert.ok(line && !line.includes(", edited"), `${id} should be back and unedited after restore:\n${outline}`);
	}
	const restoreReport = textOf(contexts.at(-1).findLast((message) => message.role === "toolResult" && textOf(message).startsWith("Applied")));
	assert.match(restoreReport, /Adds ~\d+ est\. tokens/, `a restore grows the context and should say so: ${restoreReport}`);
});

test("restoring an entry that was never edited is refused instead of breaking the cache for nothing", () => {
	const { contextAfterEdit, entries } = runAgent("restore-unedited", "ORIGINAL-REQUEST: anything");
	const refusal = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(refusal.isError, true, `restore should refuse, got: ${textOf(refusal)}`);
	assert.match(textOf(refusal), /Nothing to apply/);
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a no-op restore was persisted");
});

test("applying edits folds earlier outlines after the earliest change, leaves earlier ones, and the note leads back", () => {
	const { contexts, contextAfterEdit, entries } = runAgent("auto-fold-outlines", "ORIGINAL-REQUEST: anything");
	const [earlyOutline, read, lateOutline] = messageEntries(entries, "assistant");
	const results = messageEntries(entries, "toolResult");
	const resultOf = (call) => results.find((candidate) => candidate.message.toolCallId === call.message.content[0].id);
	const afterEdit = contexts[0];
	const report = textOf(afterEdit.findLast((message) => message.role === "toolResult"));
	assert.match(report, new RegExp(`Also folds 1 earlier outline after the earliest change \\(${lateOutline.id}\\.c0\\)`), `report: ${report}`);
	assert.match(report, new RegExp(`Left in place, before the earliest change: outline ${earlyOutline.id}\\.c0`), `report: ${report}`);
	assert.ok(afterEdit.some((message) => message.role === "toolResult" && message.toolCallId === earlyOutline.message.content[0].id), "the outline before the earliest change must stay, or the cache break moves earlier");
	assert.ok(!afterEdit.some((message) => message.role === "toolResult" && message.toolCallId === lateOutline.message.content[0].id), "the outline after the earliest change should be folded");
	const note = textOf(afterEdit.find((message) => message.role === "assistant" && textOf(message).includes("result folded")));
	const readResult = resultOf(read);
	assert.match(note, new RegExp(`When folded, 1 of the entries it lists were removed \\(~\\d+ est\\.\\): ${readResult.id}\\.`), `note should name the removed entry it lists: ${note}`);
	assert.match(note, new RegExp(`\\{"restore": "${lateOutline.id}"\\}`), `note should say how to restore the outline: ${note}`);
	const restored = contextAfterEdit.find((message) => message.role === "toolResult" && message.toolCallId === lateOutline.message.content[0].id);
	assert.deepEqual(restored?.content, resultOf(lateOutline).message.content, "restoring the note's entry should bring the outline back as stored");
});

test("foldRange replaces a stretch with one note and removes the rest, calls and results together", () => {
	const { contextAfterEdit, entries } = runAgent("fold-range", "ORIGINAL-REQUEST: anything");
	const [firstRead, secondRead] = messageEntries(entries, "assistant");
	const seenAssistants = contextAfterEdit.filter((message) => message.role === "assistant");
	assert.equal(textOf(seenAssistants[0]), "RANGE-NOTE", `the range's first assistant should hold the note: ${JSON.stringify(seenAssistants[0].content)}`);
	const readCallIds = [firstRead, secondRead].map((entry) => entry.message.content[0].id);
	const leftovers = contextAfterEdit.filter((message) => (message.role === "toolResult" && readCallIds.includes(message.toolCallId)) || (message.role === "assistant" && message.content.some((block) => readCallIds.includes(block.id))));
	assert.deepEqual(leftovers, [], "nothing from inside the range should remain");
	assert.ok(textOf(contextAfterEdit.find((message) => message.role === "user")).includes("ORIGINAL-REQUEST"), "the user message before the range must stay");
});

test("a foldRange that would split a call from its result is refused and changes nothing", () => {
	const { contextAfterEdit, entries } = runAgent("fold-range-splits-exchange", "ORIGINAL-REQUEST: anything");
	const refusal = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(refusal.isError, true, `foldRange should refuse, got: ${textOf(refusal)}`);
	const secondReadResult = messageEntries(entries, "toolResult")[1];
	assert.match(textOf(refusal), new RegExp(`result ${secondReadResult.id} would lose its call`), `the refusal should name the stranded result's entry: ${textOf(refusal)}`);
	assert.ok(!textOf(refusal).includes("tool:"), `the refusal should not name raw tool-call IDs: ${textOf(refusal)}`);
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a refused foldRange was persisted");
});

test("the default outline collapses small entries into runs that keep their bounds, size and thinking", () => {
	const { contextAfterEdit, entries } = runAgent("default-outline", "ORIGINAL-REQUEST: anything");
	const outline = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	const [firstRead, , outlineCall] = messageEntries(entries, "assistant");
	const lines = outline.split("\n");
	assert.ok(lines.some((line) => line.startsWith("- ") && line.includes(" user, ")), `user messages should always be shown:\n${outline}`);
	assert.ok(!lines.some((line) => line.startsWith(`- ${firstRead.id} assistant`)), `small entries should not get their own lines:\n${outline}`);
	// Two reads, their two results, and the entry making this outline call form one run of 5 entries.
	assert.ok(lines.includes(`- … 5 entries ${firstRead.id} → ${outlineCall.id}, ~1.0k est., ~1.0k est. in thinking`), `run line missing or wrong:\n${outline}`);
});

test("a batch that restores an entry does not also auto-fold the outline calls in it", () => {
	const { contextAfterEdit, entries } = runAgent("restore-and-auto-fold-same-entry", "ORIGINAL-REQUEST: anything");
	const outlineEntry = messageEntries(entries, "assistant")[1];
	const report = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	assert.match(report, /^Applied/, `the batch should apply: ${report}`);
	const seen = contextAfterEdit.find((message) => message.role === "assistant" && message.content.some((block) => block.id === outlineEntry.message.content[0].id));
	assert.deepEqual(seen?.content, outlineEntry.message.content, "the restored two-call outline entry should be back as stored");
	for (const call of outlineEntry.message.content) {
		assert.ok(contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === call.id), `outline call ${call.id} lost its result`);
	}
});

test("operations in one batch apply in order to a working copy", () => {
	// R holds two reads. A first batch folds R.c0. A second batch restores R, then folds R.c1.
	const { contextAfterEdit, entries } = runAgent("ordered-operations", "ORIGINAL-REQUEST: anything");
	const reads = messageEntries(entries, "assistant")[0];
	const [callA, callB] = reads.message.content;
	const report = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	assert.match(report, /^Applied/, `restore then fold of the same entry should apply: ${report}`);
	const seen = contextAfterEdit.find((message) => message.role === "assistant");
	assert.deepEqual(seen.content, [callA, { type: "text", text: "N2" }], `R should be restored and then have its second call folded: ${JSON.stringify(seen.content)}`);
	assert.ok(contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === callA.id), "the restore should bring back the first call's result");
	assert.ok(!contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === callB.id), "the fold should remove the second call's result");
});

test("restoring a result also restores the entry holding its call", () => {
	const { contextAfterEdit, entries } = runAgent("restore-result-brings-call", "ORIGINAL-REQUEST: anything");
	const readA = messageEntries(entries, "assistant")[0];
	const report = textOf(contextAfterEdit.findLast((message) => message.role === "toolResult"));
	assert.match(report, /^Applied/, `restoring the result should apply: ${report}`);
	assert.deepEqual(contextAfterEdit.find((message) => message.role === "assistant").content, readA.message.content, "the call's entry should be restored");
	assert.ok(contextAfterEdit.some((message) => message.role === "toolResult" && message.toolCallId === readA.message.content[0].id), "the result should be back");
});

test("an edit that would separate tool calls from their results is refused and changes nothing", () => {
	const { contextAfterEdit, entries } = runAgent("orphan-tool-results", "ORIGINAL-REQUEST: anything");
	assert.ok(!entries.some((entry) => entry.type === "context_edit"), "a broken edit was persisted");
	const refusal = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(refusal.isError, true, `edit_context should report an error, got: ${textOf(refusal)}`);
	const strandedResult = messageEntries(entries, "toolResult")[0];
	assert.match(textOf(refusal), new RegExp(`result ${strandedResult.id} would lose its call`), `the refusal should name the stranded result's entry: ${textOf(refusal)}`);
	assert.ok(!textOf(refusal).includes("tool:"), `the refusal should not name raw tool-call IDs: ${textOf(refusal)}`);
});

test("a re-folded outline's note still says which of its entries are removed, not just what the latest batch did", () => {
	// readA and readB; edit 1 folds A; outline O2 is taken; edit 2 folds B and folds O2; the agent restores O2 from its note,
	// then restores A, which folds O2 again. O2 never listed A's result, and B's result stays removed throughout.
	const { contexts, entries } = runAgent("outline-trail", "ORIGINAL-REQUEST: anything");
	const [, readB] = messageEntries(entries, "assistant");
	const outlineEntries = messageEntries(entries, "assistant").filter((entry) => entry.message.content.some((block) => block.name === "context_outline"));
	const secondOutline = outlineEntries[1];
	const resultB = messageEntries(entries, "toolResult").find((entry) => entry.message.toolCallId === readB.message.content[0].id);
	const noteOn = (context) => textOf(context.find((message) => message.role === "assistant" && message.content.some((block) => block.text?.includes(`{"restore": "${secondOutline.id}"}`))) ?? { content: [] });
	for (const [label, context] of [["first fold", contexts[0]], ["fold after the round trip", contexts[2]]]) {
		const note = noteOn(context);
		assert.match(note, /It was taken at \d\d:\d\d and showed \d+ entries \(~[\d.]+k? est\.\)/, `${label}: the note should describe the outline itself: ${note}`);
		assert.match(note, new RegExp(`When folded, 1 of the entries it lists were removed \\(~\\d+ est\\.\\): ${resultB.id}\\.`), `${label}: the note should name B's result as the one removed entry it lists: ${note}`);
	}
	assert.ok(contexts[1].some((message) => message.role === "toolResult" && message.toolCallId === secondOutline.message.content[0].id), "the note's restore should have brought the outline back");
});

/** Open the synthetic GPT→Claude session as `model`; return the outline the agent read, the dropThinking dry run and the stored entries. */
function estimatesOnCrossModelSession({ signatures, model, identity }) {
	const session = join(mkdtempSync(join(tmpdir(), "self-edit-session-")), "cross-model.jsonl");
	const signatureCharacters = writeCrossModelSession(session, { signatures });
	const environment = identity ? { SCRIPTED_MODEL_IDENTITY: identity } : {};
	const { contextAfterEdit, entries } = runAgent("cross-model-estimates", "outline", environment, { model, session });
	const [outline, dryRun] = contextAfterEdit.filter((message) => message.role === "toolResult").slice(-2).map(textOf);
	const estimate = Number(outline.match(/^\d+ entries shown \(~([\d.]+)k est\.\)/)[1]) * 1000;
	const meter = Number(outline.match(/Context: ([\d.]+)k tokens by Pi's usage meter/)[1]) * 1000;
	const thinkingLine = (entry) => outline.split("\n").find((line) => line.startsWith(`  - ${entry.id}.t0 thinking,`));
	// The session's GPT entries come first; the agent's own outline-call entry, with its signed thinking, follows them.
	const assistants = messageEntries(entries, "assistant");
	const gptThinkingLines = assistants.slice(0, GPT_THINKING_BLOCKS).map(thinkingLine);
	assert.equal(gptThinkingLines.filter(Boolean).length, GPT_THINKING_BLOCKS, `every GPT thinking block should have a line:\n${outline}`);
	const ownThinkingLine = thinkingLine(assistants[GPT_THINKING_BLOCKS]);
	return { outline, dryRun, estimate, meter, signatureCharacters, gptThinkingLines, ownThinkingLine };
}

test("estimates count only what Pi sends: thinking another model wrote costs nothing on the current model", () => {
	// The agent runs as scripted/agent, a different model from the gpt-6-astra that wrote the session's 20 signed thinking
	// blocks (~43k characters ÷ 4 of signatures). Pi's transformMessages drops those blocks, so the original session and a
	// copy with the signatures emptied must estimate the same, and near what Pi's meter reports for the request.
	const original = estimatesOnCrossModelSession({ signatures: true, model: "scripted/agent" });
	const stripped = estimatesOnCrossModelSession({ signatures: false, model: "scripted/agent" });
	const signatureTokens = original.signatureCharacters / 4;
	assert.ok(signatureTokens > 40_000, `the fixture should carry about 43k signature tokens, not ${signatureTokens}`);
	assert.equal(original.estimate, stripped.estimate, `the header estimate should not count dropped signatures: original ~${original.estimate}, stripped ~${stripped.estimate}`);
	assert.ok(Math.abs(original.estimate - original.meter) < original.meter, `the estimate should be near Pi's meter, not ${original.estimate} against ${original.meter}`);
	for (const line of original.gptThinkingLines) assert.match(line, /thinking, ~0 est\., signed$/, `a dropped signed block should cost nothing: ${line}`);
	assert.match(original.ownThinkingLine, /~1\.0k est\., signed$/, `the agent's own signed thinking is sent and should still count: ${original.ownThinkingLine}`);
	assert.match(original.dryRun, /dropThinking before \w+ ~0;/, `dropping thinking Pi never sends should free nothing: ${original.dryRun}`);
});

test("estimates count signatures the current model does receive: the same model that wrote them", () => {
	const identity = `${GPT_MODEL.provider}/${GPT_MODEL.api}/${GPT_MODEL.model}`;
	const model = `${GPT_MODEL.provider}/${GPT_MODEL.model}`;
	const original = estimatesOnCrossModelSession({ signatures: true, model, identity });
	const stripped = estimatesOnCrossModelSession({ signatures: false, model, identity });
	const signatureTokens = original.signatureCharacters / 4;
	assert.ok(Math.abs(original.estimate - stripped.estimate - signatureTokens) < 200, `on the writing model the signatures are sent and should count: original ~${original.estimate}, stripped ~${stripped.estimate}, signatures ${signatureTokens}`);
	for (const line of original.gptThinkingLines) assert.match(line, /thinking, ~2\.\dk est\., signed$/, `a sent signed block should cost its characters: ${line}`);
	assert.match(original.dryRun, /dropThinking before \w+ ~4\d\.\dk;/, `dropping thinking the model receives should free its signatures: ${original.dryRun}`);
});

test("a restore that breaks the cache far back applies directly, and its report gives the cost", () => {
	const { contextAfterEdit, entries } = runAgent("expensive-restore", "ORIGINAL-REQUEST: anything");
	const readA = messageEntries(entries, "assistant")[0];
	const report = contextAfterEdit.findLast((message) => message.role === "toolResult");
	assert.equal(report.isError, false, `the restore should apply: ${textOf(report)}`);
	assert.match(textOf(report), /~2\d(\.\d)?k est\. tokens from there on are reprocessed without the prompt cache once/, `report should give the cost: ${textOf(report)}`);
	assert.deepEqual(contextAfterEdit.find((message) => message.role === "assistant").content, readA.message.content, "the read should be restored");
});
