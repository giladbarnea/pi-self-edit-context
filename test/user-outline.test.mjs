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

test("a user message exactly at the 4,000-unit cap is shown in full, but one unit more is elided", () => {
	const prompt = `Start${"x".repeat(3993)}🙂`;
	assert.ok(userOutline(prompt).includes(prompt), "text at the cap should appear in full, including the last emoji");
	assert.match(userOutline(`${prompt}!`), /\[1 UTF-16 code unit elided;/, "the cap should apply immediately above 4,000 units");
});

test("broad outlines bound large user pastes, and their links page through the omitted text", () => {
	const head = `Start of paste\n${"H".repeat(1984)}`;
	const middle = `🙂\nMIDDLE\n${"m".repeat(3989)}`;
	const tail = `${"T".repeat(1986)}\nEnd of paste`;
	const { contextAfterEdit, entries } = runAgent("user-outline-pages", head + middle + "🙂" + tail);
	const [broad, stretch, refused, firstPage, lastPage] = contextAfterEdit.filter((message) => message.role === "toolResult" && message.toolName === "context_outline");
	const user = entries.find((entry) => entry.message?.role === "user").id;
	const read = entries.find((entry) => entry.message?.role === "assistant").id;
	const result = entries.find((entry) => entry.message?.toolName === "read").id;
	const firstLink = `context_outline {"from": "${user}", "to": "${user}", "userTextOffset": 1999}`;
	const nextLink = `context_outline {"from": "${user}", "to": "${user}", "userTextOffset": 5998}`;

	for (const [label, message] of [["whole context", broad], ["multi-entry stretch", stretch]]) {
		const text = message.content[0].text;
		assert.ok(text.includes(`Start of paste\n  | ${"H".repeat(1984)}\n`), `${label} should show the head up to, but not splitting, the emoji`);
		assert.match(text, /^  \| End of paste$/m, `${label} should show the last line`);
		assert.ok(text.includes("4001 UTF-16 code units elided") && text.includes(firstLink), `${label} should state how much is missing and link to its start`);
		assert.ok(!text.includes("MIDDLE") && text.isWellFormed(), `${label} should omit the middle without splitting Unicode code points`);
	}
	const stretchLines = stretch.content[0].text.split("\n");
	const call = stretchLines.findIndex((line) => line.startsWith(`  - ${read}.c0 call, `));
	assert.ok(call >= 0 && stretchLines[call + 1]?.startsWith(`    - ${result} result, `), "the read result should still be nested under its call");
	assert.equal(refused.isError, true, "a text offset must not apply to a multi-entry stretch");

	assert.ok(firstPage, "following the preview link should return a page");
	const first = firstPage.content[0].text;
	assert.ok(first.includes(`🙂\n  | MIDDLE\n  | ${"m".repeat(3989)}\n`) && first.includes(nextLink), "the first page should give the missing middle and a bounded continuation before the next emoji");
	assert.ok(!first.includes("End of paste") && first.isWellFormed(), "the targeted page should be bounded too, without splitting the next emoji");
	assert.ok(lastPage, "following the page link should return the rest");
	const last = lastPage.content[0].text;
	assert.ok(last.includes(`🙂${"T".repeat(1986)}\n  | End of paste`), "the last page should start with the intact emoji and reach the end of the paste");
	assert.ok(!last.includes("userTextOffset") && last.isWellFormed(), "the last page should not offer a meaningless continuation");
});
