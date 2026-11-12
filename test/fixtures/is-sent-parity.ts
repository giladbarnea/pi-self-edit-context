// At session start, compare the extension's isSent with pi-ai's transformMessages, the code it mirrors, over every block shape,
// and write the cases where they disagree to $PARITY_FILE. transformMessages is a dev dependency here, never a runtime import.
import { writeFileSync } from "node:fs";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSent } from "../../index.ts";

const model: any = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5", input: ["text", "image"] };
const writers = [
	{ provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" },
	{ provider: "anthropic", api: "anthropic-messages", model: "claude-haiku-5-5" },
	{ provider: "openai-codex", api: "openai-codex-responses", model: "gpt-6-astra" },
	{ provider: "anthropic", api: "other-api", model: "claude-opus-5-5" },
];
const blocks: any[] = [
	{ type: "thinking", thinking: "thought", thinkingSignature: "sig" }, { type: "thinking", thinking: "thought" }, { type: "thinking", thinking: "", thinkingSignature: "sig" },
	{ type: "thinking", thinking: "   " }, { type: "thinking", thinking: "" }, { type: "thinking" }, { type: "thinking", thinking: "", redacted: true },
	{ type: "text", text: "hello" }, { type: "text", text: "" }, { type: "text", text: "x", textSignature: "s" },
	{ type: "toolCall", id: "c1", name: "read", arguments: {} }, { type: "toolCall", id: "c1", name: "read", arguments: {}, thoughtSignature: "t" },
];

function differences(): { cases: number; differences: object[] } {
	const found: object[] = [];
	let cases = 0;
	for (const writer of writers) for (const stopReason of ["stop", "toolUse", "length", "error", "aborted"]) for (const block of blocks) {
		const message: any = { role: "assistant", ...writer, stopReason, content: [block] };
		const piSends = transformMessages([message], model).some((candidate: any) => candidate.role === "assistant" && candidate.content.length > 0);
		cases += 1;
		if (isSent(message, block, model) !== piSends) found.push({ writer: writer.model, api: writer.api, stopReason, block, piSends });
	}
	return { cases, differences: found };
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", () => writeFileSync(process.env.PARITY_FILE!, JSON.stringify(differences())));
}
