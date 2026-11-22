// "Operations run in order": each operation in one edit_context call applies to the context the ones before it left,
// so a batch can restore a folded entry and then edit it, in a dry run, in the plan it returns, and when applied.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "./fixtures/run-agent.mjs";

const READS = Array(4).fill("read");
const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));

/** Run a plan script (see planSteps in the scripted model); `earlier` continues that run's session in a new Pi process, and its reports are left out. */
function runPlan(plan, earlier) {
	const symbolsPath = earlier?.symbolsPath ?? join(mkdtempSync(join(tmpdir(), "ordered-symbols-")), "symbols.json");
	const run = runAgent("plan", "ORIGINAL-REQUEST: anything", { SCRIPTED_MODEL_PLAN: JSON.stringify(plan), SCRIPTED_MODEL_SYMBOLS: symbolsPath }, { session: earlier?.sessionFile });
	const ids = JSON.parse(readFileSync(symbolsPath, "utf8"));
	const reports = run.entries.slice(earlier?.entries.length ?? 0).filter((entry) => entry.type === "message" && entry.message.toolName === "edit_context").map((entry) => entry.message);
	const callIdOf = (symbol) => run.entries.find((entry) => entry.id === ids[symbol]).message.content[0].id;
	return { ...run, ids, symbolsPath, reports, callIdOf };
}

const editCount = (entries) => entries.filter((entry) => entry.type === "context_edit").length;
const resultText = (context, callId) => context.filter((message) => message.role === "toolResult" && message.toolCallId === callId).map(textOf);
const callIds = (context) => context.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id) : []));

test("one batch restores a folded entry and then replaces it, in a dry run and in applying its plan after a reload", () => {
	const folded = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R3", note: "RANGE" } }] }]);
	assert.match(textOf(folded.reports[0]), /^Applied/, `the fold should apply: ${textOf(folded.reports[0])}`);
	const editsBefore = editCount(folded.entries);

	const batch = { ops: [{ restore: "@A3" }, { id: "@R3", replacement: "SHORT-R3" }], dryRun: true };
	const run = runPlan([batch, { applyLastPlan: true }], folded);
	const [dryRun, applied] = run.reports;
	assert.equal(dryRun.isError, false, `the dry run should accept restore-then-replace: ${textOf(dryRun)}`);
	assert.match(textOf(dryRun), /^Dry run, nothing applied/);
	assert.match(textOf(dryRun), new RegExp(`Per operation, each measured alone unless marked after the operations before it: restore ${run.ids.A3} ~-?\\d+; replace ${run.ids.R3} ~-?\\d+ after the operations before it\\.`), `the breakdown should measure the replace after the restore, and its header say so: ${textOf(dryRun)}`);
	assert.ok(applied, `the plan should be applied: ${textOf(dryRun)}`);
	assert.match(textOf(applied), /^Applied from your next request/, `apply: ${textOf(applied)}`);
	const planned = Number(textOf(dryRun).match(/(\d+) entr(?:y|ies) changed/)[1]);
	assert.equal(editCount(run.entries) - editsBefore, planned, "applying the plan must append exactly the edits the dry run reported");

	const after = run.contextAfterEdit;
	assert.deepEqual(resultText(after, run.callIdOf("A3")), ["SHORT-R3"], "the restored result should carry the replacement");
	assert.ok(callIds(after).includes(run.callIdOf("A3")), "the restored call should be back with its result");
	assert.ok(!callIds(after).includes(run.callIdOf("A2")), "the rest of the range should stay folded");
	assert.ok(after.some((message) => textOf(message) === "RANGE"), "restoring a member keeps the range note");
});

test("an ID an earlier operation brings back is a valid target for a later one: restore an entry, then fold its call", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R3", note: "RANGE" } }] }, { ops: [{ restore: "@A3" }, { fold: "@A3.c0", note: "A3-NOTE" }] }]);
	for (const report of run.reports) assert.match(textOf(report), /^Applied/, `every batch should apply: ${textOf(report)}`);
	const after = run.contextAfterEdit;
	assert.ok(after.some((message) => textOf(message) === "A3-NOTE"), "the restored call should be folded into its note");
	assert.deepEqual(resultText(after, run.callIdOf("A3")), [], "the fold should take the restored result with it");
	assert.ok(after.some((message) => textOf(message) === "RANGE"), "the range note should stay");
});

for (const dryRun of [true, false]) {
	test(`the safety checks judge the result of the whole ordered batch: restoring a call entry, then replacing it, is refused (dryRun=${dryRun})`, () => {
		const folded = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R3", note: "RANGE" } }] }]);
		const editsBefore = editCount(folded.entries);
		const run = runPlan([{ ops: [{ restore: "@A3" }, { id: "@A3", replacement: "A3-TEXT" }], dryRun }], folded);
		const [refusal] = run.reports;
		assert.equal(refusal.isError, true, `replacing the restored call entry must be refused: ${textOf(refusal)}`);
		assert.match(textOf(refusal), new RegExp(`^No edits applied, because result ${run.ids.R3} would lose its call`), `refusal: ${textOf(refusal)}`);
		assert.equal(editCount(run.entries), editsBefore, "a refusal must append no edits");
	});
}
