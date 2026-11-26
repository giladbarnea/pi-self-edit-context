---
name: fit-context
description: Use when editing an agent’s context window to decide what to keep in full, edit, fold, or restore. Applies to the current session or a parent session edited from a fork.
---

# How to edit an agent’s context

## Mental models

An `edit_context` entry and a `compaction` entry both mark the boundary between context windows. There may be significant entry overlap between the active window and its predecessor, but nevertheless, this is how it should be thought of.
Therefore, a session's JSONL is a stack of 1 or more context windows.

This skill has two modes, where one is a superset of the other. The modes control the search space magnitude, not the DoD.
A. Perform the instructions of the skill up to a sensible depth of unfolds (unrolling an `edit_context` entry), not to the very bottom.
B. Recursively unfold the entire context window completely, then perform the skill recursively on each one, in a map-reduce fashion.

**Mode `A`:** The default. Typically done to agents with a bounded purpose and a DoD, no matter how large the task. Boosts the context window’s quality & focus, and with a bit of luck, can save a few dollars (or not, which is fine, because the quality & focus are more important).
Because it's for agents with a bounded task, it tackles a different problem than `B`. Such agents haven't seen enough many millions of tokens of widely variable subjects, events and evolution of a domain and project over weeks and months. They have seen somewhere between a few hundred thousand tokens to a couple of millions, and the subject variability is much narrower. So they have a smaller potential to lose focus. But their performance _does_ get progressively reduced starting from around ~600k. They also have another concern that ever-running agents don't: they need enough runway to finish the task (and not more). The concept of 'runway' doesn't apply to ever-running agents because they have no DoD; instead, the framing is ever-runners require repeated maintenance to keep airborne.

**Mode `B`:** Typically done to ever-running, no DoD agents. The JSONL needs >3-4 context windows. Optimizes to curate the context window with quality and focus. By design, doesn't save costs. Naturally much more time than `A`, and whereas `A` fans out to somwhere between one to a couple of context of windows (low single digits), `B`'s search space is an order of magnitude larger. Therefore, `B` runs `A`'s in a figurative for-loop.

The thing with fitting bounded task context windows (`A` mode) is to roughly maintain this abstract state:
```A healthy context window of an `A`-type agent with a bounded task, in broad strokes
[Base context like onboarding, situation and task: kept in full, loud and clear]
[Subtask-1 done: folded to keep only and all information related to it that is relevant and consequential to the current subtask]
[Subtask-2 done: folded to keep only and all information related to it that is relevant and consequential to the current subtask]
[Subtask-3 in progress: kept in full, loud and clear, minus obvious noise]    <- agent is here at this moment
// Subtask-3 is not the last, it's just where the agent is at right now.
// ...[Subtask-N]...
// [Done]
```
So in that sense it's quite simple. <Full base>, ...<folded past done steps>, <full current steps>.

With `B`, this is a little more complicated because:
- Work-topics don't progress linearly. It's not a DAG. They repeat and alternate arbitrarily.
- Work-topics affect each other arbitrarily and dynamically, and can relate in more ways to each other: may shed light on the current work-topic / contradict, etc, arbitrarily.

I've used "work-topics" and not "subtasks" intentionally: "subtasks" is the wrong word because it's directional, and is too granular anyway for `B`-type JSONL’s.

Therefore:
```A healthy `B`-type context window of an ever-running agent, in broad strokes
[Base context like onboarding, situation and responsibility: kept in full, loud and clear]
[Work-topic-1 now-irrelevant: folded to a clear placeholder bead.]
[Work-topic-2 now-partially-relevant: folded dynamically to keep only and all the information in it that is relevant and consequential to the current subtask. Some entries totally folded, some summarized, some kept in full.]
[Work-topic-1 second appearance, similarly-now-irrelevant: folded to a clear placeholder bead.]
[Work-topic-3 mostly-relevant-but-not-core: folded more lightly and dynamically to keep only and all the information in it that is relevant and consequential to the current subtask. Some entries totally folded, some summarized, some kept in full.]
[Work-topic-4 now-irrelevant, but contains 1-2 important entries, some may not directly belong to it in the first place (like a file, discovery, Skill, etc): folded to a clear placeholder bead, except the important entries which are kept in full]
[Work-topic-5 now-irrelevant, but contains information that directly affects Work-topic-3, which _is_ important: folded to a clear placeholder bead, except the important entries which are kept in full]
[Work-topic-4 second appearance, similarly-not-irrelevant, this time contains no important entries: folded to a clear placeholder bead.]
// ...This goes on arbitrarily...
[Work-topic-N in focus: kept in full, loud and clear, minus obvious noise]    <- agent is here at this moment
/// ...Life will go on, old and new work-topics will come and go, and the "healthy" context window will take the shape of the agent's current work-topic focus.
```

## How-to

### Mode `A`

> Search space: the active context window, the first window for foundation, and 2–4 windows immediately before the active one, as available. Start with the two most recent preceding windows. Compare each earlier window with the one after it. Repetition favors stopping at two or three. Relevant new or surprising information favors looking one window further back, up to four, if the curator has room.
>
> Lay out the search space flatly before diving in. If the curator can do it all directly within its current context window, it should. If its current context window is not sufficient, fan out to forks (map-reduce) of high-tier AI models with `medium` thinking level to cover the search space. Curator synthesizes.

> "High-tier" AI models, as of Nov 2026, are OpenAI’s GPT-6.1 Sol, Anthropic’s Opus 5.5, or equivalents.

#### Establish the scope

Identify the agent’s current task, standing and core responsibilities.

Map the major chapters across search space. A chapter can return after a gap. Include short entries.

For each chapter, note what category each entry belongs to:

1. Entries hiding relevant information in noise.
2. Entries that are pure noise.
3. Entries that are somewhat relevant or more, with not much noise.

#### Choose what to keep, edit or fold

A chapter is a unit of understanding.

**1. Foundation: keep it in full, once**

Keep the knowledge on which later knowledge and decisions are built. Depending on the job, that may include project onboarding, wider circumstances, responsibilities, tasks, and the user’s expressed intentions, whether pertaining to the project or elsewhere. The source might be a skill, document, source file, script or configuration. These are examples, not a fixed reading list.

Check what exists now on disk, not only what the agent originally read. It or another agent may have created or revised a foundational resource since onboarding. Put its full current contents in the edited window, not just a path or summary. Mark refreshed snapshots as current. Keep meaningful differences from a prior version when they explain a decision.

**2. Recurring domains: keep the main resources live**

Keep the current resources needed whenever the domain returns. Fold past chapters that are no longer needed in full. Write the note, then append a line that reads like a skill description. In the note, give enough context to recognize the topic. In the last line, name a specific condition for restoring that chapter.

Example fold note:

> The user complained the Rust editor opened slowly. Sorting the project menu by transcript modification time let the editor stop parsing every open transcript in full. Only the edited session’s fork family still needs full reads.
>
> Restore when working again on the editor’s performance.

**3. Signal buried in noise: edit the entry. Keep the signal in full**

Remove irrelevant passages. Do not summarize the useful part. Judge the amount of noise as well as its share of the entry. A 1:4 signal-to-noise ratio is a cue to inspect, not a requirement. In a 60k-token result with 20k of signal, remove the 40k of noise. Even a 100k-token result with 50k of signal can justify an edit.

Cases range from accidental context bombs to large payloads that are genuinely mostly signal, to very small relevant payloads, and anything in between. Size alone does not make content noise.

**4. Unambiguous noise: fold it with a short note**

There is no signal to extract. Leave a note of about ten words that names the folded bout's intent and its outcome. A toy example: an agent searches many locations for the active configuration file. Once it finds the file, the earlier misses have no bearing on its work. “Search misses before locating the active configuration file.”

Real world cases are often more grey area, so use common sense.

**5. Closed detours: ask yourself what depended on them**

If later work relied on the detour, retain its outcome, reason and lasting consequence richly. Keep enough evidence and qualifications to explain the later decision. Fold the execution history. On the other hand, if the detour served a bounded purpose and changed nothing that followed, leave only a short closure note.

**6. Current work: keep the real content in full**

Keep the latest chapter’s task, constraints, decisions, evidence, failures, unfinished work and next checks. Do not replace them with a progress summary. Remove individual unambiguous-noise entries as well as in-entry noise and repetition without changing the useful content.

---

## Mode `B`

> Search space: All context windows in the JSONL, from the first to the current. Lay out the search space flatly before diving in. The curator necessarily can not do it all directly within its current context window. Curator forks itself to high-tier AI models with the same thinking level as the curator (>= `high`), and _each of its forks_ performs `A` on its share of the context windows: they fan out _themselves_ in turn to high-tier `medium`-thinking forks to cover the search subspace. Curator-fork synthesizes its forks' results. Main curator then synthesizes the results of all curator-forks. It's a two-level map-reduce operation.

### Edge cases: more than 10 meaningful context windows

I haven't figured out the best way to tackle such a case, but forking the curator dozens of times in parallel, recursively forked further, is too expensive and the returns much diminished.
The method will have to trade off something, I'm just not sure what yet.
The tradeoff can be somewhat minimized if navigated with heuristics.
A few assumptions should guide the heuristics:
- there is a lot of repetition between context windows. Concurrent forks working duplicate information is, in principle, redundant work. This nudges towards a cross-window dedupe after flattening. The dedupe needs to be something a single high-tier fork can do. Forking to small-tier, cheap models in 'high' thinking level for classification and detection work is considered free and allowed here. I can't say with confidence how exactly to do this. Surface ideas to user. Mental models used in the fields of big data, distributed compute, databases and storage are helpful here.
- more recent context windows are probably more relevant than earlier ones.
- the couple of first context windows probably contain the important base onboarding and responsibilities.
- user messages have the biggest sway over the story of the context windows. Each user message steers the direction. they could be treated as bottoms of gravity wells, or semantic anchors, to start searches from them and climb up the well for other message types to -- perhaps -- recognize the Paerto-important non-user messages (just a guess. never tried this.) 
- small-tier models as reliable search/label/classify functions on spaces up to ~300-400k tokens, mostly-reliable on spaces up to ~600k tokens, and partially-reliable on spaces up to 1M tokens

---

## Equally true in both `A` and `B` modes

#### Keep what the user said almost, or fully, verbatim.

If the words depend on a prior exchange, include just enough of it to make them clear. For “Yes, but only on resume,” keep the clause that identifies what resumes.

#### Judge repetition by meaning

Repetition is waste. Keep only the last full occurrence. Fold duplicates with a short semantic reference to the kept occurrence, not its ID.

1. Skill reference: “A duplicate read of the foobar skill’s `path/to/file.md` reference.”
2. File: “A duplicate read of `path/to/file.md`.”
3. Tool result: “Same result as the workspace-name check made further down.” Name the later tool input clearly and briefly.

If only a wrapper if signal repeats, remove the wrapper and keep the distinct payload, regardless of entry type.

**Semantic grep:** Select a few distinctive terms from the entry. Search the context for those terms, variants and synonyms. Show up to 500 characters before and after each match. Ignore false positives. Read strong candidates in full. Then judge whether they say the same thing. Different wording can repeat the same fact. An added condition, changed number or reversed decision is not a duplicate.

#### Search for knowledge missing from or incorrect in the current context window.

Recognize in preceding context windows for knowledge missing from or incorrect in the current context window.
Update entries with stale contents of files with the latest contents from the filesystem.
Update the current context window with the latest knowledge.

---

## Wrapping up

Verify the edit:

Check that required resources and current work remain in full, and that fold notes identify what to restore. Most likely, the curator is a fork of the session to edit. Match a fork entry to the parentSession’s entry by content, not by ID. Up to the fork point, the inherited entry data is byte-for-byte identical. Resolve ambiguous matches by order and neighbors. Validate call/result pairs and dry-run on the target. Report estimated effects of the edit: tokens removed, tokens replaced, tokens added (and to what topic they roughly belong.)

---

## Post-edit audit

Ask the user whether to start a one-off post-edit audit fork:

With permission, fork the edited session. Ask:

> Using only the edited (current) window, state the task, constraints and next decision. Now compare against the original outline. Which passage, if any, would change that decision? Name it and recommend restoring it or improving its fold note. Flag retained repetition separately. Do not edit.

Check its findings. Close the fork after the audit.
