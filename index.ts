import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	estimateTokens,
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
	| { dropThinking: { before: string; except?: string[] } };

const USER_ROLES = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
const PREVIEW_CHARACTERS = 200;
const BLOCK_KIND_LETTERS: Record<string, string> = { thinking: "t", text: "x", toolCall: "c" };
const EMPTIED_ASSISTANT_TEXT = "[thinking removed]";

/** Edits queued this turn. Pi persists them at the turn boundary, before the next request. */
const pendingEditsBySession = new Map<string, ContextEdit[]>();
/** Dry-run plans the agent can apply by ID without resending them. */
const plansById = new Map<string, { sessionId: string; edits: ContextEdit[] }>();
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

/** Block IDs number each kind within its entry: t for thinking, x for text, c for calls. @example blockIds("e1", [{ type: "thinking" }, { type: "toolCall" }, { type: "toolCall" }]) === ["e1.t0", "e1.c0", "e1.c1"] */
function blockIds(entryId: string, content: Block[]): string[] {
	const counts = new Map<string, number>();
	return content.map((block) => {
		const letter = BLOCK_KIND_LETTERS[block.type] ?? "b";
		const index = counts.get(letter) ?? 0;
		counts.set(letter, index + 1);
		return `${entryId}.${letter}${index}`;
	});
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
	const parts = [`${entry.sourceEntry.id} ${label}`, entry.sourceEntry.timestamp.slice(5, 16).replace("T", " "), `~${formatTokens(entryTokens(entry))} tokens`];
	if (!isEditable(entry.sourceEntry)) parts.push("not editable");
	return parts.join(", ");
}

/** One bullet per entry; an assistant entry's blocks nest under it with their own IDs, and each tool result nests under its call. */
function outlineOf(projection: SessionProjection): string {
	const visible = visibleEntries(projection);
	const resultByCall = pairResults(visible);
	const nestedResults = new Set(resultByCall.values());
	const lines = [`${visible.length} entries, ~${formatTokens(totalTokens(projection))} tokens total`];
	for (const entry of visible) {
		if (nestedResults.has(entry)) continue;
		const message = entry.messages.at(-1)!;
		if (message.role !== "assistant") {
			const label = message.role === "toolResult" ? "result (its call is not in context)" : message.role;
			lines.push(`- ${labelled(entryHead(entry, label), textOf(message.content))}`);
			continue;
		}
		lines.push(`- ${entryHead(entry, "assistant")}`);
		const ids = blockIds(entry.sourceEntry.id, message.content);
		message.content.forEach((block: Block, index: number) => {
			const head = `${ids[index]} ${block.type === "toolCall" ? "call" : block.type}, ~${formatTokens(blockTokens(block))} tokens`;
			if (block.type === "thinking") lines.push(`  - ${head}${block.thinkingSignature ? ", signed" : ""}`);
			else if (block.type === "toolCall") lines.push(`  - ${labelled(head, `${block.name}(${JSON.stringify(block.arguments)})`)}`);
			else lines.push(`  - ${labelled(head, block.text ?? "")}`);
			const result = block.type === "toolCall" ? resultByCall.get(block) : undefined;
			if (result) lines.push(`    - ${labelled(entryHead(result, "result"), textOf(result.messages.at(-1)!.content))}`);
		});
	}
	return lines.join("\n");
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
		const index = blockIds(entry.sourceEntry.id, content).indexOf(blockId);
		if (index < 0) throw new Error(`${blockId} is not a block of ${entry.sourceEntry.id}; use a block ID from context_outline`);
		return { entry, block: content[index] };
	};
	const rewriteBlocks = (entry: ProjectedEntry, rewrite: (block: Block) => Block[]): void => {
		const id = entry.sourceEntry.id;
		workingContent.set(id, (workingContent.get(id) ?? (entry.messages.at(-1)!.content as Block[])).flatMap(rewrite));
	};

	for (const operation of operations) {
		if ("dropThinking" in operation) {
			const beforeIndex = visible.findIndex((entry) => entry.sourceEntry.id === operation.dropThinking.before);
			if (beforeIndex < 0) throw new Error(`${operation.dropThinking.before} is not in your current context`);
			const kept = new Set(operation.dropThinking.except ?? []);
			for (const entry of visible.slice(0, beforeIndex)) {
				if (entry.messages.at(-1)!.role !== "assistant" || kept.has(entry.sourceEntry.id)) continue;
				const ids = new Map((entry.messages.at(-1)!.content as Block[]).map((block, index) => [block, blockIds(entry.sourceEntry.id, entry.messages.at(-1)!.content)[index]]));
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
		`${edits.length} entr${edits.length === 1 ? "y" : "ies"} changed. Frees ~${formatTokens(before - after)} tokens (~${formatTokens(before)} → ~${formatTokens(after)}).`,
		`Earliest change: ${visible[earliest].sourceEntry.id}, entry ${earliest + 1} of ${visible.length}; ~${formatTokens(reprocessed)} tokens from there on are reprocessed without the prompt cache once.`,
		"Every tool call still has its result.",
	].join(" ");
}

const contextOutlineTool = defineTool({
	name: "context_outline",
	label: "Context Outline",
	description: [
		"Outline your current context window. Each entry is a bullet: entry ID, role, time, estimated tokens, and the first line of its text.",
		"An assistant entry's thinking, text and tool calls are nested under it with block IDs such as df511fce.t0 (thinking), .x0 (text) and .c0 (call), and each tool result is nested under its call.",
	].join(" "),
	parameters: Type.Object({}),
	async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
		return { content: [{ type: "text" as const, text: outlineOf(ctx.sessionManager.buildSessionProjection()) }] };
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
		"Edits take effect from your next request in this same run. The originals stay in the session file. Your current message cannot be edited.",
		"Everything after the earliest change is reprocessed without the prompt cache once, so batch edits into one call. dryRun reports the tokens freed, the earliest changed entry and how many tokens from there on lose the prompt cache once, and confirms every tool call still has its result; it applies nothing and returns a plan ID, and {apply: planId} commits that exact plan without resending it. A refused edit changes nothing and says why.",
	].join(" "),
	parameters: Type.Object({
		operations: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Object({ id: Type.String(), replacement: Type.Union([Type.String(), Type.Null()]) }),
					Type.Object({ fold: Type.String(), note: Type.String() }),
					Type.Object({ dropThinking: Type.Object({ before: Type.String(), except: Type.Optional(Type.Array(Type.String())) }) }),
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
		if (parameters.apply !== undefined) {
			const plan = plansById.get(parameters.apply);
			if (!plan || plan.sessionId !== sessionId) throw new Error(`No dry-run plan ${parameters.apply} in this session`);
			edits = plan.edits;
		} else {
			if (!parameters.operations) throw new Error("Give operations, or apply a plan ID from a dry run");
			edits = compileOperations(base, parameters.operations as Operation[]);
		}

		const edited = projectWithEdits(sessionManager, [...queued, ...edits]);
		const problems = contextProblems(edited);
		if (problems.length > 0) throw new Error(`No edits applied, because ${problems.join("; ")}`);
		const report = effectReport(base, edited, edits);

		if (parameters.dryRun) {
			const planId = `plan-${++planCount}`;
			plansById.set(planId, { sessionId, edits });
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
