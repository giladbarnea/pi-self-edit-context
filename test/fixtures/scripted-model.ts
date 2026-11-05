// A deterministic stand-in for the model. It acts like an agent that edits its own context:
// it reads the outline, picks targets by role and text, edits them, then records what it sees next.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ScriptStep = (messages: any[]) => ReturnType<typeof fauxAssistantMessage>;

const logPath = process.env.SCRIPTED_MODEL_LOG!;
const scriptName = process.env.SCRIPTED_MODEL_SCRIPT!;

function lastToolResultText(messages: any[]): string {
	const result = messages.findLast((message) => message.role === "toolResult");
	return result.content.map((block: any) => block.text ?? "").join("\n");
}

function outlineId(outline: string, role: string, textFragment: string): string {
	const line = outline.split("\n").find((candidate) => candidate.includes(` ${role} `) && candidate.includes(textFragment));
	if (!line) throw new Error(`No ${role} line containing "${textFragment}" in outline:\n${outline}`);
	return line.split(" ")[0];
}

function recordContext(messages: any[]): void {
	appendFileSync(logPath, JSON.stringify(messages.filter((message) => message.role !== "system")) + "\n");
}

const scripts: Record<string, ScriptStep[]> = {
	"pirate-first-request": [
		() => fauxAssistantMessage(fauxToolCall("context_outline", {})),
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { edits: [{ id, replacement: "Arr, PIRATE-REQUEST, matey" }] }));
		},
		(messages) => {
			recordContext(messages);
			return fauxAssistantMessage("done");
		},
	],
	"outline-then-dry-run": [
		() => fauxAssistantMessage([fauxThinking("t".repeat(4000)), fauxToolCall("context_outline", {}), fauxToolCall("context_outline", {})]),
		() => fauxAssistantMessage(fauxToolCall("context_outline", {})),
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { edits: [{ id, replacement: "short" }], dryRun: true }));
		},
		(messages) => {
			recordContext(messages);
			return fauxAssistantMessage("done");
		},
	],
	"orphan-tool-results": [
		() => fauxAssistantMessage(fauxToolCall("context_outline", {})),
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "assistant", "context_outline");
			return fauxAssistantMessage(fauxToolCall("edit_context", { edits: [{ id, replacement: null }] }));
		},
		(messages) => {
			recordContext(messages);
			return fauxAssistantMessage("done");
		},
	],
};

export default function (pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "agent" }] });
	faux.setResponses(scripts[scriptName].map((step) => (context: any) => step(context.messages)));
	pi.registerProvider(faux.provider);
}
