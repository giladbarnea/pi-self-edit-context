// A deterministic stand-in for the model. It acts like an agent that edits its own context:
// it reads the outline, picks targets by role and text, edits them, then records what it sees next.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
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
/** Deterministic random numbers, so a failing monkey run replays from its seed. */
function seededRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

type Observation = { order: string[]; roles: Map<string, string>; edited: string[]; blocks: { id: string; kind: string }[]; removed: string[] };

/** Parse the last outline ({minTokens: 0}) and removed-entries list the monkey asked for. */
function observe(messages: any[]): Observation {
	const [outlineText, removedText] = messages.filter((message) => message.role === "toolResult").slice(-2).map((message) => message.content[0].text as string);
	const observation: Observation = { order: [], roles: new Map(), edited: [], blocks: [], removed: [] };
	for (const line of outlineText.split("\n")) {
		const block = line.match(/^\s*- ([0-9a-f]{8}\.[a-z]\d+) (\w+)/);
		if (block) {
			observation.blocks.push({ id: block[1], kind: block[2] });
			continue;
		}
		const entry = line.match(/^\s*- ([0-9a-f]{8}) (\w+)/);
		if (!entry) continue;
		observation.order.push(entry[1]);
		observation.roles.set(entry[1], entry[2]);
		if (/, edited(:|$)/.test(line)) observation.edited.push(entry[1]);
	}
	for (const line of removedText.split("\n")) {
		const entry = line.match(/^- ([0-9a-f]{8}) /);
		if (entry) observation.removed.push(entry[1]);
	}
	return observation;
}

function createMonkey(seed: number, acts: number): ScriptStep {
	const random = seededRandom(seed);
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
	let next: "observe" | "act" | "after-act" | "final-observe" | "restore-all" | "finish" = "observe";
	let actCount = 0;
	let noteCount = 0;
	const note = () => `NOTE-${seed}-${++noteCount}`;
	// Like an agent remembering IDs from earlier outlines: every ID ever seen, used instead of the current ones 30% of the time.
	const remembered: Observation = { order: [], roles: new Map(), edited: [], blocks: [], removed: [] };
	const foldedEntries = new Set<string>();
	const foldedBlocks = new Set<string>();
	const trackFold = (operation: { fold: string; note: string }) => {
		foldedEntries.add(operation.fold.split(".")[0]);
		foldedBlocks.add(operation.fold);
		return operation;
	};
	const remember = (seen: Observation): void => {
		for (const id of seen.order) if (!remembered.roles.has(id)) (remembered.order.push(id), remembered.roles.set(id, seen.roles.get(id)!));
		for (const block of seen.blocks) if (!remembered.blocks.some((known) => known.id === block.id)) remembered.blocks.push(block);
		remembered.removed = [...new Set([...remembered.removed, ...seen.removed])];
		remembered.edited = [...new Set([...remembered.edited, ...seen.edited])];
	};

	const work = () => {
		const content: any[] = [];
		if (random() < 0.6) content.push(signedThinking(`THINK-${seed}-${++noteCount}`));
		if (random() < 0.4) content.push(fauxText(`TEXT-${seed}-${++noteCount}`));
		content.push(readNull());
		if (random() < 0.7) content.push(readNull());
		if (random() < 0.4) content.push(readNull());
		return fauxAssistantMessage(content);
	};
	const observeCalls = () => fauxAssistantMessage([fauxToolCall("context_outline", { minTokens: 0 }), fauxToolCall("context_outline", { removed: true })]);

	const randomOperation = (seen: Observation): object => {
		const calls = seen.blocks.filter((block) => block.kind === "call").map((block) => block.id);
		const editableBlocks = seen.blocks.filter((block) => block.kind !== "call").map((block) => block.id);
		const kind = pick(["fold", "fold", "refold", "refold", "foldRange", "restore", "restore", "dropThinking", "block", "entry"]);
		// Return to an entry folded before and fold another of its calls, by an ID remembered from an older outline.
		const refoldable = remembered.blocks.filter((block) => block.kind === "call" && foldedEntries.has(block.id.split(".")[0]) && !foldedBlocks.has(block.id));
		if (kind === "refold" && refoldable.length > 0) return trackFold({ fold: pick(refoldable).id, note: note() });
		// Later calls in multi-call entries are where IDs from older outlines can drift; favor them.
		const laterCalls = calls.filter((id) => !id.endsWith(".c0"));
		if (kind === "fold" && calls.length > 0) return trackFold({ fold: laterCalls.length > 0 && random() < 0.6 ? pick(laterCalls) : pick(calls), note: note() });
		if (kind === "foldRange") {
			const start = Math.floor(random() * seen.order.length);
			const end = Math.min(seen.order.length - 1, start + Math.floor(random() * 6));
			return { foldRange: { from: seen.order[start], to: seen.order[end], note: note() } };
		}
		if (kind === "restore") {
			const pool = [...seen.removed, ...seen.edited];
			return { restore: pool.length > 0 && random() < 0.85 ? pick(pool) : pick(seen.order) };
		}
		if (kind === "dropThinking") {
			const except = editableBlocks.filter(() => random() < 0.2);
			return { dropThinking: { before: pick(seen.order), except } };
		}
		if (kind === "block" && editableBlocks.length > 0) return { id: pick(editableBlocks), replacement: random() < 0.5 ? null : note() };
		return { id: pick(seen.order), replacement: random() < 0.5 ? null : note() };
	};

	return (messages) => {
		recordContext(messages);
		switch (next) {
			case "observe":
				next = "act";
				return observeCalls();
			case "act": {
				const current = observe(messages);
				remember(current);
				const operations = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomOperation(random() < 0.3 ? remembered : current));
				actCount += 1;
				next = "after-act";
				return fauxAssistantMessage(fauxToolCall("edit_context", { operations, ...(random() < 0.3 ? { dryRun: true } : {}) }));
			}
			case "after-act": {
				const plan = (messages.findLast((message) => message.role === "toolResult").content[0].text as string).match(/"apply": "(plan-\d+)"/);
				if (plan && random() < 0.6) return fauxAssistantMessage(fauxToolCall("edit_context", { apply: plan[1] }));
				const done = actCount >= acts;
				if (random() < 0.35) {
					next = done ? "final-observe" : "observe";
					return work();
				}
				next = done ? "restore-all" : "act";
				return observeCalls();
			}
			case "final-observe":
				next = "restore-all";
				return observeCalls();
			case "restore-all": {
				const seen = observe(messages);
				const ids = [...new Set([...seen.removed, ...seen.edited])];
				next = "finish";
				if (ids.length === 0) return work();
				return fauxAssistantMessage(fauxToolCall("edit_context", { operations: ids.map((id) => ({ restore: id })) }));
			}
			case "finish":
				return fauxAssistantMessage("done");
		}
	};
}

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
			const note = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.text?.includes("result folded"));
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
	"outline-trail": [
		() => fauxAssistantMessage(readNull()),
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const [readA] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${readA}.c0`, note: "A-NOTE" }] }));
		},
		outline,
		(messages) => {
			const [, readB] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${readB}.c0`, note: "B-NOTE" }] }));
		},
		(messages) => {
			recordContext(messages);
			const notes = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).filter((block) => block.text?.includes("result folded"));
			const restore = JSON.parse(notes.at(-1).text.match(/\{"restore": "\w+"\}/)[0]);
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [restore] }));
		},
		(messages) => {
			recordContext(messages);
			const foldA = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.arguments?.operations?.[0]?.note === "A-NOTE");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: foldA.arguments.operations[0].fold.split(".")[0] }] }));
		},
		record,
	],
	"expensive-restore": [
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const [readA] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${readA}.c0`, note: "A-NOTE" }] }));
		},
		// About 25k estimated tokens after the restore point.
		() => fauxAssistantMessage([fauxText("x".repeat(100_000)), readNull()]),
		(messages) => {
			const foldA = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.arguments?.operations?.[0]?.note === "A-NOTE");
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: foldA.arguments.operations[0].fold.split(".")[0] }] }));
		},
		record,
	],
	"restore-and-auto-fold-same-entry": [
		() => fauxAssistantMessage(readNull()),
		() => fauxAssistantMessage([fauxToolCall("context_outline", { minTokens: 0 }), fauxToolCall("context_outline", { removed: true })]),
		(messages) => {
			const ids = assistantEntryIds(messages.filter((message) => message.role === "toolResult").at(-2).content[0].text);
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${ids[1]}.c1`, note: "FOLD-OUTLINE-C1" }] }));
		},
		(messages) => {
			const fold = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.arguments?.operations?.[0]?.note === "FOLD-OUTLINE-C1");
			const outlineEntry = fold.arguments.operations[0].fold.split(".")[0];
			const outlineText = messages.find((message) => message.role === "toolResult" && /^\d+ entries shown/.test(message.content[0].text)).content[0].text;
			const [readA] = assistantEntryIds(outlineText);
			// The read comes first, so the batch's earliest change is before the two-call outline entry it restores.
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${readA}.c0`, note: "FOLD-A" }, { restore: outlineEntry }] }));
		},
		record,
	],
	"ordered-operations": [
		() => fauxAssistantMessage([readNull(), readNull()]),
		outline,
		(messages) => {
			const [reads] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${reads}.c0`, note: "N1" }] }));
		},
		(messages) => {
			const fold = messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((block) => block.arguments?.operations?.[0]?.note === "N1");
			const reads = fold.arguments.operations[0].fold.split(".")[0];
			// Restore the entry, then fold its second call: the fold must see the restored entry, not the starting one.
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: reads }, { fold: `${reads}.c1`, note: "N2" }] }));
		},
		record,
	],
	"restore-result-brings-call": [
		() => fauxAssistantMessage(readNull()),
		outline,
		(messages) => {
			const [readA] = assistantEntryIds(lastToolResultText(messages));
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ fold: `${readA}.c0`, note: "FOLD-A" }] }));
		},
		() => fauxAssistantMessage(fauxToolCall("context_outline", { removed: true })),
		(messages) => {
			const resultId = lastToolResultText(messages).match(/^- ([0-9a-f]{8}) toolResult/m)![1];
			return fauxAssistantMessage(fauxToolCall("edit_context", { operations: [{ restore: resultId }] }));
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

/** The faux provider estimates usage from characters; a script can instead report a fixed provider count, as a real provider would. */
const reportedPromptTokens = process.env.SCRIPTED_MODEL_PROMPT_TOKENS;

const monkeySeed = Number(process.env.SCRIPTED_MODEL_SEED ?? 0);
const monkeyActs = Number(process.env.SCRIPTED_MODEL_ACTS ?? 40);
if (scriptName === "monkey") {
	const step = createMonkey(monkeySeed, monkeyActs);
	scripts.monkey = Array.from({ length: monkeyActs * 6 + 20 }, () => step);
}

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
