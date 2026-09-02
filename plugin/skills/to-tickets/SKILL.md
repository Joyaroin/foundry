---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker — edges as text in one file per ticket locally, or native blocking links on a real tracker.
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

The tracker is GitHub Issues and the label vocabulary is fixed. Both are documented in `foundry/references/tracker.md`, which ships with this plugin — read it rather than looking for per-repo setup.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. State the breakdown

Foundry runs this step **unattended** — Adham chose to have tickets written for him, and the spec
he already approved is the approval. Do not present the breakdown for review and do not iterate
with him.

Say once, as a status line, what you are about to publish:

- how many tickets, and their titles in dependency order
- how many can start immediately
- how deep the longest blocking chain runs

Then publish. If the breakdown genuinely cannot be drawn from the spec — the spec is silent on
something a ticket needs — that is a defect in the spec, not a question for him. Say so plainly
and stop the run rather than inventing the missing decision.

### 5. Publish the tickets to GitHub

Publish the tickets to the spoke repo's GitHub Issues, in dependency order (blockers first) so
each ticket's blocking edges can reference real numbers. Each ticket is a **sub-issue of the spec**,
labelled `ready-for-agent`, with every blocking edge recorded as a **native GitHub dependency** —
that dependency is what the frontier (`orchestrator/src/frontier.ts`) reads to decide what can be built. The prose "Blocked by"
line stays in the body for humans.

`foundry/references/tracker.md` has the exact `gh` commands, including the one trap: sub-issue and
dependency endpoints take an issue's numeric **database id**, not its `#number`.

Do NOT close or modify the spec issue.

Publish in **frontier order**: a ticket goes up once every ticket that blocks it already exists,
so its dependency edges can point at real numbers. For a purely linear chain that means top to bottom.

<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
