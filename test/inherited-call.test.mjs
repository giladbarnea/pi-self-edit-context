import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./fixtures/run-agent.mjs";

const textOf = message => typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("");

function forkedSession({ reuseCallId = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "self-edit-inherited-call-"));
  const parent = SessionManager.create(directory, join(directory, "parent"));
  const parentUser = parent.appendMessage({ role: "user", content: "PARENT-REQUEST", timestamp: 1 });
  const creation = fauxToolCall("team_add_teammates", { teammates: [{ name: "child", fork: true }] });
  const inherited = parent.appendMessage(fauxAssistantMessage(creation));
  const child = SessionManager.forkFrom(parent.getSessionFile(), directory, join(directory, "child"));
  const parentResult = parent.appendMessage({ role: "toolResult", toolCallId: creation.id, toolName: creation.name, content: [{ type: "text", text: "child created" }], isError: false, timestamp: 2 });
  const user = child.appendMessage({ role: "user", content: "ORIGINAL-REQUEST: continue in child", timestamp: 3 });
  const call = fauxToolCall("read", { path: "/dev/null" });
  if (reuseCallId) call.id = creation.id;
  const assistant = child.appendMessage(fauxAssistantMessage([fauxThinking("CHILD-THINKING"), call]));
  const result = child.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "read complete" }], isError: false, timestamp: 4 });
  const boundary = child.appendMessage({ role: "user", content: "CHILD-BOUNDARY", timestamp: 5 });
  const session = child.getSessionFile();
  const original = readFileSync(session);
  assert.equal(child.getHeader().parentSession, parent.getSessionFile());
  assert.equal(child.getEntry(parentResult), undefined, "the child must never store the parent's eventual result");
  return { directory, session, original, parentUser, inherited, creation, user, assistant, result, boundary, entries: child.getEntries() };
}

function runOperations(fork, operations, { dryRun = false } = {}) {
  const symbols = join(fork.directory, "symbols.json");
  writeFileSync(symbols, JSON.stringify({ U: fork.user }));
  return runAgent("plan", "Continue private fork test", {
    SCRIPTED_MODEL_SYMBOLS: symbols,
    SCRIPTED_MODEL_PLAN: JSON.stringify([{ ops: operations, dryRun }]),
  }, { session: fork.session });
}

function assertOriginalsRestored(fork) {
  const projection = SessionManager.open(fork.session).buildSessionProjection();
  for (const original of fork.entries.filter(entry => entry.type === "message")) {
    const projected = projection.entries.find(entry => entry.sourceEntry.id === original.id);
    assert.deepEqual(projected?.messages, [original.message], `${original.id} must return exactly as stored`);
  }
  assert.ok(readFileSync(fork.session).subarray(0, fork.original.length).equals(fork.original), "all original history bytes must stay intact");
}

test("an inherited in-flight creation call allows an unrelated saved plan and exact restore after reload", () => {
  const fork = forkedSession();
  const probe = runAgent("outline-then-dry-run", "Continue private fork test", {}, { session: fork.session });
  const probeReport = probe.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(probeReport.isError, false, `the inherited call must not block an unrelated edit: ${textOf(probeReport)}`);
  const first = runAgent("dry-run-then-apply", "Continue private fork test", {}, { session: fork.session });
  const dryRun = first.contexts[0].findLast(message => message.role === "toolResult");
  assert.equal(dryRun.isError, false, `the inherited call must not block the safe dry run: ${textOf(dryRun)}`);
  assert.match(textOf(dryRun), /^Dry run, nothing applied/);
  assert.match(textOf(dryRun), /All previously paired calls and results stay together/);
  assert.ok(!textOf(dryRun).includes("Every tool call still has its result"), "the report must not claim the inherited orphan has a result");
  assert.equal(textOf(first.contexts[0].find(message => message.role === "user" && textOf(message).includes("ORIGINAL-REQUEST"))), "ORIGINAL-REQUEST: continue in child");
  const applied = first.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(applied.isError, false, `the same plan must apply: ${textOf(applied)}`);
  assert.match(textOf(applied), /^Applied/);
  const planned = Number(textOf(dryRun).match(/(\d+) entr(?:y|ies) changed/)[1]);
  assert.equal(first.entries.filter(entry => entry.type === "context_edit").length, planned, "apply must persist exactly the previewed plan");
  assert.ok(first.contextAfterEdit.some(message => message.role === "user" && textOf(message) === "APPLIED-LATER"));
  assert.deepEqual(first.contextAfterEdit.find(message => message.role === "assistant" && message.content.some(block => block.id === fork.creation.id))?.content, fork.entries.find(entry => entry.id === fork.inherited).message.content);
  assert.ok(!first.entries.some(entry => entry.message?.toolCallId === fork.creation.id), "no result may be fabricated for the inherited call");
  const second = runOperations(fork, [{ restore: fork.user }]);
  const restored = second.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(restored.isError, false, `restoring the unrelated edit must apply: ${textOf(restored)}`);
  assertOriginalsRestored(fork);
});

test("dropThinking leaves the inherited call untouched and restores the changed entry exactly", () => {
  const fork = forkedSession();
  const operations = [{ dropThinking: { before: fork.boundary, except: [fork.inherited] } }];
  const preview = runOperations(fork, operations, { dryRun: true });
  const previewReport = preview.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(previewReport.isError, false, `an unrelated thinking drop must preview: ${textOf(previewReport)}`);
  assert.ok(!preview.entries.some(entry => entry.type === "context_edit"), "the dry run must persist no edits");
  const applied = runOperations(fork, operations);
  const report = applied.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(report.isError, false, `the thinking drop must apply: ${textOf(report)}`);
  const changed = SessionManager.open(fork.session).buildSessionProjection().entries.find(entry => entry.sourceEntry.id === fork.assistant);
  assert.deepEqual(changed.messages[0].content.map(block => block.type), ["toolCall"]);
  const restored = runOperations(fork, [{ restore: fork.assistant }]);
  assert.match(textOf(restored.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assertOriginalsRestored(fork);
});

test("range restore trails survive reload beside the inherited unmatched call", () => {
  const fork = forkedSession();
  const folded = runOperations(fork, [{ foldRange: { from: fork.user, to: fork.result, note: "CHILD-RANGE" } }]);
  assert.match(textOf(folded.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assert.ok(folded.contextAfterEdit.some(message => textOf(message) === "CHILD-RANGE"));
  assert.ok(!SessionManager.open(fork.session).buildSessionProjection().entries.find(entry => entry.sourceEntry.id === fork.result).messages.length);
  const member = runOperations(fork, [{ restore: fork.result }]);
  assert.match(textOf(member.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assert.ok(member.contextAfterEdit.some(message => textOf(message) === "CHILD-RANGE"), "restoring a member must keep the holder's note");
  const holder = runOperations(fork, [{ restore: fork.user }]);
  assert.match(textOf(holder.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assertOriginalsRestored(fork);
});

test("restoring a fold over the inherited call brings its original unmatched form back after reload", () => {
  const fork = forkedSession();
  const folded = runOperations(fork, [{ foldRange: { from: fork.parentUser, to: fork.inherited, note: "PARENT-SNAPSHOT" } }]);
  assert.match(textOf(folded.contextAfterEdit.findLast(message => message.role === "toolResult")), /^Applied/);
  assert.ok(!SessionManager.open(fork.session).buildSessionProjection().entries.find(entry => entry.sourceEntry.id === fork.inherited).messages.length);
  const restored = runOperations(fork, [{ restore: fork.parentUser }]);
  const report = restored.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(report.isError, false, `the original inherited snapshot must restore: ${textOf(report)}`);
  assertOriginalsRestored(fork);
});

for (const reuseCallId of [false, true]) {
  for (const dryRun of [true, false]) {
    test(`a pre-existing orphan never excuses a newly missing result (dryRun=${dryRun}, reused ID=${reuseCallId})`, () => {
      const fork = forkedSession({ reuseCallId });
      const run = runOperations(fork, [{ foldRange: { from: fork.result, to: fork.boundary, note: "NOT-SAFE" } }], { dryRun });
      const refusal = run.contextAfterEdit.findLast(message => message.role === "toolResult");
      assert.equal(refusal.isError, true, `a newly broken pair must be refused: ${textOf(refusal)}`);
      assert.match(textOf(refusal), new RegExp(`call ${fork.assistant}\\.c0 would lose its result`));
      assert.ok(!run.entries.some(entry => entry.type === "context_edit"), "a refusal must persist no edit");
      assertOriginalsRestored(fork);
    });
  }
}

test("an originally unmatched call that is now paired must not lose its current result", () => {
  const fork = forkedSession({ reuseCallId: true });
  const manager = SessionManager.open(fork.session);
  manager.appendContextEdit(fork.assistant, null);
  const before = readFileSync(fork.session);
  const run = runOperations(fork, [{ foldRange: { from: fork.result, to: fork.boundary, note: "NOT-SAFE" } }]);
  const refusal = run.contextAfterEdit.findLast(message => message.role === "toolResult");
  assert.equal(refusal.isError, true, `a currently paired call cannot be excused by its original state: ${textOf(refusal)}`);
  assert.match(textOf(refusal), new RegExp(`call ${fork.inherited}\\.c0 would lose its result`));
  assert.equal(run.entries.filter(entry => entry.type === "context_edit").length, 1, "the refused edit must add nothing to the native prior edit");
  assert.ok(readFileSync(fork.session).subarray(0, before.length).equals(before));
});

for (const dryRun of [true, false]) {
  test(`a pre-existing orphan never excuses a newly missing call (dryRun=${dryRun})`, () => {
    const fork = forkedSession();
    const run = runOperations(fork, [{ id: fork.assistant, replacement: "NOT-SAFE" }], { dryRun });
    const refusal = run.contextAfterEdit.findLast(message => message.role === "toolResult");
    assert.equal(refusal.isError, true, `a stranded result must be refused: ${textOf(refusal)}`);
    assert.match(textOf(refusal), new RegExp(`result ${fork.result} would lose its call`));
    assert.ok(!run.entries.some(entry => entry.type === "context_edit"), "a refusal must persist no edit");
    assertOriginalsRestored(fork);
  });
}
