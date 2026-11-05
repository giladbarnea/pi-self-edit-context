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

const readNull = () => fauxToolCall("read", { path: "/dev/null" });
const outline = () => fauxAssistantMessage(fauxToolCall("context_outline", { minTokens: 0 }));
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
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", { minTokens: 0 }), fauxToolCall("context_outline", { minTokens: 0 })]),
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
	"dry-run-breakdown": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", { minTokens: 0 })]),
		outline,
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			const latest = assistantEntryIds(lastToolResultText(messages)).at(-1)!;
			return fauxAssistantMessage(
				fauxToolCall("edit_context", { operations: [{ fold: `${first}.c0`, note: "n" }, { dropThinking: { before: latest } }], dryRun: true }),
			);
		},
		record,
	],
	"drop-thinking": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), readNull()]),
		() => fauxAssistantMessage([signedThinking("THINK-B"), readNull()]),
		() => fauxAssistantMessage([signedThinking("THINK-C"), fauxToolCall("context_outline", { minTokens: 0 })]),
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
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", { minTokens: 0 })]),
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ id: `${first}.t0`, replacement: "SHORT-NOTE" }] }));
		},
		record,
	],
	"stable-block-ids": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", { minTokens: 0 }), fauxToolCall("context_outline", { minTokens: 0 })]),
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${first}.c0`, note: "FOLD-A" }] }));
		},
		(messages) => {
			// Reuse the ID from the old outline instead of reading a new one.
			const oldOutline = messages.find((message) => message.role === "toolResult").content[0].text;
			const [first] = assistantEntryIds(oldOutline);
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${first}.c1`, note: "FOLD-B" }] }));
		},
		outline,
		record,
	],
	"fold-then-restore": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), fauxToolCall("context_outline", { minTokens: 0 })]),
		(messages) => {
			const [first] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${first}.c0`, note: "FOLD-A" }] }));
		},
		() => fauxAssistantMessage(fauxToolCall("context_outline", { removed: true })),
		(messages) => {
			recordContext(messages);
			// The fold removed the outline it read, so take the entry ID from its own earlier fold call.
			const foldCall = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.arguments?.operations?.[0]?.fold);
			const first = foldCall.arguments.operations[0].fold.split(".")[0];
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: first }] }));
		},
		outline,
		record,
	],
	"restore-unedited": [
		outline,
		(messages) => {
			const id = outlineId(lastToolResultText(messages), "user", "ORIGINAL-REQUEST");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: id }] }));
		},
		record,
	],
	"auto-fold-outlines": [
		outline,
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const ids = assistantEntryIds(lastToolResultText(messages));
			// ids: [early outline, read, late outline]; fold the read, which sits between the two outlines.
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${ids[1]}.c0`, note: "READ-NOTE" }] }));
		},
		(messages) => {
			recordContext(messages);
			const note = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.text?.includes("result folded when edits applied"));
			const restore = JSON.parse(note.text.match(/\{"restore": "\w+"\}/)[0]);
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [restore] }));
		},
		record,
	],
	"fold-range": [
		() => fauxAssistantMessage(readNull()),
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const ids = assistantEntryIds(lastToolResultText(messages));
			const secondReadResult = lastToolResultText(messages).split("\n").filter((line) => /^    - \S+ result/.test(line))[1].trim().split(" ")[1];
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ foldRange: { from: ids[0], to: secondReadResult, note: "RANGE-NOTE" } }] }));
		},
		record,
	],
	"fold-range-splits-exchange": [
		() => fauxAssistantMessage(readNull()),
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const ids = assistantEntryIds(lastToolResultText(messages));
			// Ends at the second read's call, leaving its result outside the range.
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ foldRange: { from: ids[0], to: ids[1], note: "RANGE-NOTE" } }] }));
		},
		record,
	],
	"default-outline": [
		() => fauxAssistantMessage([signedThinking("THINK-A"), readNull()]),
		() => fauxAssistantMessage(readNull()),
		() => fauxAssistantMessage(fauxToolCall("context_outline", {})),
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

/** The faux provider estimates usage from characters; a script can instead report a fixed provider count, as a real provider would. */
const reportedPromptTokens = process.env.SCRIPTED_MODEL_PROMPT_TOKENS;

export default function (pi: ExtensionAPI): void {
	if (reportedPromptTokens) {
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const usage = { ...event.message.usage, input: 0, cacheRead: Number(reportedPromptTokens), cacheWrite: 0 };
			return { message: { ...event.message, usage: { ...usage, totalTokens: usage.cacheRead + usage.output } } };
		});
	}
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "agent", contextWindow: 1_000_000 }] });
	faux.setResponses(scripts[scriptName].map((step) => (context: any) => step(context.messages)));
	pi.registerProvider(faux.provider);
}
