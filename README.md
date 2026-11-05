# pi-self-edit-context

Lets a Pi agent edit its own context window with two tools:

- `context_outline` lists the messages in context: entry ID, role, estimated tokens, first line.
- `edit_context` replaces a message's content with new text, or removes it from context (`replacement: null`).

Edits apply from the agent's next request in the same run. The extension queues them and returns them from Pi's `turn_end` boundary as native `context_edit` entries; Pi validates and appends them, then rebuilds the running agent's context. The session file keeps every original message, so the edits survive resume and the originals stay inspectable.

`edit_context` refuses, and changes nothing, when an edit would leave a tool call without its result (or the reverse) or make the context start with a non-user message.

Any edit makes everything after the earliest edited message uncached for one request. Batch edits and edit rarely.

Test: `npm test` runs real `pi -p` sessions against a scripted stand-in model; no model calls.
