# pi-self-edit-context

Lets a Pi agent edit its own context window mid-run.

## `context_outline`

Outlines the context as nested bullets. Each entry shows its ID, role, time, estimated tokens and first line. An assistant entry's blocks nest under it with their own IDs: `.t0` thinking, `.x0` text, `.c0` call. Each tool result nests under its call. An entry's size is the sum of its blocks, signatures included, so the header total equals the sum of the lines.

## `edit_context`

Operations, by ID from the outline:

- `{id, replacement}`: with an entry ID, replace the whole message with text, or remove it with `null`. With a thinking or text block ID, replace just that block with a short text note, or drop it with `null`.
- `{fold: callBlockId, note}`: replace a tool call with a note and remove its result, in one step.
- `{dropThinking: {before: entryId, except?: [entry or block IDs]}}`: drop every thinking block in the entries before that entry, except the ones named.

`dryRun: true` reports the tokens freed, the earliest change and how many tokens after it lose the prompt cache once, and confirms every call still has its result. It returns a plan ID, and `{apply: planId}` commits that exact plan without resending it.

Edits are refused, and change nothing, if they would leave a call without its result or the reverse, make the context start with a non-user message, or touch the agent's current message.

## How it works

Edits are queued and returned from Pi's `turn_end` boundary as native `context_edit` entries. Pi validates and appends them, then rebuilds the running agent's context, so they apply from the next request in the same run and survive resume. The session file keeps every original message.

Test: `npm test` runs real `pi -p` sessions against a scripted stand-in model; no model calls.
