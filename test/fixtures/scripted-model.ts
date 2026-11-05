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
	const line = outline.split("\n").find((candidate) => new RegExp(`^\\s*- \\S+ ${role}\\b`).test(candidate) && candidate.includes(textFragment));
	if (!line) throw new Error(`No ${role} line containing "${textFragment}" in outline:\n${outline}`);
	return line.trim().split(" ")[1];
}

function assistantEntryIds(outline: string): string[] {
	return outline.split("\n").flatMap((line) => line.match(/^- (\S+) assistant/)?.[1] ?? []);
}

function recordContext(messages: any[]): void {
	appendFileSync(logPath, JSON.stringify(messages.filter((message) => message.role !== "system")) + "\n");
}

function signedThinking(label: string) {
	return { ...fauxThinking(label + "t".repeat(400 - label.length)), thinkingSignature: "s".repeat(3600) };
}

const outline = () => fauxAssistantMessage(fauxToolCall("context_outline", {}));
const record: ScriptStep = (messages) => {
	recordContext(messages);
	return fauxAssistantMessage("done");
};

const scripts: Record<string, ScriptStep[]> = {
	"pirate-first-request": [
		outline,
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id, replacement: "Arr, PIRATE-REQUEST, matey" }] }));
		},
		record,
	],
	"outline-then-dry-run": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", {}), fauxToolCall("context_outline", {})]),
		outline,
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id, replacement: "short" }], dryRun: true }));
		},
		record,
	],
	"dry-run-then-apply": [
		outline,
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id, replacement: "APPLIED-LATER" }], dryRun: true }));
		},
		(messages) => {
			recordContext(messages);
			const planId = lastToolResultText(messages).match(/plan-\d+/)![0];
			return fauxAssistantMessage(fauxToolCall("edit_context", { apply: planId }));
		},
		record,
	],
	"drop-thinking": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", {})]),
		() => fauxAssistantMessage([signedThinking("THINK-B"), fauxToolCall("context_outline", {})]),
		() => fauxAssistantMessage([signedThinking("THINK-C"), fauxToolCall("context_outline", {})]),
		(messages) => {
			const [first, second, third] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ dropThinking: { before: third, except: [second] } }] }));
		},
		record,
	],
	"fold-call": [
		outline,
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${first}.c0`, note: "FOLDED-NOTE" }] }));
		},
		record,
	],
	"replace-thinking-block": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", {})]),
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id: `${first}.t0`, replacement: "SHORT-NOTE" }] }));
		},
		record,
	],
	"orphan-tool-results": [
		outline,
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "assistant", "");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id, replacement: null }] }));
		},
		record,
	],
};

export default function (pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "agent" }] });
	faux.setResponses(scripts[scriptName].map((step) => (context: any) => step(context.messages)));
	pi.registerProvider(faux.provider);
}
