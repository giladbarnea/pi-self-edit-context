// An offline oracle for issue 7: build the request body Pi would send to an Anthropic model that takes system messages
// mid-conversation, through Pi's and pi-ai's own code, and find where Anthropic would reject it. No network: the payload is
// captured before any request is made.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, normalizeContext } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";

const MODEL = getModel("anthropic", "claude-opus-5-5");

/**
 * Indexes of the request's messages that Anthropic rejects: "role 'system' must follow a 'user' message or an 'assistant'
 * message ending in a server tool result; the directive-only form (content: [] with output_config) is accepted at any position".
 * A run of system messages after a user message is accepted.
 */
function rejectedIndexes(messages) {
	return messages.flatMap((message, index) => {
		if (message.role !== "system" || message.content.length === 0) return [];
		const previous = messages.slice(0, index).findLast((candidate) => candidate.role !== "system");
		return previous?.role === "assistant" ? [index] : [];
	});
}

/** The Anthropic request body for the session in these entries, whose last entry is the leaf. */
async function requestOf(entries) {
	const directory = mkdtempSync(join(tmpdir(), "anthropic-request-"));
	const file = join(directory, "session.jsonl");
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const messages = convertToLlm(SessionManager.open(file, directory).buildSessionProjection().messages);
	let payload;
	const capture = (body) => {
		payload = body;
		throw new Error("captured offline");
	};
	await streamSimple(MODEL, normalizeContext({ messages }), { apiKey: "offline", onPayload: capture }).result().catch(() => {});
	if (!payload) throw new Error("pi-ai built no request payload");
	return payload;
}

/** For each request the scripted model answered (every assistant entry from `fromIndex` on), the indexes Anthropic would reject. */
export async function rejectionsPerRequest(entries, fromIndex = 0) {
	const rejections = [];
	for (let index = fromIndex; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { messages } = await requestOf(entries.slice(0, index));
		const rejected = rejectedIndexes(messages);
		if (rejected.length > 0) rejections.push({ before: entry.id, rejected, roles: messages.map((message) => message.role) });
	}
	return rejections;
}
