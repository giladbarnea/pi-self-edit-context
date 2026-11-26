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

function userPreview(outline) {
	const preview = outline.match(/^- \S+ user, [^\n]*? est\.(?:, edited)?: ([^\n]*(?:\n  [^\n]*)*)/m)?.[1];
	assert.notEqual(preview, undefined, "outline should have a user entry with text");
	return preview;
}

test("a user message exactly at the 4,000-unit cap is shown in full, but one unit more is elided", () => {
	const prompt = `Start${"x".repeat(3993)}🙂`;
	assert.ok(userOutline(prompt).includes(prompt), "text at the cap should appear in full, including the last emoji");
	assert.match(userOutline(`${prompt}!`), /UTF-16 code units elided/, "the cap should apply immediately above 4,000 units");
});

test("a long paste keeps excerpts throughout the message within the rendered preview cap", () => {
	const lines = Array.from({ length: 100 }, (_, index) => `LINE-${String(index + 1).padStart(3, "0")}: ${"x".repeat(120)}`);
	const preview = userPreview(userOutline(lines.join("\n")));
	for (const line of [1, 30, 50, 70, 100]) {
		assert.ok(preview.includes(lines[line - 1]), `the preview should include a full line around position ${line}`);
	}
	assert.doesNotMatch(preview, /LINE-015:/, "intervals between excerpts should be omitted");
	assert.match(preview, /\[\d+ UTF-16 code units elided\]/, "the gaps should be marked");
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
	assert.match(preview, /\[\d+ UTF-16 code units elided\]/);
});

test("broad outlines bound large user pastes, and their links page through the omitted text", () => {
	const head = `Start of paste\n${"H".repeat(1984)}`;
	const middle = `🙂\nMIDDLE\n${"m".repeat(3989)}`;
	const tail = `${"T".repeat(1986)}\nEnd of paste`;
	const prompt = head + middle + "🙂" + tail;
	const { contextAfterEdit, entries } = runAgent("user-outline-pages", prompt);
	const [broad, stretch, refused, firstPage, lastPage] = contextAfterEdit.filter((message) => message.role === "toolResult" && message.toolName === "context_outline");
	const user = entries.find((entry) => entry.message?.role === "user").id;
	const read = entries.find((entry) => entry.message?.role === "assistant").id;
	const result = entries.find((entry) => entry.message?.toolName === "read").id;
	const linkedOffset = (preview) => Number(preview.match(new RegExp(`context_outline \\{"from": "${user}", "to": "${user}", "userTextOffset": (\\d+)\\}`))?.[1]);
	const unquote = (text) => text.replaceAll("\n  | ", "\n");
	const sampled = userPreview(broad.content[0].text);
	assert.equal(userPreview(stretch.content[0].text), sampled, "a multi-entry stretch must keep the same capped preview");
	assert.match(sampled, /^Start of paste\n  \| /);
	assert.match(sampled, /^  \| End of paste$/m);
	assert.ok(sampled.length <= 4000 && sampled.isWellFormed(), "the oversized multiline preview should be bounded and Unicode-safe");
	const prefix = unquote(sampled.split(/\n  \[\d+ UTF-16 code units elided\]/)[0]);
	assert.equal(linkedOffset(sampled), prefix.length, "the link must start at the first omitted character");
	const stretchLines = stretch.content[0].text.split("\n");
	const call = stretchLines.findIndex((line) => line.startsWith(`  - ${read}.c0 call, `));
	assert.ok(call >= 0 && stretchLines[call + 1]?.startsWith(`    - ${result} result, `), "the read result should still be nested under its call");
	assert.equal(refused.isError, true, "a text offset must not apply to a multi-entry stretch");

	assert.ok(firstPage && lastPage, "the preview link and its continuation should each return a page");
	const first = userPreview(firstPage.content[0].text);
	const firstChunk = unquote(first.split("\n  [More user text:")[0]);
	const last = userPreview(lastPage.content[0].text);
	const lastChunk = unquote(last);
	assert.equal(linkedOffset(first), prefix.length + firstChunk.length, "a continuation must start after the previous page without a gap");
	assert.ok(firstChunk.length <= 4000 && lastChunk.length <= 4000, "the exact pages must remain bounded");
	assert.ok(firstChunk.isWellFormed() && lastChunk.isWellFormed(), "exact paging must not split emoji");
	assert.ok(!last.includes("userTextOffset"), "the last page needs no continuation");
	assert.equal(prefix + firstChunk + lastChunk, prompt, "the exact pages must recover every unit beyond the retained prefix");
});
