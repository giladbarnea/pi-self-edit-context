import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./fixtures/run-agent.mjs";

const textOf = message => typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("");

function sessionWithMetadata({ paired = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "self-edit-restore-metadata-"));
  const manager = SessionManager.create(directory, directory);
  const holder = manager.appendMessage({ role: "user", content: "ORIGINAL-HOLDER", timestamp: 1 });
  const call = fauxToolCall("read", { path: "/dev/null" });
  if (paired) manager.appendMessage(fauxAssistantMessage([fauxThinking("ORIGINAL-THINKING"), call]));
  manager.appendCustomEntry("progress-state", { phase: "running" });
  const result = manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "ORIGINAL-RESULT" }], isError: false, timestamp: 2 });
  const session = manager.getSessionFile();
  const symbols = join(directory, "symbols.json");
  writeFileSync(symbols, JSON.stringify({ U: holder }));
  const original = readFileSync(session);
  const projection = manager.buildSessionProjection();
  const run = (operations, dryRun = false) => runAgent("plan", "Continue synthetic restore test", {
    SCRIPTED_MODEL_SYMBOLS: symbols,
    SCRIPTED_MODEL_PLAN: JSON.stringify([{ ops: operations, dryRun }]),
  }, { session });
  return { session, holder, result, original, projection, run };
}

function assertOriginals(fixture) {
  const restored = SessionManager.open(fixture.session).buildSessionProjection();
  for (const entry of fixture.projection.entries) {
    const current = restored.entries.find(candidate => candidate.sourceEntry.id === entry.sourceEntry.id);
    assert.deepEqual(current, entry, `${entry.sourceEntry.id} must return exactly as stored`);
  }
  assert.ok(readFileSync(fixture.session).subarray(0, fixture.original.length).equals(fixture.original), "original history bytes must remain intact");
}

test("an accepted range with metadata between a call and result previews and restores exactly after reload", () => {
  const fixture = sessionWithMetadata();
  const operations = [{ foldRange: { from: fixture.holder, to: fixture.result, note: "RANGE-NOTE" } }];
  const folded = fixture.run(operations);
  assert.match(textOf(folded.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  const countBefore = folded.entries.filter(entry => entry.type === "context_edit").length;
  const preview = fixture.run([{ restore: fixture.holder }], true);
  const previewReport = preview.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(previewReport.isError, false, `a valid fold must remain previewable: ${textOf(previewReport)}`);
  assert.match(textOf(previewReport), /^Dry run, nothing applied/);
  assert.equal(preview.entries.filter(entry => entry.type === "context_edit").length, countBefore, "preview must append no edits");
  const planned = Number(textOf(previewReport).match(/(\d+) entr(?:y|ies) changed/)[1]);
  const applied = fixture.run([{ restore: fixture.holder }]);
  assert.match(textOf(applied.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assert.equal(applied.entries.filter(entry => entry.type === "context_edit").length - countBefore, planned, "apply must match the previewed restoration");
  assertOriginals(fixture);
  const foldedAgain = fixture.run(operations);
  assert.match(textOf(foldedAgain.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  const restoredByResult = fixture.run([{ restore: fixture.result }]);
  assert.match(textOf(restoredByResult.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  const memberProjection = SessionManager.open(fixture.session).buildSessionProjection();
  for (const entry of fixture.projection.entries.filter(entry => entry.sourceEntry.id !== fixture.holder)) {
    assert.deepEqual(memberProjection.entries.find(candidate => candidate.sourceEntry.id === entry.sourceEntry.id), entry);
  }
  assert.equal(memberProjection.entries.find(entry => entry.sourceEntry.id === fixture.holder).messages[0].content, "RANGE-NOTE", "a member restore must keep the range note");
  const holderRestored = fixture.run([{ restore: fixture.holder }]);
  assert.match(textOf(holderRestored.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assertOriginals(fixture);
});

for (const dryRun of [true, false]) {
  test(`metadata does not disguise a restore with no stored call (dryRun=${dryRun})`, () => {
    const fixture = sessionWithMetadata({ paired: false });
    const folded = fixture.run([{ foldRange: { from: fixture.holder, to: fixture.result, note: "HIDDEN-ORPHAN" } }]);
    assert.match(textOf(folded.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
    const countBefore = folded.entries.filter(entry => entry.type === "context_edit").length;
    const restored = fixture.run([{ restore: fixture.holder }], dryRun);
    const refusal = restored.contextAfterEdit.findLast(message => message.role === "toolResult");
    assert.equal(refusal.isError, true, `an unmatched result must be refused: ${textOf(refusal)}`);
    assert.match(textOf(refusal), new RegExp(`^No edits applied, because result ${fixture.result} would lose its call`));
    assert.equal(restored.entries.filter(entry => entry.type === "context_edit").length, countBefore, "a refusal must append no edits");
    assert.ok(readFileSync(fixture.session).subarray(0, fixture.original.length).equals(fixture.original));
  });
}
