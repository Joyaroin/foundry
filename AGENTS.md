# foundry

The `/foundry` pipeline — grill → spec → tickets → parallel build → PR → merge. A Codex
plugin for the attended half, an Agent SDK program (`orchestrator/`) for the unattended half.
Attended through the spec, unattended after it. See `README.md` for the shape.

## Status

v0.2.0, unproven. Written 2026-08-27, not yet run against a real spoke repo end to end.
The orchestrator typechecks against the installed SDK; no live run has happened.
Do not describe it as working until it has drained a real ticket queue — say what has and has not
been exercised.

## The two constraints, and the order they came in

**Comprehensibility.** Its predecessor, `/ship` in `Joyaroin/Codex-config`, was 1,889 lines and got
deleted unused (`3c1aa4a`, 2026-08-18) because Adham could not own it. No clever shell, no generated
control flow, no abstraction with one caller. When you add something, the honest question is not
"does this work" but "could he change it next month".

**Determinism.** On 2026-08-27 Adham asked for the Codex Agent SDK, having been told the tradeoff:
a markdown loop is advisory, and nothing stops a session skipping a stop condition or merging a run
with failures in it. His words: *"i want the determinism. thats the point of this agent."*

These pull against each other and the resolution is a split, not a compromise. Phases 0-2 stay
markdown because grilling is a conversation. Phases 3-5 are TypeScript because they must not drift.
**Anything that decides the shape of a run belongs in code**; the model is asked for judgement in
exactly two places — what the tickets are, and the code inside one ticket. `orchestrator/README.md`
holds that table, and it is the contract. Moving a decision from code back into a prompt undoes the
thing Adham asked for.

## Self-containment

This plugin reads nothing from `~/.Codex` and syncs with nothing there. The vendored skills have
already diverged from their originals on purpose:

- `to-tickets` had its "quiz the user" step replaced — foundry publishes tickets unattended
- `to-tickets` lost its local-markdown tracker branch — GitHub Issues only
- `to-spec` / `to-tickets` point at `foundry/references/tracker.md` instead of a per-repo setup skill
- `implement` points at the bundled `tdd` skill, and inlines the self-review discipline instead of
  calling `code-review`, which this plugin does not ship
- `to-tickets` is invoked by the orchestrator with an override forbidding it to touch the tracker:
  it returns a breakdown, and the program publishes. A model that calls `gh issue create` here
  would put a hallucinated dependency edge into the frontier and corrupt the whole run
- `tdd` no longer asks anyone to confirm seams — the spec's Testing Decisions settled them, and a
  builder that asks a question stalls its whole round. Its `codebase-design` and `code-review`
  references are now conditional or redirected for the same reason

Do not "fix" these back toward the originals, and do not pull updates from `~/.Codex/skills/`.

## Hub and spoke

The hub holds no per-project state. Every issue, branch and PR belongs to the spoke repo the run
executes in. Nothing project-specific gets written here — that was the failure mode that pushed
project status out of the global `AGENTS.md` in the first place.

## Auth

Local runs use Codex's own OAuth credentials — verified 2026-08-27, `query()` with no
`ANTHROPIC_API_KEY` authenticated off `~/.Codex/.credentials.json` and succeeded. So a run costs
subscription quota, not API billing. `src/auth.ts` reports which of the three sources preflight
found; it does not do the resolving, the SDK does.

Do not reintroduce a hard `ANTHROPIC_API_KEY` requirement. An earlier draft had one, and it was
wrong: it would have refused to start a run that authenticates perfectly well.

## Model-to-code handoffs

Both agent calls use `outputFormat: { type: "json_schema" }`. The SDK validates and retries on a
mismatch, so control flow never interprets prose. Verified live 2026-08-27.

An earlier draft had each agent write a JSON file the program then read. Do not go back to that: it
added a failure mode (model forgets the file), needed hand-written validation the schema does for
free, and its stated justification — that the file survives for debugging — was false, since the
builder's worktree is deleted in a `finally` block.

Schemas describe, they never verify. Keep the `git.branchExists()` cross-check and keep "green"
coming from `git.verify()` exit codes. And keep the backwards-edge check in `tickets.ts`: a JSON
Schema cannot express it, and it is what makes a dependency cycle unrepresentable.

## Never delete `.Codex/worktrees/`

A spoke keeps its own worktrees there — MediaSafe has 28, two of them locked. `pruneWorktrees`
once deleted the whole directory and would have destroyed all of them. It now removes only
`ticket-<n>` paths, which are the only ones foundry creates. Do not "simplify" it back to an rm
of the parent.

## Rules for the unattended half

- **The spec approval is the only gate.** Adding a second place that asks Adham a question defeats
  the design. If a phase needs an answer, the spec should have carried it.
- **Merge only a clean run.** Adham asked for self-merge on 2026-08-27, overruling the original
  no-merge rule. It fires only on `done` + green suite + green CI + no `--no-merge`. A deadlocked
  or stalled run leaves its PR open — those contain failed tickets by definition.
- **Never `--admin`, never force, never retry a refused merge.** Branch protection is a decision
  Adham already made. An unattended run that routes around it is the failure mode that makes the
  whole pipeline untrustworthy.
- **Never retry a failed ticket.** It becomes `ready-for-human` and the chain behind it deadlocks,
  loudly.
- **Report honestly.** Four of nine tickets is a four-of-nine run.
