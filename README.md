---
last_updated: 2026-11-09T14-10
---
# pi-self-edit-context

Lets a Pi agent edit its own context window mid-run, without deleting its session history.

## Install

Requires Node.js 22.19.0 or newer and Pi. The maintained Pi lines are 1.4.x and 1.5.x.

Install from [GitHub](https://github.com/giladbarnea/pi-self-edit-context):

```sh
pi install git:github.com/giladbarnea/pi-self-edit-context
```

Or, from a checkout:

```sh
pi install .
```

Restart Pi or run `/reload`. To try it for one session without installing:

```sh
pi -e ./index.ts
```

Ask the agent to inspect its context with `context_outline`, then use `edit_context` to replace, fold or restore entries.
These are agent tools, not slash commands. No API key or additional model is needed by the extension itself.

Edits change future model requests, not the stored originals. This is not a way to erase secrets from session files.
An edit can remove useful context and invalidate the prompt cache from the earliest change onward. Use a dry run to inspect that cost first.
Both tool descriptions tell the agent to plan the whole reduction from one outline, then apply it in one `edit_context` call: each call near the start of the context rewrites almost the whole prompt cache, and an applied edit hides the original it replaced.

## `context_outline`

Outlines the context as nested bullets. The header gives the real context size from Pi's usage meter (`ctx.getContextUsage()`, the same source as the footer). Per-entry and per-block sizes are estimates at ~4 characters per token, marked `est.`, for comparing entries; Pi has no per-message tokenizer. Each entry shows its ID, role, time, estimated size and first line. By default, user messages and entries of 2k+ est. tokens are shown in full; each run of smaller entries is one line with its bounds, size and thinking, so the small tail stays visible as a cost. `{minTokens: 0}` shows every entry. `{from, to}` lists only the entries from one entry ID to another, such as one run's bounds, at the given `minTokens`; the header still gives the whole context. An assistant entry's blocks nest under it with their own IDs: `.t0` thinking, `.x0` text, `.c0` call. Each tool result nests under its call. Block IDs come from the entry's original content, so they stay the same across edits; text an edit inserted gets a note ID (`.n0`). Edited entries are marked `edited`, the header counts removed entries, and `{removed: true}` lists them. Sizes count what Pi sends to the session's current model, by the rules of Pi's own message transform (mirrored here, because Pi does not expose it to extensions): a thinking block that another model wrote is dropped before sending, signature included, so it costs 0; a block the current model wrote counts its thinking and signature. An entry's size is the sum of its blocks, so the header total equals the sum of the lines.

## `edit_context`

Operations, by ID from the outline:

- `{id, replacement}`: with an entry ID, replace the whole message with text, or remove it with `null`. With a thinking or text block ID, replace just that block with a short text note, or drop it with `null`.
- `{fold: callBlockId, note}`: replace a tool call with a note and remove its result, in one step.
- `{dropThinking: {before: entryId, except?: [entry or block IDs]}}`: drop every thinking block in the entries before that entry, except the ones named.
- `{foldRange: {from, to, note}}`: replace a contiguous stretch of entries with one note the agent writes. Its first user or assistant message holds the note; the rest are removed. A range that would split a call from its result is refused.
- `{restore: entryId}`: bring an edited or removed entry back to its stored original. A call entry comes back with its results, and a result comes back with the entry holding its call, so a restore is always sendable.

Operations in one batch apply in order to a working copy of the context: `[{restore: E}, {fold: "E.c1"}]` restores E, then folds its second call. The batch's edits are the entries whose final content differs from the current context; a batch that changes nothing is refused.

Every report, dry run or not, gives Pi's usage meter (a dry run's "Context now", an apply's "Context before this edit", since the meter updates only after the next response), the tokens freed, the earliest change and how many tokens after it lose the prompt cache once, and confirms every call still has its result. It returns a plan ID, and `{apply: planId}` commits that exact plan without resending it.

Edits are refused, and change nothing, naming the entry or block at fault, if they would leave a call without its result or the reverse, make the context start with a non-user message, put a Pi system entry (a prompt or tool-set update) between two assistant messages with no user message or tool result between them, or touch the agent's current message. Pi sends such a system entry right after the first assistant message, and Anthropic rejects that request. Starting a range at a user message avoids it, because the user message then holds the note.

## Outlines fold themselves

When edits apply, earlier `context_outline` results after the batch's earliest change are folded in the same batch. They lose the prompt cache anyway, so this costs nothing. Outlines before the earliest change are left, and the report names them, since folding one would move the cache break earlier. Each folded outline leaves a note: when it was taken and what it showed, including its stretch, which of the entries it lists are now removed (counted from the session, so the note stays accurate when an outline is restored and folded again), and `{"restore": entryId}` to bring it back. Restoring it shows what the agent saw and the IDs it needs to restore the removed entries themselves.

## How it works

Edits are queued and returned from Pi's `turn_end` boundary as native `context_edit` entries. Pi validates and appends them, then rebuilds the running agent's context, so they apply from the next request in the same run and survive resume. The session file keeps every original message.

## Development and CI

```sh
npm ci
npm test
npm pack --dry-run
```

`npm test` uses the locally installed Pi CLI and real `pi -p` sessions against a scripted stand-in model. No external model calls occur.
Each session gets an isolated home and agent directory, with no inherited credentials or extension configuration.
The locked development version is Pi 1.5.0. CI also installs exact Pi 1.4.0 packages and checks the installed versions before testing.

The CI workflow runs on pull requests, pushes to `main` and manual dispatch. It uses Node.js 22.19.0 and read-only repository permissions.
The suite checks that a real Pi start loads the packed extension from a local path and as an installed npm package (`test/live-load.test.mjs`), next-request edits, dry runs, the meter in edit reports, stretch outlines and their refusals, the planning guidance in both tool descriptions, saved plans, stable block IDs, call/result pairing, system-entry order, refusals, restores and outline folding.
It also opens a synthetic session that switched from GPT to another model and checks that the estimates ignore the GPT signatures Pi drops, while the same model posing as GPT still counts them.
It also previews the package contents. CI does not publish packages or make model requests.

`test/monkey.test.mjs` drives a seeded random agent through ~40 batches of folds, ranges, restores, thinking drops and block edits, valid or not, often using IDs remembered from older outlines, and toggles a tool mid-turn so Pi records system entries, then restores everything. It checks that every request stays sendable, including that Anthropic's request rules accept it (each request is rebuilt offline through Pi's and pi-ai's Anthropic converter, in `test/fixtures/anthropic-request.mjs`), refusals and dry runs persist nothing, folds remove the result of the call their ID originally named, outline counts agree with the removed list, and full restore brings every message back byte for byte. `MONKEY_SEEDS=1,2,…` and `MONKEY_ACTS=n` widen the search.
