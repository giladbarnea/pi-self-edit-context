import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./fixtures/run-agent.mjs";

const textOf = message => typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("");

function compactedSession() {
  const directory = mkdtempSync(join(tmpdir(), "self-edit-compaction-"));
  const session = join(directory, "session.jsonl");
  const manager = SessionManager.inMemory(directory);
  const summarized = manager.appendMessage({ role: "user", content: "SUMMARIZED-ORIGINAL", timestamp: 1 });
  const retained = manager.appendMessage({ role: "user", content: "RETAINED-ORIGINAL", timestamp: 2 });
  manager.appendCompaction("Earlier work is summarized.", retained, 100);
  const previousEdit = manager.appendContextEdit(summarized, { content: "SUMMARIZED-REPLACEMENT" });
  const projection = manager.buildSessionProjection();
  assert.ok(projection.entries.some(({ sourceEntry }) => sourceEntry.id === previousEdit), "Pi retains the old edit as context metadata");
  assert.ok(!projection.entries.some(({ sourceEntry }) => sourceEntry.id === summarized), "The edit's valid target is outside the compacted context");
  writeFileSync(session, [manager.getHeader(), ...manager.getBranch()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { session, summarized, retained, previousEdit };
}

test("an old edit whose target was summarized away does not block planning a current edit", () => {
  const { session } = compactedSession();
  const { contextAfterEdit, entries } = runAgent("outline-then-dry-run", "ORIGINAL-REQUEST: continue after compaction", {}, { session });
  const report = contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(report.isError, false, `A valid historical edit must not block the dry run: ${textOf(report)}`);
  assert.match(textOf(report), /^Dry run, nothing applied/);
  assert.equal(entries.filter(entry => entry.type === "context_edit").length, 1, "A dry run must not persist any new edits");
});

test("a new range after compaction stays fully restorable across a reload while summarized history stays unchanged", () => {
  const { session, summarized } = compactedSession();
  const original = readFileSync(session);
  const symbolsPath = join(mkdtempSync(join(tmpdir(), "self-edit-compaction-symbols-")), "symbols.json");
  const environment = { SCRIPTED_MODEL_PLAN: JSON.stringify(["read", "read", { ops: [{ foldRange: { from: "@A1", to: "@R2", note: "POST-COMPACTION-RANGE" } }] }]), SCRIPTED_MODEL_SYMBOLS: symbolsPath };
  const first = runAgent("plan", "ORIGINAL-REQUEST: fold current work", environment, { session });
  const foldedReport = first.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(foldedReport.isError, false, `The new range must apply: ${textOf(foldedReport)}`);
  assert.match(textOf(foldedReport), /^Applied/);
  assert.ok(first.contextAfterEdit.some(message => textOf(message) === "POST-COMPACTION-RANGE"), "The folded range needs its visible restore note");
  const symbols = JSON.parse(readFileSync(symbolsPath, "utf8"));
  const byId = new Map(first.entries.map(entry => [entry.id, entry]));
  const calls = [symbols.A1, symbols.A2].map(id => byId.get(id).message.content[0].id);
  assert.ok(!first.contextAfterEdit.some(message => message.role === "toolResult" && calls.includes(message.toolCallId)), "The folded results must actually leave context");

  const second = runAgent("plan", "ORIGINAL-REQUEST: restore current work", { SCRIPTED_MODEL_PLAN: JSON.stringify([{ ops: [{ restore: "@A1" }] }]), SCRIPTED_MODEL_SYMBOLS: symbolsPath }, { session });
  const restoreReport = second.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(restoreReport.isError, false, `The persisted range must restore after reload: ${textOf(restoreReport)}`);
  assert.match(textOf(restoreReport), /^Applied/);
  for (const symbol of ["A1", "R1", "A2", "R2"]) {
    const stored = byId.get(symbols[symbol]).message;
    const restored = second.contextAfterEdit.find(message => message.role === stored.role && (stored.role === "toolResult" ? message.toolCallId === stored.toolCallId : message.content.some(block => block.id === stored.content[0].id)));
    assert.deepEqual(restored?.content, stored.content, `${symbol} must return byte-for-byte as stored`);
  }
  assert.ok(!second.contextAfterEdit.some(message => textOf(message).includes("SUMMARIZED-")), "An irrelevant edit must not resurrect summarized content");
  assert.equal(second.entries.filter(entry => entry.type === "context_edit" && entry.targetId === summarized).length, 1, "The old edit is retained, not rewritten");
  assert.ok(readFileSync(session).subarray(0, original.length).equals(original), "All original session bytes must stay intact");
});
