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
const PREVIEW_CHARACTERS = 100;

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

/** @example previewOf("first line\nsecond") === "first line" */
function previewOf(text: string): string {
	const firstLine = text.trim().split("\n")[0];
	return firstLine.length > PREVIEW_CHARACTERS ? `${firstLine.slice(0, PREVIEW_CHARACTERS)}…` : firstLine;
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
		"List the messages in your current context window, one line each: entry ID, role, estimated tokens, and the first line of text. Use the IDs with edit_context.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
		const lines = ctx.sessionManager
			.buildSessionProjection()
			.entries.filter(({ messages }) => messages.length > 0)
			.map(({ sourceEntry, messages }) => {
				const tokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
				const role = messages.at(-1)!.role;
				const locked = isEditable(sourceEntry) ? "" : " [not editable]";
				return `${sourceEntry.id} ${role} ~${tokens}tok${locked} ${previewOf(textOf(messages.at(-1)!.content))}`;
			});
		return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
		pendingEditsBySession.set(sessionId, edits);

		const editedIds = new Set(edits.map(({ targetId }) => targetId));
		const firstEditedIndex = current.entries.findIndex(({ sourceEntry }) => editedIds.has(sourceEntry.id));
		const uncachedTokens = current.entries.slice(firstEditedIndex).reduce((total, { messages }) => total + messages.reduce((sum, message) => sum + estimateTokens(message), 0), 0);
		const text = `Queued ${parameters.edits.length} edit(s). From your next request your context is ~${tokensOf(edited)} tokens (was ~${tokensOf(current)}). About ${uncachedTokens} tokens after the earliest edit will be reprocessed without the prompt cache once.`;
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
