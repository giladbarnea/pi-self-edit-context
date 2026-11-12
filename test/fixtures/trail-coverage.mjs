// The restore-trail invariant: every entry an edit removed from context is under a visible note. Either a stored range whose
// note holder is in context spans it, or it is a tool result whose call was folded into a note in an entry that is itself in
// context or under a note: restoring that entry brings its results back.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const RANGE_ENTRY = "self-edit-context.range";

function projectionOf(entries) {
	const directory = mkdtempSync(join(tmpdir(), "trail-coverage-"));
	const file = join(directory, "session.jsonl");
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return SessionManager.open(file, directory).buildSessionProjection();
}

/**
 * Stored ranges still in force: a range stops covering anything once its note holder is restored to its stored content, even if
 * a later fold puts another note on that entry.
 */
function liveRanges(projection) {
	const byId = new Map(projection.entries.map(({ sourceEntry }) => [sourceEntry.id, sourceEntry]));
	const stored = (entry) => (entry.type === "message" ? entry.message.content : entry.content);
	let ranges = [];
	for (const { sourceEntry } of projection.entries) {
		if (sourceEntry.type === "custom" && sourceEntry.customType === RANGE_ENTRY) ranges.push(sourceEntry.data);
		if (sourceEntry.type !== "context_edit" || sourceEntry.replacement === null) continue;
		if (JSON.stringify(sourceEntry.replacement.content) === JSON.stringify(stored(byId.get(sourceEntry.targetId)))) ranges = ranges.filter(({ holder }) => holder !== sourceEntry.targetId);
	}
	return ranges;
}

/** Removed entries with no visible note over them, at the session state each request the scripted model answered was built from. */
export function uncoveredPerRequest(entries) {
	const uncovered = [];
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		const projection = projectionOf(entries.slice(0, index));
		const position = new Map(projection.entries.map(({ sourceEntry }, at) => [sourceEntry.id, at]));
		const visible = new Set(projection.entries.filter(({ messages }) => messages.length > 0).map(({ sourceEntry }) => sourceEntry.id));
		const ranges = liveRanges(projection);
		const callEntryOf = (source) =>
			projection.entries.find(({ sourceEntry }) =>
				sourceEntry.type === "message" && sourceEntry.message.role === "assistant" &&
				sourceEntry.message.content.some((block) => block.type === "toolCall" && block.id === source.message.toolCallId));
		const covered = (source) => {
			const at = position.get(source.id);
			if (ranges.some(({ holder, from, to }) => visible.has(holder) && position.get(from) <= at && at <= position.get(to))) return true;
			if (source.type !== "message" || source.message.role !== "toolResult") return false;
			const call = callEntryOf(source);
			if (!call) return false;
			if (call.messages.length === 0) return covered(call.sourceEntry);
			return !call.messages.at(-1).content.some((block) => block.type === "toolCall" && block.id === source.message.toolCallId);
		};
		const removed = projection.entries.filter(({ sourceEntry, messages }) =>
			messages.length === 0 && (sourceEntry.type === "custom_message" || (sourceEntry.type === "message" && ["user", "assistant", "toolResult"].includes(sourceEntry.message.role))));
		const missing = removed
			.map(({ sourceEntry }) => sourceEntry)
			.filter((source) => !covered(source))
			.map(({ id }) => id);
		if (missing.length > 0) uncovered.push({ before: entry.id, missing });
	});
	return uncovered;
}
