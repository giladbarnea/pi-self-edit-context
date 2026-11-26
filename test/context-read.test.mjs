import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "./fixtures/run-agent.mjs";

const PAGE = 4000;
const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));
const messageEntries = (entries, role) => entries.filter((entry) => entry.type === "message" && entry.message.role === role);

/** Each context_read call the agent made, in order, with its arguments and stored result. */
function readCalls(entries) {
	const results = messageEntries(entries, "toolResult");
	return messageEntries(entries, "assistant").flatMap((entry) =>
		entry.message.content
			.filter((block) => block.type === "toolCall" && block.name === "context_read")
			.map((block) => ({ entry, block, arguments: block.arguments, result: results.find((result) => result.message.toolCallId === block.id)?.message })),
	);
}

/** The page context_read must return, from the contract: a header with the inclusive character range, a next offset while text remains, a blank line, then the exact text. */
function expectedPage(id, characters, start) {
	const end = Math.min(start + PAGE, characters.length) - 1;
	const next = end + 1 < characters.length ? `\nNext offset: ${end + 1}` : "";
	return `Message ${id} — characters ${start}–${end} of ${characters.length}${next}\n\n${characters.slice(start, end + 1).join("")}`;
}

test("context_read returns a short user message whole, in one page", () => {
	const prompt = "Short request: 🙂 done";
	const { entries } = runAgent("context-read-short", prompt);
	const [read] = readCalls(entries);
	assert.equal(read.result?.isError, false, `the read should succeed: ${read.result && textOf(read.result)}`);
	assert.equal(textOf(read.result), expectedPage(messageEntries(entries, "user")[0].id, [...prompt], 0));
});

test("context_read pages through a long Unicode message in exact, bounded, contiguous character pages", () => {
	const prompt = `Start of paste\n${"🙂".repeat(3000)}\nMIDDLE ${"m".repeat(5000)}\n${"e\u0301".repeat(100)}End of paste`;
	const characters = [...prompt];
	const { entries } = runAgent("context-read-pages", prompt);
	const user = messageEntries(entries, "user")[0].id;
	const pages = readCalls(entries).filter((read) => read.arguments.id === user && read.result && !read.result.isError);
	const starts = Array.from({ length: Math.ceil(characters.length / PAGE) }, (_, index) => index * PAGE);
	assert.deepEqual(pages.map((read) => read.arguments.offset ?? 0), starts, "the agent should read from the default start, then follow each next offset");
	pages.forEach((read, index) => assert.equal(textOf(read.result), expectedPage(user, characters, starts[index]), `page ${index + 1}`));
	assert.equal(pages.map((read) => textOf(read.result).split("\n\n").slice(1).join("\n\n")).join(""), prompt, "the pages should reconstruct the message exactly");
});

test("context_read refuses invalid offsets, entries that are not user messages, unknown IDs and removed entries", () => {
	const prompt = `Start ${"x".repeat(5000)} End`;
	const { entries } = runAgent("context-read-pages", prompt);
	const user = messageEntries(entries, "user")[0].id;
	const [read] = messageEntries(entries, "assistant");
	const readResult = messageEntries(entries, "toolResult")[0].id;
	const refusals = readCalls(entries).filter((call) => call.result?.isError);
	const refusal = (id, offset) => refusals.find((call) => call.arguments.id === id && call.arguments.offset === offset);
	const expected = [
		[user, 100_000_000, /offset/i],
		[user, -1, /offset/i],
		[user, 1.5, /offset/i],
		[read.id, undefined, /user message/],
		["0000beef", undefined, /not an entry/],
	];
	for (const [id, offset, reason] of expected) {
		const call = refusal(id, offset);
		assert.ok(call, `context_read ${JSON.stringify({ id, offset })} should be refused; results: ${readCalls(entries).map((candidate) => `${JSON.stringify(candidate.arguments)} → ${candidate.result && textOf(candidate.result).slice(0, 80)}`).join(" | ")}`);
		assert.match(textOf(call.result), reason, `refusal of ${JSON.stringify({ id, offset })}`);
	}
	const resultReads = refusals.filter((call) => call.arguments.id === readResult).map((call) => textOf(call.result));
	assert.equal(resultReads.length, 2, `the tool result should be refused while present and after its removal: ${resultReads}`);
	assert.match(resultReads[0], /user message/, "a present tool result is not a user message");
	assert.match(resultReads[1], /removed by edits/, "a removed entry should be refused as removed");
	const batch = entries.findIndex((entry) => entry.message?.toolName === "edit_context");
	const afterBatch = entries.findIndex((entry, index) => index > batch && entry.type === "message");
	assert.ok(entries.every((entry, index) => entry.type !== "context_edit" || (batch < index && index < afterBatch)), "only the agent's edit_context batch should edit the context, not a refused read");
});

test("applying edits folds earlier reads after the earliest change into a short note, leaves earlier ones, and restore brings them back", () => {
	const prompt = "ORIGINAL-REQUEST: read me in pages";
	const characters = [...prompt];
	const { contexts, contextAfterEdit, entries } = runAgent("context-read-folds", prompt);
	const user = messageEntries(entries, "user")[0].id;
	const [firstOutline, earlyRead, fileRead, lateRead, secondOutline] = messageEntries(entries, "assistant");
	const resultOf = (call) => messageEntries(entries, "toolResult").find((result) => result.message.toolCallId === call.message.content[0].id);
	const report = textOf(messageEntries(entries, "toolResult").find((result) => result.message.toolName === "edit_context").message);
	assert.match(report, new RegExp(`Earliest change: ${fileRead.id},`), `report: ${report}`);
	assert.match(report, new RegExp(`Also folds 1 earlier outline and 1 earlier read after the earliest change \\(${secondOutline.id}\\.c0, ${lateRead.id}\\.c0\\)`), `report: ${report}`);
	assert.match(report, new RegExp(`Left in place, before the earliest change: outline ${firstOutline.id}\\.c0 \\(~\\d+ est\\.\\), read ${earlyRead.id}\\.c0 \\(~\\d+ est\\.\\)`), `report: ${report}`);

	const afterEdit = contexts[0];
	const hasResult = (context, call) => context.some((message) => message.role === "toolResult" && message.toolCallId === call.message.content[0].id);
	assert.ok(hasResult(afterEdit, earlyRead), "the read before the earliest change must stay, or the cache break moves earlier");
	assert.ok(!hasResult(afterEdit, lateRead), "the read after the earliest change should be folded");
	const note = `[Read message ${user}, characters 5–${characters.length - 1}. {"restore": "${lateRead.id}"} brings it back.]`;
	assert.ok(afterEdit.some((message) => message.role === "assistant" && JSON.stringify(message.content) === JSON.stringify([{ type: "text", text: note }])), `the late read should leave exactly its note: ${JSON.stringify(afterEdit.filter((message) => message.role === "assistant").map(textOf))}`);
	for (const context of [afterEdit, contextAfterEdit]) {
		const calls = context.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id) : []));
		const results = context.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
		assert.deepEqual(results, calls, "every call should keep its result, in order");
	}
	assert.equal(textOf(resultOf(lateRead).message), expectedPage(user, characters, 5), "the stored read keeps its original content");
	const restored = contextAfterEdit.find((message) => message.role === "toolResult" && message.toolCallId === lateRead.message.content[0].id);
	assert.deepEqual(restored?.content, resultOf(lateRead).message.content, "restoring the note's entry should bring the read back as stored");
});

test("the outline selects entry spans only, and the bounded reader is its own tool", () => {
	const { contextAfterEdit: tools } = runAgent("record-tool-descriptions", "anything");
	const outline = tools.find((tool) => tool.name === "context_outline");
	const reader = tools.find((tool) => tool.name === "context_read");
	assert.deepEqual(Object.keys(outline.parameters.properties), ["removed", "minTokens", "from", "to"], "the outline should take no text offset");
	assert.ok(!JSON.stringify(outline).includes("userTextOffset"), "no private offset hint should remain");
	assert.deepEqual(Object.keys(reader?.parameters.properties ?? {}), ["id", "offset"], `context_read should take an ID and an offset: ${JSON.stringify(reader)}`);
	assert.deepEqual(reader.parameters.required, ["id"]);
});
