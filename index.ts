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

const USER_ROLES = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
const PREVIEW_CHARACTERS = 200;

/** Edits the agent has made this turn. Pi persists them at the turn boundary, before the next request. */
const pendingEditsBySession = new Map<string, ContextEdit[]>();

function isEditable(entry: SessionEntry): boolean {
	return entry.type === "custom_message" || (entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `→ ${block.name}(${JSON.stringify(block.arguments)})` : "")).join(" ");
}

/** @example formatTokens(950) === "950"; formatTokens(4123) === "4.1k" */
function formatTokens(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/** Characters a block sends, signatures included; Pi's estimate is about four characters per token. */
function blockCharacters(block: any): number {
	if (block.type === "thinking") return (block.thinking?.length ?? 0) + (block.thinkingSignature?.length ?? 0);
	if (block.type === "toolCall") return block.name.length + JSON.stringify(block.arguments).length;
	return block.text?.length ?? 0;
}

/** @example blockSummary([{ type: "thinking", thinking: "x".repeat(4000) }, { type: "toolCall", name: "a", arguments: {} }]) === "[thinking ~1.0k+1 call ~1]" */
function blockSummary(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const characters = new Map<string, number>();
	const calls = content.filter((block) => block.type === "toolCall").length;
	for (const block of content) characters.set(block.type, (characters.get(block.type) ?? 0) + blockCharacters(block));
	if (characters.size < 2 && calls < 2) return "";
	const parts = [...characters].map(([type, count]) => {
		const label = type === "toolCall" ? (calls === 1 ? "1 call" : `${calls} calls`) : type;
		return `${label} ~${formatTokens(Math.ceil(count / 4))}`;
	});
	return `[${parts.join("+")}]`;
}

/** @example previewOf("first line\nsecond") === "first line"; previewOf("a".repeat(150) + "b".repeat(150)) === "a".repeat(98) + "[…]" + "b".repeat(99) */
function previewOf(text: string): string {
	const firstLine = text.trim().split("\n")[0];
	if (firstLine.length <= PREVIEW_CHARACTERS) return firstLine;
	const kept = (PREVIEW_CHARACTERS - "[…]".length) / 2;
	return `${firstLine.slice(0, Math.floor(kept))}[…]${firstLine.slice(-Math.ceil(kept))}`;
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

function tokensOf(projection: SessionProjection): number {
	return projection.messages.reduce((total, message) => total + estimateTokens(message), 0);
}

const contextOutlineTool = defineTool({
	name: "context_outline",
	label: "Context Outline",
	description:
		"List the messages in your current context window, one line each: entry ID, role, time, estimated tokens, block kinds, for a tool result the call it answers (entry ID, plus #n when the entry made several calls), and the first line of text. Use the IDs with edit_context.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
		const projection = ctx.sessionManager.buildSessionProjection();
		const visible = projection.entries.filter(({ messages }) => messages.length > 0);
		const callByCallId = new Map<string, string>();
		const lines = visible.map(({ sourceEntry, messages }) => {
			const message = messages.at(-1)!;
			if (message.role === "assistant") {
				const calls = message.content.filter((block) => block.type === "toolCall");
				calls.forEach((call, index) => callByCallId.set(call.id, calls.length > 1 ? `${sourceEntry.id}#${index + 1}` : sourceEntry.id));
			}
			const tokens = messages.reduce((total, part) => total + estimateTokens(part), 0);
			const fields = [
				sourceEntry.id,
				message.role,
				sourceEntry.timestamp.slice(5, 16).replace("T", " "),
				`~${tokens}tok`,
				isEditable(sourceEntry) ? "" : "[not editable]",
				blockSummary(message.content),
				message.role === "toolResult" ? `answers ${callByCallId.get(message.toolCallId) ?? "?"}` : "",
				previewOf(textOf(message.content)),
			];
			return fields.filter(Boolean).join(" ");
		});
		const header = `${visible.length} entries, ~${tokensOf(projection)} tokens total`;
		return { content: [{ type: "text" as const, text: [header, ...lines].join("\n") }] };
	},
});

const editContextTool = defineTool({
	name: "edit_context",
	label: "Edit Context",
	description: [
		"Edit your own context window. Each edit targets an entry ID from context_outline and either replaces that message's content with new text, or removes it from your context with replacement: null.",
		"Edits take effect from your next request in this same run. The originals stay in the session file; only what you see changes.",
		"Remove or replace a tool call together with its tool results. Everything after the earliest edited message is reprocessed without the prompt cache once, so batch edits into one call and edit rarely.",
	].join(" "),
	parameters: Type.Object({
		edits: Type.Array(
			Type.Object({
				id: Type.String({ description: "Entry ID from context_outline" }),
				replacement: Type.Union([Type.String(), Type.Null()], { description: "New text for the message, or null to remove it from your context" }),
			}),
			{ minItems: 1 },
		),
		dryRun: Type.Optional(Type.Boolean({ description: "Check the edits and report their effect without applying them" })),
	}),
	async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
		const sessionManager = ctx.sessionManager;
		const current = sessionManager.buildSessionProjection();
		const visible = new Map(current.entries.filter(({ messages }) => messages.length > 0).map(({ sourceEntry }) => [sourceEntry.id, sourceEntry]));
		for (const { id } of parameters.edits) {
			const entry = visible.get(id);
			if (!entry) throw new Error(`${id} is not in your current context; use an ID from context_outline`);
			if (!isEditable(entry)) throw new Error(`${id} cannot be edited; only user, assistant, tool-result and custom messages can`);
		}

		const sessionId = sessionManager.getSessionId();
		const queued = pendingEditsBySession.get(sessionId) ?? [];
		const edits = [...queued, ...parameters.edits.map(({ id, replacement }) => ({ targetId: id, replacement: replacement === null ? null : { content: replacement } }))];
		const edited = projectWithEdits(sessionManager, edits);
		const problems = contextProblems(edited);
		if (problems.length > 0) throw new Error(`No edits applied, because ${problems.join("; ")}`);
		if (!parameters.dryRun) pendingEditsBySession.set(sessionId, edits);

		const editedIds = new Set(edits.map(({ targetId }) => targetId));
		const firstEditedIndex = current.entries.findIndex(({ sourceEntry }) => editedIds.has(sourceEntry.id));
		const uncachedTokens = current.entries.slice(firstEditedIndex).reduce((total, { messages }) => total + messages.reduce((sum, message) => sum + estimateTokens(message), 0), 0);
		const verdict = parameters.dryRun ? `Dry run: the ${parameters.edits.length} edit(s) are valid and were not applied. If applied, from your next request` : `Queued ${parameters.edits.length} edit(s). From your next request`;
		const text = `${verdict} your context is ~${tokensOf(edited)} tokens (was ~${tokensOf(current)}). About ${uncachedTokens} tokens after the earliest edit will be reprocessed without the prompt cache once.`;
		return { content: [{ type: "text" as const, text }] };
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
