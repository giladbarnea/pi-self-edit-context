import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	estimateTokens,
	type ContextEditableContent,
	type ContextEditEntry,
	type ExtensionAPI,
	type ReadonlySessionManager,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "@earendil-works/pi-coding-agent";

type ContextEdit = { targetId: string; replacement: ContextEditEntry["replacement"] };
type ProjectedEntry = SessionProjection["entries"][number];
type Block = any;
type Operation =
	| { id: string; replacement: string | null }
	| { fold: string; note: string }
	| { dropThinking: { before: string; except?: string[] } }
	| { restore: string };

const USER_ROLES = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
const PREVIEW_CHARACTERS = 200;
const BLOCK_KIND_LETTERS: Record<string, string> = { thinking: "t", text: "x", toolCall: "c" };
const EMPTIED_ASSISTANT_TEXT = "[thinking removed]";

/** Edits queued this turn. Pi persists them at the turn boundary, before the next request. */
const pendingEditsBySession = new Map<string, ContextEdit[]>();
/** Dry-run plans the agent can apply by ID without resending them. They live in memory, so a reload clears them. */
const plansById = new Map<string, { sessionId: string; edits: ContextEdit[]; breakdown: string }>();
let planCount = 0;

function isEditable(entry: SessionEntry): boolean {
	return entry.type === "custom_message" || (entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

/** @example formatTokens(950) === "950"; formatTokens(4123) === "4.1k" */
function formatTokens(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/** @example previewOf("first line\nsecond") === "first line"; previewOf("a".repeat(150) + "b".repeat(150)) === "a".repeat(98) + "[…]" + "b".repeat(99) */
function previewOf(text: string): string {
	const firstLine = text.trim().split("\n")[0];
	if (firstLine.length <= PREVIEW_CHARACTERS) return firstLine;
	const kept = (PREVIEW_CHARACTERS - "[…]".length) / 2;
	return `${firstLine.slice(0, Math.floor(kept))}[…]${firstLine.slice(-Math.ceil(kept))}`;
}

/** Estimated tokens of one content block, signatures included, at Pi's four characters per token. */
function blockTokens(block: Block): number {
	if (block.type === "thinking") return Math.ceil(((block.thinking?.length ?? 0) + (block.thinkingSignature?.length ?? 0)) / 4);
	if (block.type === "toolCall") return Math.ceil((block.name.length + JSON.stringify(block.arguments).length) / 4);
	return Math.ceil((block.text?.length ?? 0) / 4);
}

/** Assistant entries are the sum of their blocks, so an entry's size always equals its lines in the outline. */
function entryTokens({ messages }: ProjectedEntry): number {
	return messages.reduce((total, message) => {
		if (message.role === "assistant") return total + message.content.reduce((sum: number, block: Block) => sum + blockTokens(block), 0);
		return total + estimateTokens(message);
	}, 0);
}

function visibleEntries(projection: SessionProjection): ProjectedEntry[] {
	return projection.entries.filter(({ messages }) => messages.length > 0);
}

function totalTokens(projection: SessionProjection): number {
	return visibleEntries(projection).reduce((total, entry) => total + entryTokens(entry), 0);
}

/** Number each kind within an entry: t for thinking, x for text, c for calls. @example positionalBlockIds("e1", [{ type: "thinking" }, { type: "toolCall" }, { type: "toolCall" }]) === ["e1.t0", "e1.c0", "e1.c1"] */
function positionalBlockIds(entryId: string, content: Block[]): string[] {
	const counts = new Map<string, number>();
	return content.map((block) => {
		const letter = BLOCK_KIND_LETTERS[block.type] ?? "b";
		const index = counts.get(letter) ?? 0;
		counts.set(letter, index + 1);
		return `${entryId}.${letter}${index}`;
	});
}

/** The entry's content as stored in the session file, before any edit. */
function originalContent(entry: SessionEntry): unknown {
	return entry.type === "message" ? entry.message.content : (entry as { content: unknown }).content;
}

/** @example asBlocks("hi") === [{ type: "text", text: "hi" }] */
function asBlocks(content: unknown): Block[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);
}

/**
 * Block IDs that survive edits: each current block keeps the ID of the original block it is a byte-for-byte copy of,
 * and text an edit inserted is a note, numbered n0, n1, … @example
 * stableBlockIds("e1", [{ type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }], [{ type: "text", text: "note" }, { type: "toolCall", id: "b" }]) === ["e1.n0", "e1.c1"]
 */
function stableBlockIds(entryId: string, original: Block[], current: Block[]): string[] {
	const originalIds = positionalBlockIds(entryId, original);
	const originalKeys = original.map((block) => JSON.stringify(block));
	const used = new Set<number>();
	let notes = 0;
	return current.map((block) => {
		const key = JSON.stringify(block);
		const index = originalKeys.findIndex((candidate, position) => !used.has(position) && candidate === key);
		if (index < 0) return `${entryId}.n${notes++}`;
		used.add(index);
		return originalIds[index];
	});
}

function blockIdsOf(entry: ProjectedEntry): string[] {
	return stableBlockIds(entry.sourceEntry.id, asBlocks(originalContent(entry.sourceEntry)), asBlocks(entry.messages.at(-1)!.content));
}

function isEdited(entry: ProjectedEntry): boolean {
	return JSON.stringify(entry.messages.at(-1)!.content) !== JSON.stringify(originalContent(entry.sourceEntry));
}

/** Editable entries whose latest edit removed them from context. */
function removedEntries(projection: SessionProjection): ProjectedEntry[] {
	const latestEdit = new Map<string, ContextEditEntry>();
	for (const { sourceEntry } of projection.entries) if (sourceEntry.type === "context_edit") latestEdit.set(sourceEntry.targetId, sourceEntry);
	return projection.entries.filter(({ sourceEntry, messages }) => messages.length === 0 && latestEdit.get(sourceEntry.id)?.replacement === null);
}

/** @example contentTokens("abcdefgh") === 2 */
function contentTokens(content: unknown): number {
	return asBlocks(content).reduce((total, block) => total + blockTokens(block), 0);
}

/** Pair each tool result with its call the way Pi replays them: the earliest unanswered call with that ID. */
function pairResults(entries: ProjectedEntry[]): Map<Block, ProjectedEntry> {
	const resultByCall = new Map<Block, ProjectedEntry>();
	const openCalls = new Map<string, Block[]>();
	for (const entry of entries) {
		const message = entry.messages.at(-1)!;
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") openCalls.set(block.id, [...(openCalls.get(block.id) ?? []), block]);
		}
		if (message.role === "toolResult") {
			const call = openCalls.get(message.toolCallId)?.shift();
			if (call) resultByCall.set(call, entry);
		}
	}
	return resultByCall;
}

/** @example labelled("a1b2c3d4 user, 11-05 22:00, ~5 tokens", "hi\nthere") === "a1b2c3d4 user, 11-05 22:00, ~5 tokens: hi" */
function labelled(head: string, text: string): string {
	const preview = previewOf(text);
	return preview ? `${head}: ${preview}` : head;
}

function entryHead(entry: ProjectedEntry, label: string): string {
	const parts = [`${entry.sourceEntry.id} ${label}`, entry.sourceEntry.timestamp.slice(5, 16).replace("T", " "), `~${formatTokens(entryTokens(entry))} est.`];
	if (!isEditable(entry.sourceEntry)) parts.push("not editable");
	if (isEditable(entry.sourceEntry) && isEdited(entry)) parts.push("edited");
	return parts.join(", ");
}

/** Pi's usage meter: the provider's count for the last response plus an estimate for what came after; null right after an edit until the next response. */
type ContextUsage = { tokens: number | null } | undefined;

/** @example meterLine({ tokens: 504480 }) === "Context: 504.5k tokens by Pi's usage meter." */
function meterLine(usage: ContextUsage): string {
	return usage?.tokens == null ? "Context: unknown until the next response, by Pi's usage meter." : `Context: ${formatTokens(usage.tokens)} tokens by Pi's usage meter.`;
}

const ESTIMATE_NOTE = "Sizes below are estimates at ~4 characters per token; use them to compare entries, not as real counts.";

/** One bullet per entry; an assistant entry's blocks nest under it with their own IDs, and each tool result nests under its call. */
function outlineOf(projection: SessionProjection, usage: ContextUsage): string {
	const visible = visibleEntries(projection);
	const resultByCall = pairResults(visible);
	const nestedResults = new Set(resultByCall.values());
	const removed = removedEntries(projection).length;
	const removedNote = removed > 0 ? `, ${removed} removed by edits (list them with {"removed": true})` : "";
	const lines = [`${visible.length} entries shown, ~${formatTokens(totalTokens(projection))} est.${removedNote}. ${meterLine(usage)} ${ESTIMATE_NOTE}`];
	for (const entry of visible) {
		if (nestedResults.has(entry)) continue;
		const message = entry.messages.at(-1)!;
		if (message.role !== "assistant") {
			const label = message.role === "toolResult" ? "result (its call is not in context)" : message.role;
			lines.push(`- ${labelled(entryHead(entry, label), textOf(message.content))}`);
			continue;
		}
		lines.push(`- ${entryHead(entry, "assistant")}`);
		const ids = blockIdsOf(entry);
		message.content.forEach((block: Block, index: number) => {
			const kind = block.type === "toolCall" ? "call" : ids[index].includes(".n") ? "note" : block.type;
			const head = `${ids[index]} ${kind}, ~${formatTokens(blockTokens(block))} est.`;
			if (block.type === "thinking") lines.push(`  - ${head}${block.thinkingSignature ? ", signed" : ""}`);
			else if (block.type === "toolCall") lines.push(`  - ${labelled(head, `${block.name}(${JSON.stringify(block.arguments)})`)}`);
			else lines.push(`  - ${labelled(head, block.text ?? "")}`);
			const result = block.type === "toolCall" ? resultByCall.get(block) : undefined;
			if (result) lines.push(`    - ${labelled(entryHead(result, "result"), textOf(result.messages.at(-1)!.content))}`);
		});
	}
	return lines.join("\n");
}

/** The entries edits removed from context, with their original size and first line, for restore. */
function removedOutlineOf(projection: SessionProjection): string {
	const removed = removedEntries(projection);
	if (removed.length === 0) return "No entries are removed by edits.";
	const lines = removed.map(({ sourceEntry }) => {
		const content = originalContent(sourceEntry);
		const role = sourceEntry.type === "message" ? sourceEntry.message.role : "custom";
		const head = `${sourceEntry.id} ${role}, ${sourceEntry.timestamp.slice(5, 16).replace("T", " ")}, ~${formatTokens(contentTokens(content))} est.`;
		return `- ${labelled(head, textOf(content))}`;
	});
	return [`${removed.length} entr${removed.length === 1 ? "y" : "ies"} removed by edits; {"restore": id} brings one back:`, ...lines].join("\n");
}

/** The projection Pi would build after appending the edits, through Pi's own validation, as its turn boundary does. */
function projectWithEdits(sessionManager: ReadonlySessionManager, edits: ContextEdit[]): SessionProjection {
	const preview = SessionManager.inMemory(sessionManager.getCwd(), undefined, [sessionManager.getHeader()!, ...sessionManager.getBranch()]);
	for (const { targetId, replacement } of edits) preview.appendContextEdit(targetId, replacement);
	return preview.buildSessionProjection();
}

/** Problems that would make the edited context unsendable; the newest assistant's calls are still running. */
function contextProblems(projection: SessionProjection): string[] {
	// Pi does not replay failed or aborted assistant attempts, so their unanswered calls are not problems.
	const messages = projection.messages.filter(
		(message) => message.role !== "system" && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")),
	);
	const problems: string[] = [];
	if (messages.length > 0 && !USER_ROLES.has(messages[0].role)) problems.push(`the context would start with a ${messages[0].role} message instead of a user message`);
	const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const openCalls = new Set<string>();
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const callId of openCalls) problems.push(`tool call ${callId} would lose its tool result`);
			openCalls.clear();
			for (const block of message.content) if (block.type === "toolCall" && index !== lastAssistantIndex) openCalls.add(block.id);
		}
		if (message.role === "toolResult" && !openCalls.delete(message.toolCallId) && index < lastAssistantIndex) {
			problems.push(`tool result for ${message.toolCallId} would lose its tool call`);
		}
	});
	for (const callId of openCalls) problems.push(`tool call ${callId} would lose its tool result`);
	return problems;
}

/** Turn the agent's operations into one replacement per entry, resolved against the current context. Throws on any invalid operation. */
function compileOperations(base: SessionProjection, operations: Operation[]): ContextEdit[] {
	const visible = visibleEntries(base);
	const entryById = new Map(visible.map((entry) => [entry.sourceEntry.id, entry]));
	const latestAssistant = visible.findLast((entry) => entry.messages.at(-1)!.role === "assistant");
	const resultByCall = pairResults(visible);
	const replacements = new Map<string, ContextEditEntry["replacement"]>();
	const workingContent = new Map<string, Block[]>();

	const editableEntry = (id: string): ProjectedEntry => {
		const entry = entryById.get(id);
		if (!entry) throw new Error(`${id} is not in your current context; use an ID from context_outline`);
		if (!isEditable(entry.sourceEntry)) throw new Error(`${id} cannot be edited; only user, assistant, tool-result and custom messages can`);
		if (entry === latestAssistant) throw new Error(`${id} is your current message, whose call is still running; it cannot be edited`);
		return entry;
	};
	const resolveBlock = (blockId: string): { entry: ProjectedEntry; block: Block } => {
		const entry = editableEntry(blockId.split(".")[0]);
		const content = entry.messages.at(-1)!.content as Block[];
		const index = blockIdsOf(entry).indexOf(blockId);
		if (index < 0) throw new Error(`${blockId} is not a block of ${entry.sourceEntry.id}; use a block ID from context_outline`);
		return { entry, block: content[index] };
	};
	const rewriteBlocks = (entry: ProjectedEntry, rewrite: (block: Block) => Block[]): void => {
		const id = entry.sourceEntry.id;
		workingContent.set(id, (workingContent.get(id) ?? (entry.messages.at(-1)!.content as Block[])).flatMap(rewrite));
	};

	const restorable = (entry: ProjectedEntry): boolean => entry.messages.length === 0 || isEdited(entry);
	const restore = (entry: ProjectedEntry): void => {
		replacements.set(entry.sourceEntry.id, { content: originalContent(entry.sourceEntry) as ContextEditableContent });
	};

	for (const operation of operations) {
		if ("restore" in operation) {
			const entry = base.entries.find(({ sourceEntry }) => sourceEntry.id === operation.restore);
			if (!entry || !isEditable(entry.sourceEntry)) throw new Error(`${operation.restore} is not an editable entry in this session's context`);
			if (!restorable(entry)) throw new Error(`${operation.restore} is not edited; there is nothing to restore`);
			restore(entry);
			// A restored call needs its result back too, or it would be left unanswered.
			const original = asBlocks(originalContent(entry.sourceEntry));
			const callIds = new Set(original.filter((block) => block.type === "toolCall").map((block) => block.id));
			const position = base.entries.indexOf(entry);
			for (const candidate of base.entries.slice(position + 1)) {
				const source = candidate.sourceEntry;
				if (source.type !== "message" || source.message.role !== "toolResult" || !callIds.has(source.message.toolCallId)) continue;
				callIds.delete(source.message.toolCallId);
				if (restorable(candidate)) restore(candidate);
			}
		} else if ("dropThinking" in operation) {
			const beforeIndex = visible.findIndex((entry) => entry.sourceEntry.id === operation.dropThinking.before);
			if (beforeIndex < 0) throw new Error(`${operation.dropThinking.before} is not in your current context`);
			const kept = new Set(operation.dropThinking.except ?? []);
			for (const entry of visible.slice(0, beforeIndex)) {
				if (entry.messages.at(-1)!.role !== "assistant" || kept.has(entry.sourceEntry.id)) continue;
				const ids = new Map((entry.messages.at(-1)!.content as Block[]).map((block, index) => [block, blockIdsOf(entry)[index]]));
				rewriteBlocks(entry, (block) => (block.type === "thinking" && !kept.has(ids.get(block)!) ? [] : [block]));
			}
		} else if ("fold" in operation) {
			const { entry, block } = resolveBlock(operation.fold);
			if (block.type !== "toolCall") throw new Error(`${operation.fold} is not a tool call; fold takes a call block ID such as ${entry.sourceEntry.id}.c0`);
			const result = resultByCall.get(block);
			if (!result) throw new Error(`${operation.fold} has no result in context to fold`);
			rewriteBlocks(entry, (candidate) => (candidate === block ? [{ type: "text", text: operation.note }] : [candidate]));
			replacements.set(result.sourceEntry.id, null);
		} else if (operation.id.includes(".")) {
			const { entry, block } = resolveBlock(operation.id);
			if (block.type === "toolCall") throw new Error(`${operation.id} is a tool call; use fold to replace a call together with its result`);
			rewriteBlocks(entry, (candidate) => (candidate !== block ? [candidate] : operation.replacement === null ? [] : [{ type: "text", text: operation.replacement }]));
		} else {
			editableEntry(operation.id);
			replacements.set(operation.id, operation.replacement === null ? null : { content: operation.replacement });
		}
	}

	for (const [id, content] of workingContent) {
		if (replacements.has(id)) continue;
		replacements.set(id, { content: content.length > 0 ? content : [{ type: "text", text: EMPTIED_ASSISTANT_TEXT }] });
	}
	return [...replacements].map(([targetId, replacement]) => ({ targetId, replacement }));
}

/** The effect of edits on the context: tokens freed, where the cache breaks, and how much is reprocessed. */
function effectReport(base: SessionProjection, edited: SessionProjection, edits: ContextEdit[]): string {
	const visible = visibleEntries(base);
	const editedIds = new Set(edits.map(({ targetId }) => targetId));
	const earliest = visible.findIndex((entry) => editedIds.has(entry.sourceEntry.id));
	const positionById = new Map(visible.map((entry, index) => [entry.sourceEntry.id, index]));
	const reprocessed = visibleEntries(edited)
		.filter((entry) => (positionById.get(entry.sourceEntry.id) ?? Infinity) >= earliest)
		.reduce((total, entry) => total + entryTokens(entry), 0);
	const before = totalTokens(base);
	const after = totalTokens(edited);
	return [
		`${edits.length} entr${edits.length === 1 ? "y" : "ies"} changed. ${before >= after ? "Frees" : "Adds"} ~${formatTokens(Math.abs(before - after))} est. tokens (~${formatTokens(before)} → ~${formatTokens(after)}).`,
		`Earliest change: ${visible[earliest].sourceEntry.id}, entry ${earliest + 1} of ${visible.length}; ~${formatTokens(reprocessed)} est. tokens from there on are reprocessed without the prompt cache once.`,
		"Every tool call still has its result.",
	].join(" ");
}

/** @example operationLabel({ fold: "a1.c0", note: "x" }) === "fold a1.c0" */
function operationLabel(operation: Operation): string {
	if ("fold" in operation) return `fold ${operation.fold}`;
	if ("restore" in operation) return `restore ${operation.restore}`;
	if ("dropThinking" in operation) return `dropThinking before ${operation.dropThinking.before}`;
	return `${operation.replacement === null ? "remove" : "replace"} ${operation.id}`;
}

/** Tokens each operation frees when applied alone, so the agent can judge which ones are worth their cache cost. */
function operationBreakdown(sessionManager: ReadonlySessionManager, queued: ContextEdit[], base: SessionProjection, operations: Operation[]): string {
	if (operations.length < 2) return "";
	const before = totalTokens(base);
	const parts = operations.map((operation) => {
		const alone = projectWithEdits(sessionManager, [...queued, ...compileOperations(base, [operation])]);
		return `${operationLabel(operation)} ~${formatTokens(before - totalTokens(alone))}`;
	});
	return ` Per operation, each measured alone: ${parts.join("; ")}.`;
}

const contextOutlineTool = defineTool({
	name: "context_outline",
	label: "Context Outline",
	description: [
		"Outline your current context window. The header gives the real context size from Pi's usage meter; each entry is a bullet with its ID, role, time, estimated size, and the first line of its text.",
		"An assistant entry's thinking, text and tool calls are nested under it with block IDs such as df511fce.t0 (thinking), .x0 (text), .c0 (call) and .n0 (a note an edit inserted), and each tool result is nested under its call.",
		"Block IDs stay the same across edits. Entries changed by an edit are marked edited; {removed: true} lists the entries edits removed, for restore.",
	].join(" "),
	parameters: Type.Object({ removed: Type.Optional(Type.Boolean({ description: "List the entries removed by edits instead of the outline" })) }),
	async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
		const projection = ctx.sessionManager.buildSessionProjection();
		const text = parameters.removed ? removedOutlineOf(projection) : outlineOf(projection, ctx.getContextUsage());
		return { content: [{ type: "text" as const, text }] };
	},
});

const editContextTool = defineTool({
	name: "edit_context",
	label: "Edit Context",
	description: [
		"Edit your own context window, using IDs from context_outline. Operations:",
		"{id, replacement}: with an entry ID, replace the whole message's content with text, or remove the message with null; with a thinking or text block ID, replace just that block with a short text note, or drop it with null.",
		"{fold: callBlockId, note}: replace a tool call with a text note and remove its result, in one step.",
		"{dropThinking: {before: entryId, except?: [entry or block IDs]}}: drop every thinking block in the entries before that entry, except those named.",
		"{restore: entryId}: bring an edited or removed entry back to its original content; restoring a call also restores its removed result.",
		"Edits take effect from your next request in this same run. The originals stay in the session file. Your current message cannot be edited.",
		"Everything after the earliest change is reprocessed without the prompt cache once, so batch edits into one call. dryRun reports the tokens freed, the earliest changed entry and how many tokens from there on lose the prompt cache once, confirms every tool call still has its result, and with several operations gives the tokens each frees alone; it applies nothing and returns a plan ID, and {apply: planId} commits that exact plan without resending it. A refused edit changes nothing and says why.",
	].join(" "),
	parameters: Type.Object({
		operations: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Object({ id: Type.String(), replacement: Type.Union([Type.String(), Type.Null()]) }),
					Type.Object({ fold: Type.String(), note: Type.String() }),
					Type.Object({ dropThinking: Type.Object({ before: Type.String(), except: Type.Optional(Type.Array(Type.String())) }) }),
					Type.Object({ restore: Type.String() }),
				]),
				{ minItems: 1 },
			),
		),
		dryRun: Type.Optional(Type.Boolean({ description: "Report the effect and return a plan ID without applying anything" })),
		apply: Type.Optional(Type.String({ description: "A plan ID from an earlier dry run, to apply that plan" })),
	}),
	async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
		const sessionManager = ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const queued = pendingEditsBySession.get(sessionId) ?? [];
		const base = projectWithEdits(sessionManager, queued);

		let edits: ContextEdit[];
		let breakdown: string;
		if (parameters.apply !== undefined) {
			const plan = plansById.get(parameters.apply);
			if (!plan || plan.sessionId !== sessionId) throw new Error(`No dry-run plan ${parameters.apply} in this session; plans are lost on reload, so run the dry run again`);
			({ edits, breakdown } = plan);
		} else {
			if (!parameters.operations) throw new Error("Give operations, or apply a plan ID from a dry run");
			const operations = parameters.operations as Operation[];
			edits = compileOperations(base, operations);
			breakdown = operationBreakdown(sessionManager, queued, base, operations);
		}

		const edited = projectWithEdits(sessionManager, [...queued, ...edits]);
		const problems = contextProblems(edited);
		if (problems.length > 0) throw new Error(`No edits applied, because ${problems.join("; ")}`);
		const report = effectReport(base, edited, edits) + breakdown;

		if (parameters.dryRun) {
			const planId = `plan-${++planCount}`;
			plansById.set(planId, { sessionId, edits, breakdown });
			return { content: [{ type: "text" as const, text: `Dry run, nothing applied. ${report} To apply exactly this, call edit_context with {"apply": "${planId}"}.` }] };
		}
		pendingEditsBySession.set(sessionId, [...queued, ...edits]);
		if (parameters.apply !== undefined) plansById.delete(parameters.apply);
		return { content: [{ type: "text" as const, text: `Applied from your next request. ${report}` }] };
	},
});

export default function selfEditContext(pi: ExtensionAPI): void {
	pi.registerTool(contextOutlineTool);
	pi.registerTool(editContextTool);
	pi.on("turn_end", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const edits = pendingEditsBySession.get(sessionId);
		if (!edits) return;
		pendingEditsBySession.delete(sessionId);
		return { entries: [...event.entries, ...edits.map((edit) => ({ type: "context_edit" as const, ...edit }))] };
	});
}
