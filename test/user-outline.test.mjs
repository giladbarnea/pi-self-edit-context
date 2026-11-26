import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "./fixtures/run-agent.mjs";

function userOutline(prompt) {
	const { contextAfterEdit } = runAgent("default-outline", prompt);
	return contextAfterEdit.findLast((message) => message.role === "toolResult").content[0].text;
}

test("the user outline keeps the second bullet of an instruction", () => {
	const outline = userOutline("Please:\n- Describe what changed.\n- Do not publish the result.");
	assert.match(outline, / user, .*: Please:\n[^\n]*- Describe what changed\.\n[^\n]*- Do not publish the result\./);
});

test("the user outline keeps a whole line longer than 200 characters", () => {
	const prompt = `Explain ${"the details of ".repeat(18)}the second change.`;
	assert.ok(userOutline(prompt).includes(prompt), "the whole sentence should appear without an ellipsis");
});

/** A sampled gap: its inclusive character range and the context_read call that reads from its start. */
const GAP = /\n  \[characters (\d+)–(\d+) omitted; read them with context_read \{"id": "(\w+)", "offset": (\d+)\}\]\n  \| /;

function userPreview(outline) {
	const preview = outline.match(/^- \S+ user, [^\n]*? est\.(?:, edited)?: ([^\n]*(?:\n  [^\n]*)*)/m)?.[1];
	assert.notEqual(preview, undefined, "outline should have a user entry with text");
	return preview;
}

test("a user message exactly at the 4,000-unit cap is shown in full, but one unit more is elided", () => {
	const prompt = `Start${"x".repeat(3993)}🙂`;
	assert.ok(userOutline(prompt).includes(prompt), "text at the cap should appear in full, including the last emoji");
	assert.match(userOutline(`${prompt}!`), GAP, "the cap should apply immediately above 4,000 units");
});

test("a long paste keeps excerpts throughout the message within the rendered preview cap", () => {
	const lines = Array.from({ length: 100 }, (_, index) => `LINE-${String(index + 1).padStart(3, "0")}: ${"x".repeat(120)}`);
	const preview = userPreview(userOutline(lines.join("\n")));
	for (const line of [1, 30, 50, 70, 100]) {
		assert.ok(preview.includes(lines[line - 1]), `the preview should include a full line around position ${line}`);
	}
	assert.doesNotMatch(preview, /LINE-015:/, "intervals between excerpts should be omitted");
	assert.match(preview, GAP, "the gaps should be marked");
	assert.ok(preview.length <= 4000, `preview including markers and line prefixes is ${preview.length} units`);
});

test("a paste of mostly blank lines counts the quote prefixes against the preview cap", () => {
	const preview = userPreview(userOutline(`Start\n${"\n".repeat(4999)}End`));
	assert.match(preview, /^Start\n/);
	assert.match(preview, /^  \| End$/m);
	assert.ok(preview.length <= 4000, `preview including prefixes is ${preview.length} units`);
});

test("a large single line keeps both ends and no split emoji, including at its tight cap", () => {
	const preview = userPreview(userOutline(`Start ${"🙂".repeat(3000)} End`));
	assert.match(preview, /^Start 🙂/);
	assert.match(preview, /🙂 End/);
	assert.ok(preview.isWellFormed(), "the sampled cuts must not split emoji");
	assert.ok(preview.length <= 4000, `preview including markers is ${preview.length} units`);
	assert.match(preview, GAP);
});

test("every sampled gap names its exact start in the reader's characters, and its call reads from there", () => {
	const prompt = `Start of paste 🙂🙂🙂\n${"H".repeat(1984)}🙂\nMIDDLE\n${"m".repeat(3989)}🙂${"T".repeat(1986)}\nEnd of paste`;
	const characters = [...prompt];
	const { contextAfterEdit, entries } = runAgent("user-outline-gaps", prompt);
	const [broad, sameUser, stretch] = contextAfterEdit.filter((message) => message.role === "toolResult" && message.toolName === "context_outline");
	const page = contextAfterEdit.find((message) => message.role === "toolResult" && message.toolName === "context_read");
	const user = entries.find((entry) => entry.message?.role === "user").id;
	const read = entries.find((entry) => entry.message?.role === "assistant").id;
	const result = entries.find((entry) => entry.message?.toolName === "read").id;
	const sampled = userPreview(broad.content[0].text);
	assert.equal(userPreview(sameUser.content[0].text), sampled, "from and to on one user entry select that entry, with the same preview");
	assert.equal(userPreview(stretch.content[0].text), sampled, "a multi-entry stretch must keep the same capped preview");
	assert.match(sampled, /^Start of paste 🙂🙂🙂\n  \| /);
	assert.match(sampled, /^  \| End of paste$/m);
	assert.ok(sampled.length <= 4000 && sampled.isWellFormed(), "the oversized multiline preview should be bounded and Unicode-safe");

	const pieces = sampled.split(GAP);
	const gaps = [];
	let cursor = 0;
	for (let index = 0; index < pieces.length; index += 5) {
		const excerpt = [...pieces[index].replaceAll("\n  | ", "\n")];
		assert.equal(excerpt.join(""), characters.slice(cursor, cursor + excerpt.length).join(""), `the excerpt at character ${cursor} should be the message's own text`);
		cursor += excerpt.length;
		if (index + 1 >= pieces.length) break;
		const [start, end, id, offset] = pieces.slice(index + 1, index + 5);
		assert.deepEqual({ start: Number(start), id, offset: Number(offset) }, { start: cursor, id: user, offset: cursor }, "a gap should start where the excerpt before it ends, and its call should read from there");
		gaps.push(cursor);
		cursor = Number(end) + 1;
	}
	assert.equal(cursor, characters.length, "the last excerpt should end the message");
	assert.ok(gaps.length >= 2, `the preview should sample across the message: ${gaps}`);

	const stretchLines = stretch.content[0].text.split("\n");
	const call = stretchLines.findIndex((line) => line.startsWith(`  - ${read}.c0 call, `));
	assert.ok(call >= 0 && stretchLines[call + 1]?.startsWith(`    - ${result} result, `), "the read result should still be nested under its call");
	const end = Math.min(gaps[0] + 4000, characters.length) - 1;
	const next = end + 1 < characters.length ? `\nNext offset: ${end + 1}` : "";
	assert.equal(page?.content[0].text, `Message ${user} — characters ${gaps[0]}–${end} of ${characters.length}${next}\n\n${characters.slice(gaps[0], end + 1).join("")}`, "the first gap's call should read the exact text it skipped");
});
