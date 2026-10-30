---
name: foundry
description: Take one idea from grilling through spec, tickets, implementation and merge. Attended until the spec is approved, unattended after it. Run from inside the target repo.
argument-hint: "<the idea you want built> [--no-merge]"
disable-model-invocation: true
---

# Foundry

One idea in, merged tickets out. Five phases, one gate.

```
  ATTENDED  ──────────────────────────┐   UNATTENDED ─────────────────────────
  0 preflight → 1 grill → 2 spec ─────┤── 3 tickets → 4 build loop → 5 PR → merge → stop
                              ▲       │
                          the only gate
```

**Phases 0–2 are a conversation with the user.** They answer, they correct, they approve the spec.
**Phase 3 onward runs without them.** Tickets are written, built, and — on a clean run — merged, with
no further approval. The run ends by itself when no ticket can be built, never because it ran out
of things to guess at.

Read that boundary literally. After the spec approval, do not ask questions, do not present
breakdowns for review, do not pause between tickets. If you find yourself wanting to ask, the
answer belongs in the spec — which means Phase 2 finished too early, and that is a bug in the
run, not a reason to interrupt them.

## 0. Preflight

The program runs its own preflight and refuses on anything it finds. Yours exists so a failure
surfaces *before* the grilling is spent, not after. Check these, report every failure at once,
then stop — do not offer to continue past any of them.

1. **You are inside the target repo.** `git rev-parse --show-toplevel` must succeed, and it must be
   the repo the feature belongs in.

2. **The working tree is clean.** `git status --porcelain` is empty. Builders branch off the
   integration branch; uncommitted work would be inherited by every one of them.

3. **`.claude/` is gitignored here.** Builder worktrees are created at `<repo>/.claude/worktrees/`.
   Without this, one slice commits its siblings' entire working trees. Add the line if missing.

4. **`foundry.config.json` exists at the repo root** and declares `verify` commands. This is how the
   program knows what "green" means; it will not guess. See **What the program needs** below.

5. **`gh` is authenticated**, and **GitHub issue dependencies are readable on this repo** — the
   frontier is computed from `issue_dependencies_summary.blocked_by`, and without it the program
   cannot tell a blocked ticket from a ready one. It refuses rather than treating everything as
   unblocked and building the whole graph at once.

6. **A credential the SDK can find.** Being logged in to Claude Code is enough — it uses those
   OAuth credentials and draws on the subscription. `CLAUDE_CODE_OAUTH_TOKEN` (from
   `claude setup-token`) and `ANTHROPIC_API_KEY` also work. The program prints which one it found
   and refuses only when there is none.

Not a precondition, but note it here: if they passed **`--no-merge`**, the run stops at an open PR
instead of merging. It changes nothing until the program's final phase, but the Phase 2 gate has to
say which way this run is going — the thing they approve must be the thing that happens.

## 1. Grill (attended)

Invoke the bundled `grilling` skill on the idea the user passed as the argument.

This phase is theirs. Do not shorten it, do not infer answers to skip a round, and do not move on
because the design "seems clear enough". Everything Phase 3 onward does unattended is built out of
what this phase settles — an unasked question becomes an invented requirement four tickets deep.

Grilling is done when the frontier is empty and the user confirms shared understanding.

## 2. Spec (attended — the gate)

Invoke the bundled `to-spec` skill. It synthesises the conversation; it does not re-interview.

Publish the spec as a GitHub issue labelled `ready-for-agent`. Then show the user the issue number
and ask them plainly to approve it, in these words or close to them:

> Spec is #N. Approving it starts the unattended half: I write the tickets, build them all, and
> merge the PR if the whole queue lands green — without checking back. Approve?

**This is the last thing you ask them.** Once they approve, everything below runs to completion or
to a reported failure.

If they do not approve, take their corrections and revise the spec. Do not proceed on a maybe.

## 3-5. Hand off to the program

Everything after the spec approval is a TypeScript program built on the Claude Agent SDK, not
instructions you follow. Run it from the repo root:

```bash
cd <the spoke repo>
foundry run <spec> [--no-merge] [--budget-usd N]
```

It does the rest: writes the tickets, drains the frontier in parallel, opens the PR, and merges it
if the run came out clean. Stream its output to the user as it goes; do not re-implement any of it by
hand, and do not "help" by creating issues, merging branches or closing tickets yourself. Every one
of those is a decision the program makes deterministically, and a second actor doing them corrupts
the run.

**Why this half is code.** The loop, the frontier, the four-builder cap, the stop conditions, the
merge decision and every GitHub mutation are `if` statements and function calls — things a model
cannot skip, mis-count or talk itself out of. The model still writes the tickets and the code; it
just no longer decides what happens to them. That determinism is the point of the split, and
`orchestrator/README.md` says which decision lives where.

**If it exits non-zero**, the run did not finish cleanly. Report its output verbatim — the stop
condition, the handed-back tickets and the reason each one failed. Do not re-run it to "try again":
a failed ticket is deliberately never retried, so a second run rebuilds nothing and only re-opens
the same deadlock. Running again is how a run *resumes* once the user has fixed a handed-back ticket
and re-labelled it `ready-for-agent`: the program sees the tickets already exist, reuses them and
the open PR, and writes none.

If it stopped because the spec is missing a decision, it says which one and has commented it on the
spec. That is Phase 2 finishing too early: revise the spec with them, then run again.

## What the program needs

- **`foundry.config.json` at the spoke repo root**, declaring the gate commands. Foundry will not
  guess what "green" means:

  ```json
  { "verify": ["npm run typecheck", "npm test"], "maxParallel": 4 }
  ```

- **A credential.** Claude Code's own OAuth login is enough for a local run and costs subscription
  quota rather than API billing; `claude setup-token` gives a long-lived token for headless runs;
  `ANTHROPIC_API_KEY` bills at API rates. Preflight names the one it will use.
