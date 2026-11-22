---
name: fit-context
description: Use when editing an agent’s context window to decide what to keep in full, edit, fold, or restore. Applies to the current session or a parent session edited from a fork.
---

# How to edit an agent’s context

## Establish the scope

Identify the agent’s current task and any standing responsibilities. Map the major chapters across the active and folded history. A chapter can return after a gap. Use bounded outline excerpts so the outline itself does not fill your window. Include short entries, even when the outline groups them into a single line.

**For the smaller entries within each chapter, use forks only to search and classify.** Spawn a team of N small-model forks at xhigh thinking (Haiku or Luna), where N is the number of chapters. Assign one chapter to each fork. Give all forks a single common prompt:

> Return the following lists of entry IDs for your chapter:
>
> 1. Entries hiding relevant information in noise.
> 2. Entries that are pure noise.
> 3. Entries that are somewhat relevant or more, with not much noise.
>
> Do not edit the entries.

Use these lists to apply the treatments below without reading every entry yourself. If a case is ambiguous, do not treat it as pure noise.

**Search for missing knowledge only if the user asks.** Otherwise, if you encounter a missing resource, tell the user. Do not start a separate search. This does not prevent you from checking the current version of an identified resource.

## Choose what to keep, edit or fold

A chapter is a unit of understanding.

### 1. Foundation: keep it in full, once

Keep the knowledge on which later knowledge and decisions are built. Depending on the job, that may include project onboarding, wider circumstances, responsibilities, tasks, and the user’s expressed intentions, whether pertaining to the project or elsewhere. The source might be a skill, document, source file, script or configuration. These are examples, not a fixed reading list.

Check what exists now on disk, not only what the agent originally read. It or another agent may have created or revised a foundational resource since onboarding. Put its full current contents in the edited window, not just a path or summary. Mark refreshed snapshots as current. Keep meaningful differences from a prior version when they explain a decision.

### 2. Recurring domains: keep the main resources live

Keep the current resources needed whenever the domain returns. Fold past chapters that are no longer needed in full. Write the note, then append a line that reads like a skill description. In the note, give enough context to recognize the topic. In the last line, name a specific condition for restoring that chapter.

Example fold note:

> The user complained the Rust editor opened slowly. Sorting the project menu by transcript modification time let the editor stop parsing every open transcript in full. Only the edited session’s fork family still needs full reads.
>
> Restore when working again on the editor’s performance.

### 3. Signal buried in noise: edit the entry. Keep the signal in full

Remove irrelevant passages. Do not summarize the useful part. Judge the amount of noise as well as its share of the entry. A 1:4 signal-to-noise ratio is a cue to inspect, not a requirement. In a 60k-token result with 20k of signal, remove the 40k of noise. Even a 100k-token result with 50k of signal can justify an edit.

Cases range from accidental context bombs to large payloads that are genuinely mostly signal, to very small relevant payloads, and anything in between. Size alone does not make content noise.

### 4. Unambiguous noise: fold it with a short note

There is no signal to extract. Leave a five-to-ten-word note. A toy example: an agent searches many locations for the active configuration file. Once it finds the file, the earlier misses have no bearing on its work. “Search misses before locating the active configuration file.”

Real world cases are often more grey area, so use common sense.

### 5. Closed detours: ask yourself what depended on them

If later work relied on the detour, retain its outcome, reason and lasting consequence richly. Keep enough evidence and qualifications to explain the later decision. Fold the execution history. On the other hand, if the detour served a bounded purpose and changed nothing that followed, leave only a short closure note.

### 6. Current work: keep the real content in full

Keep the latest chapter’s task, constraints, decisions, evidence, failures, unfinished work and next checks. Do not replace them with a progress summary. You can remove in-entry noise and repetition without changing the useful content.

## Judge repetition by meaning

Keep the last full occurrence. Fold duplicates with a short semantic reference to the kept occurrence, not its ID.

1. Skill reference: “A duplicate read of the foobar skill’s `path/to/file.md` reference.”
2. File: “A duplicate read of `path/to/file.md`.”
3. Tool result: “Same result as the workspace-name check made further down.” Name the later tool input clearly and briefly.

If only a wrapper repeats, remove the wrapper and keep the distinct payload, regardless of entry type.

**Semantic grep:** Select a few distinctive terms from the entry. Search the context for those terms, variants and synonyms. Show up to 500 characters before and after each match. Ignore false positives. Read strong candidates in full. Then judge whether they say the same thing. Different wording can repeat the same fact. An added condition, changed number or reversed decision is not a duplicate.

**Keep what the user said almost, or fully, verbatim.** If the words depend on a prior exchange, include just enough of it to make them clear. For “Yes, but only on resume,” keep the clause that identifies what resumes.

## Verify the edit

Check that required resources and current work remain in full, and that fold notes identify what to restore. Match a fork entry to the parent by content, not by ID. Up to the fork point, the inherited entry data is byte-for-byte identical. Resolve ambiguous matches by order and neighbors. Validate call/result pairs and dry-run on the target. Report measured savings and unchecked areas.

### Ask the user before starting a one-off post-edit audit fork

A fresh audit can incur a full-window cache miss, which is roughly $3–$7. Nothing dramatic. Just don’t run it automatically.

With permission, fork the edited session. Ask:

> Using only the edited window, state the task, constraints and next decision. Now compare against the original outline. Which passage, if any, would change that decision? Name it and recommend restoring it or improving its fold note. Flag retained repetition separately. Do not edit.

Check its findings. Close the fork after the audit.
