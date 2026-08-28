---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, then wait for the user's answers before the next round.

**Ask with the `AskUserQuestion` tool, never as prose.** Adham asked for this directly (2026-08-16): a prose round makes him retype an answer he could have clicked. One question per tool entry, each carrying its real options. The tool caps a call at four questions — when the frontier is wider, issue back-to-back calls in the same round rather than dropping questions or pushing them into a later round.

Put your recommendation **first in the options list**, with `(Recommended)` on its label. Options are the choices themselves, never "yes"/"no" — spell out what each one actually does. Findings, evidence and `file:line` references go in the prose _before_ the tool call, so the question body stays short enough to read inside a picker.

A question you cannot recommend an answer to is still a question: offer the real alternatives, and say in the prose that you have no recommendation and why.

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
