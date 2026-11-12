// Restore trails: a fold's note is a bead over what it folds. Restoring the bead's holder restores everything under it,
// including older beads it hides; restoring another member keeps the bead. A plain deletion leaves a bead of its own.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "./fixtures/run-agent.mjs";

const READS = Array(8).fill("read");
const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));

/** Run a plan script (see planSteps in the scripted model); `session` and `symbolsPath` continue an earlier run after a reload. */
function runPlan(plan, { session, symbolsPath = join(mkdtempSync(join(tmpdir(), "trail-symbols-")), "symbols.json") } = {}) {
	const run = runAgent("plan", "ORIGINAL-REQUEST: anything", { SCRIPTED_MODEL_PLAN: JSON.stringify(plan), SCRIPTED_MODEL_SYMBOLS: symbolsPath }, { session });
	const ids = JSON.parse(readFileSync(symbolsPath, "utf8"));
	const reports = run.entries.filter((entry) => entry.type === "message" && entry.message.toolName === "edit_context").map((entry) => textOf(entry.message));
	return { ...run, ids, symbolsPath, reports };
}

/** The reads and results a context holds as stored (by tool call ID), and the text of every note: messages with no call or result. */
function seen(context, { entries, ids }) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const callIdOf = (read) => byId.get(ids[read]).message.content[0].id;
	const reads = Object.keys(ids).filter((symbol) => /^A\d+$/.test(symbol));
	const calls = context.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id) : []));
	const results = context.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
	const present = reads.flatMap((read) => [
		...(calls.includes(callIdOf(read)) ? [read] : []),
		...(results.includes(callIdOf(read)) ? [read.replace("A", "R")] : []),
	]);
	const notes = context.filter((message) => message.role !== "toolResult" && !(message.content instanceof Array && message.content.some((block) => block.type === "toolCall"))).map(textOf);
	return { present, notes, calls };
}

const everything = (except = []) => Array.from({ length: 8 }, (_, index) => [`A${index + 1}`, `R${index + 1}`]).flat().filter((symbol) => !except.includes(symbol));

function assertApplied(reports) {
	for (const report of reports) assert.match(report, /^Applied/, `every batch should apply: ${report}`);
}

test("restoring a range's note holder brings back the whole range, and restoring a member first keeps the note (cases 1, 2)", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "RANGE" } }] }, { ops: [{ restore: "@A3" }] }, { ops: [{ restore: "@A2" }] }]);
	assertApplied(run.reports);
	const [folded, memberBack, holderBack] = run.contexts.map((context) => seen(context, run));
	assert.deepEqual(folded.present, everything(["A2", "R2", "A3", "R3", "A4", "R4"]));
	assert.ok(folded.notes.includes("RANGE"), `the note should hold the range: ${folded.notes}`);
	assert.deepEqual(memberBack.present, everything(["A2", "R2", "A4", "R4"]), "restoring a member brings back only it");
	assert.ok(memberBack.notes.includes("RANGE"), `restoring a member should keep the range note: ${memberBack.notes}`);
	assert.deepEqual(holderBack.present, everything(), "restoring the note holder should bring back the whole range");
	assert.ok(!holderBack.notes.includes("RANGE"), "the note should go once the range is back");
	assert.equal(new Set(holderBack.calls).size, holderBack.calls.length, "no call should come back twice");
});

test("restoring a result whose call sits in the note holder restores the whole range (case 3)", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "RANGE" } }] }, { ops: [{ restore: "@R2" }] }]);
	assertApplied(run.reports);
	assert.deepEqual(seen(run.contextAfterEdit, run).present, everything());
});

test("a range that starts at a tool result keeps its note on its first user or assistant message, and restoring that holder brings back the range (case 4)", () => {
	// A2's call is replaced by a note in the same batch, so the range may start at its result R2; the note goes on A3.
	const run = runPlan([...READS, { ops: [{ id: "@A2", replacement: "A2-NOTE" }, { foldRange: { from: "@R2", to: "@R4", note: "RANGE" } }] }, { ops: [{ restore: "@A3" }] }]);
	assertApplied(run.reports);
	const folded = seen(run.contexts[0], run);
	assert.deepEqual(folded.present, everything(["A2", "R2", "A3", "R3", "A4", "R4"]));
	assert.ok(folded.notes.includes("A2-NOTE") && folded.notes.includes("RANGE"), `notes: ${folded.notes}`);
	// R2 needs its call, so A2 returns to its original too.
	assert.deepEqual(seen(run.contextAfterEdit, run).present, everything());
});

test("restoring a range folded over an older range's note holder brings back both ranges (case 5)", () => {
	// Inner range A2 → R3 has its note on A2; the outer range A1 → A2 folds that note away.
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R3", note: "INNER" } }] }, { ops: [{ foldRange: { from: "@A1", to: "@A2", note: "OUTER" } }] }, { ops: [{ restore: "@A1" }] }]);
	assertApplied(run.reports);
	const outer = seen(run.contexts[1], run);
	assert.ok(outer.notes.includes(`OUTER [Also hides the earlier notes on ${run.ids.A2}.]`), `the outer note should name the inner note it hides: ${outer.notes}`);
	const restored = seen(run.contextAfterEdit, run);
	assert.deepEqual(restored.present, everything());
	assert.ok(!restored.notes.some((note) => note.includes("INNER") || note.includes("OUTER")), `no note should be left: ${restored.notes}`);
});

test("restoring the outer of three nested ranges once brings back all three as stored (case 6)", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A4", to: "@R4", note: "I1" } }] }, { ops: [{ foldRange: { from: "@A3", to: "@R5", note: "I2" } }] }, { ops: [{ foldRange: { from: "@A2", to: "@R6", note: "I3" } }] }, { ops: [{ restore: "@A2" }] }]);
	assertApplied(run.reports);
	assert.deepEqual(seen(run.contextAfterEdit, run).present, everything());
});

test("restoring one of two neighboring ranges leaves the other folded with its note (case 7)", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R3", note: "LEFT" } }, { foldRange: { from: "@A4", to: "@R5", note: "RIGHT" } }] }, { ops: [{ restore: "@A2" }] }]);
	assertApplied(run.reports);
	const after = seen(run.contextAfterEdit, run);
	assert.deepEqual(after.present, everything(["A4", "R4", "A5", "R5"]));
	assert.ok(after.notes.includes("RIGHT") && !after.notes.includes("LEFT"), `notes: ${after.notes}`);
});

test("restoring a range made of a member restored from an older range returns only its own members (case 8)", () => {
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "A-RANGE" } }] }, { ops: [{ restore: "@A3" }] }, { ops: [{ foldRange: { from: "@A3", to: "@R3", note: "B-RANGE" } }] }, { ops: [{ restore: "@A3" }] }]);
	assertApplied(run.reports);
	const after = seen(run.contextAfterEdit, run);
	assert.deepEqual(after.present, everything(["A2", "R2", "A4", "R4"]));
	assert.ok(after.notes.includes("A-RANGE"), `the older range keeps its note: ${after.notes}`);
});

test("a range whose holder was restored does not come back with its old bounds when that entry holds a later note", () => {
	// A2 → R4 is folded and restored; then A4 → R5 and A2 → R2 are folded. Restoring A2 now must not reach A4's range.
	const run = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "OLD" } }] }, { ops: [{ restore: "@A2" }] }, { ops: [{ foldRange: { from: "@A4", to: "@R5", note: "RIGHT" } }, { foldRange: { from: "@A2", to: "@R2", note: "NEW" } }] }, { ops: [{ restore: "@A2" }] }]);
	assertApplied(run.reports);
	const after = seen(run.contextAfterEdit, run);
	assert.deepEqual(after.present, everything(["A4", "R4", "A5", "R5"]));
	assert.ok(after.notes.includes("RIGHT"), `the later range keeps its note: ${after.notes}`);
});

test("a range note names every earlier note it hides: a call fold, a range note and a folded outline (case 9)", () => {
	// The first batch also folds the outline taken before it, which leaves a note on the outline's entry O.
	const run = runPlan([...READS, { ops: [{ fold: "@A2.c0", note: "CALL-NOTE" }, { foldRange: { from: "@A4", to: "@R5", note: "INNER" } }] }, { ops: [{ foldRange: { from: "@A1", to: "@O", note: "ALL" } }] }]);
	assertApplied(run.reports);
	const { ids } = run;
	assert.ok(seen(run.contextAfterEdit, run).notes.includes(`ALL [Also hides the earlier notes on ${ids.A2}, ${ids.A4}, ${ids.O}.]`), `notes: ${seen(run.contextAfterEdit, run).notes}`);
});

test("a fold and a member restore in one call end as they do in two calls (case 10)", () => {
	const together = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "RANGE" } }, { restore: "@A3" }] }, { ops: [{ restore: "@A2" }] }]);
	const apart = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "RANGE" } }] }, { ops: [{ restore: "@A3" }] }, { ops: [{ restore: "@A2" }] }]);
	assertApplied([...together.reports, ...apart.reports]);
	const [togetherFolded, togetherBack] = together.contexts.map((context) => seen(context, together));
	const apartFolded = seen(apart.contexts[1], apart);
	const apartBack = seen(apart.contextAfterEdit, apart);
	assert.deepEqual([togetherFolded.present, togetherFolded.notes.includes("RANGE")], [apartFolded.present, apartFolded.notes.includes("RANGE")]);
	assert.deepEqual(togetherBack.present, apartBack.present);
	assert.deepEqual(togetherBack.present, everything());
});

test("range membership survives a reload: restoring the holder in a new Pi process brings back the whole range (case 11)", () => {
	const first = runPlan([...READS, { ops: [{ foldRange: { from: "@A2", to: "@R4", note: "RANGE" } }] }]);
	const ranges = first.entries.filter((entry) => entry.type === "custom");
	assert.equal(ranges.length, 1, "the fold should store one range entry");
	assert.deepEqual(ranges[0].data, { holder: first.ids.A2, from: first.ids.A2, to: first.ids.R4 });
	const second = runPlan([{ ops: [{ restore: "@A2" }] }], { session: first.sessionFile, symbolsPath: first.symbolsPath });
	assertApplied(second.reports);
	assert.deepEqual(seen(second.contextAfterEdit, first.ids && second).present, everything());
});

test("a plain deletion leaves a note; a fold over it hides that note, and restoring the fold brings back the deleted entry as stored", () => {
	const run = runPlan([...READS, { ops: [{ id: "@U", replacement: null }] }, { ops: [{ foldRange: { from: "@U", to: "@R2", note: "OUTER" } }] }, { ops: [{ restore: "@U" }] }]);
	assertApplied(run.reports);
	const { ids } = run;
	const [deleted, folded, restored] = run.contexts.map((context) => seen(context, run));
	assert.equal(textOf(run.contexts[0].find((message) => message.role === "user")), `[Entry removed by edit_context; {"restore": "${ids.U}"} brings it back.]`);
	assert.deepEqual(deleted.present, everything());
	assert.ok(folded.notes.includes(`OUTER [Also hides the earlier notes on ${ids.U}.]`), `notes: ${folded.notes}`);
	assert.deepEqual(restored.present, everything());
	assert.equal(textOf(run.contextAfterEdit.find((message) => message.role === "user")), "ORIGINAL-REQUEST: anything");
});

test("deleting a tool result is refused with the way out: fold its call, which takes the result with it", () => {
	const run = runPlan([...READS, { ops: [{ id: "@R2", replacement: null }] }]);
	assert.match(run.reports[0], new RegExp(`${run.ids.R2} is a tool result, which cannot hold a note; fold its call instead: \\{"fold": "${run.ids.A2}\\.c0", "note": \\.\\.\\.\\}`), `refusal: ${run.reports[0]}`);
	assert.ok(!run.entries.some((entry) => entry.type === "context_edit"), "a refused deletion was persisted");
});

test("deleting a tool result whose call is no longer in its entry gets the general refusal, not a fold hint that cannot apply", () => {
	// The first operation replaces A2, call and all, with text; R2's call is then gone from context, so "fold A2.c0" would fail.
	const run = runPlan([...READS, { ops: [{ id: "@A2", replacement: "A2-TEXT" }, { id: "@R2", replacement: null }] }]);
	assert.match(run.reports[0], new RegExp(`removing ${run.ids.R2} has no user or assistant message to hold the note`), `refusal: ${run.reports[0]}`);
	assert.ok(!run.reports[0].includes("fold its call instead"), `no fold hint for a call that is gone: ${run.reports[0]}`);
	assert.ok(!run.entries.some((entry) => entry.type === "context_edit"), "a refused deletion was persisted");
});
