// A synthetic session shaped like a real GPT→Claude session (issue 2): ten openai-codex turns whose thinking blocks carry
// JSON reasoning items of about 8.6K characters, text blocks with textSignature, tool calls with results, then a model
// change. The content is deterministic filler, so two builds differ only where asked.
import { writeFileSync } from "node:fs";

export const GPT_MODEL = { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-6-astra" };
export const GPT_TURNS = 10;
/** Thinking blocks per GPT turn: one before the tool call, one before the answer. */
export const GPT_THINKING_BLOCKS = GPT_TURNS * 2;

const filler = (length, seed) => Array.from({ length }, (_, index) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(index * 31 + seed * 7) % 64]).join("");

const reasoningItem = (summary, seed) =>
	JSON.stringify({ type: "reasoning", id: `rs_${filler(50, seed)}`, summary: [{ type: "summary_text", text: summary }], content: [], encrypted_content: `gAAAAAB${filler(8_400, seed)}` });

/** Write the session; `signatures: false` empties every GPT thinkingSignature and changes nothing else. Returns the signature characters written. */
export function writeCrossModelSession(path, { signatures }) {
	let clock = Date.parse("2026-11-08T10:00:00.000Z");
	const time = () => new Date((clock += 1000)).toISOString();
	let parentId = null;
	let counter = 0;
	let signatureCharacters = 0;
	const entries = [{ type: "session", version: 3, id: "01a1bc00-0000-7000-8000-000000000001", timestamp: time(), cwd: "/tmp" }];
	const push = (entry) => {
		const id = `e${String(++counter).padStart(7, "0")}`;
		entries.push({ ...entry, id, parentId, timestamp: time() });
		parentId = id;
	};
	const usage = (input) => ({ input, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	const thinking = (summary) => {
		const thinkingSignature = signatures ? reasoningItem(summary, counter) : "";
		signatureCharacters += thinkingSignature.length;
		return { type: "thinking", thinking: summary, thinkingSignature };
	};
	const gptMessage = (content, stopReason) => ({
		role: "assistant", ...GPT_MODEL, content, usage: usage(1_000 + counter * 50), stopReason, rawStopReason: "completed",
		thinkingLevel: "high", durationMs: 4_000, responseId: `resp_${filler(50, counter)}`, timestamp: clock,
	});
	const user = (text) => push({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: clock } });

	push({ type: "model_change", provider: GPT_MODEL.provider, modelId: GPT_MODEL.model });
	push({ type: "thinking_level_change", thinkingLevel: "high" });
	for (let index = 1; index <= GPT_TURNS; index++) {
		user(`Question ${index}: list the files in /tmp/example-${index}.`);
		const callId = `call_${filler(32, index)}|fc_${filler(50, index)}`;
		push({ type: "message", message: gptMessage([thinking(`**Listing example ${index}**`), { type: "toolCall", id: callId, name: "bash", arguments: { command: `ls /tmp/example-${index}` } }], "toolUse") });
		push({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "a.txt\nb.txt\nc.txt" }], isError: false, timestamp: clock } });
		push({ type: "message", message: gptMessage([thinking(`**Answering example ${index}**`), { type: "text", text: `/tmp/example-${index} holds a.txt, b.txt and c.txt.`, textSignature: JSON.stringify({ v: 1, id: `msg_${filler(50, index)}`, phase: "final_answer" }) }], "stop") });
	}
	push({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-5-5" });
	user("Now continue on Claude.");
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return signatureCharacters;
}
