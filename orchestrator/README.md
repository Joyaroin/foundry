# orchestrator

The unattended half of foundry, as a program. Built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`).

```bash
cd <a spoke repo>
npx tsx /Users/adhamsedik/foundry/orchestrator/src/cli.ts run <spec-issue> [--no-merge] [--budget-usd N]
```

## Why this exists

The pipeline used to be markdown a Claude Code session read and followed. That made the loop
*advisory*: nothing stopped a session skipping a stop condition, over-dispatching builders, or
merging a run that had failures in it. Determinism is the point of the agent, so the loop moved
into code.

## What decides what

This is the whole design. The model is asked for judgement in exactly two places; everything else
is a function call.

| Decision | Who makes it |
|---|---|
| What the tickets are, and their dependency edges | **model** (`tickets.ts`, schema-enforced) |
| The code inside one ticket | **model** (`build.ts`, one builder per worktree) |
| Which tickets are eligible right now | code — `frontier.ts` |
| How many run at once | code — `MAX_PARALLEL`, `config.ts` |
| Which issue is claimed, closed, or handed back | code — `gh.ts` |
| What merges into the integration branch | code — `git.ts` |
| Whether the result is green | code — the spoke's declared `verify` commands |
| When the loop stops | code — `done` / `deadlock` / `stall` in `build.ts` |
| Whether the PR merges | code — four boolean checks in `ship.ts` |

The model never runs `gh issue create`, never merges, and never closes a ticket. The ticket-writing
agent is explicitly forbidden from touching the tracker: it writes JSON, the program validates it
(edges must point backwards, which makes a cycle unrepresentable) and publishes it.

## Files

| File | What it owns |
|---|---|
| `cli.ts` | argument parsing, preflight, phase sequencing |
| `build.ts` | the round loop, the concurrency cap, landing work, the stop conditions |
| `ship.ts` | the pull request and the four-condition merge decision |
| `tickets.ts` | spec to tickets: one agent call, then deterministic publishing |
| `frontier.ts` | which tickets are buildable — the entire scheduler, 3 functions |
| `gh.ts` | every GitHub mutation the run performs |
| `git.ts` | branches, worktrees, merges, and the verify gates |
| `agent.ts` | the one place `query()` is called |
| `sh.ts` | subprocess helpers: throwing and non-throwing |
| `config.ts` / `types.ts` | constants and shared shapes |

## What the spoke repo must provide

`foundry.config.json` at its root:

```json
{ "verify": ["npm run typecheck", "npm test"], "maxParallel": 4 }
```

`verify` is how the program knows whether work is green. It is declared, never inferred — "is it
green" must not be a judgement call. Every command runs from the repo root and must exit 0.

### Per-builder isolation

Two facts bite any repo with real tests:

1. **A fresh worktree has none of the repo's gitignored files** — no `node_modules`, and no `.env`.
   They are gitignored, so they are not in the checkout. Anything the app reads from either is
   simply missing, and the failure looks like a broken connection rather than a missing file.
2. **Concurrent builders share every external resource**, a database above all. Four builders running
   one suite against one Postgres fail for reasons that have nothing to do with their code.

`builderSetup` / `builderEnv` / `builderTeardown` fix both. Setup runs in the worktree before the
builder starts and a failure fails the ticket; teardown always runs, so a failed ticket does not leak
its database. Two placeholders are available in all three: **`{ticket}`** (what makes a builder's
resources distinct) and **`{repoRoot}`** (the main checkout — linking to its `node_modules` is far
cheaper than an install per ticket).

`verifyEnv` does the same for the gates, which run in the **main** working tree. Without it the
post-merge suite runs against whatever the developer's own `.env` points at — their real local data,
repeatedly, unattended.

A worked example, from a Next.js app whose tests need Postgres:

```json
{
  "verify": ["npm run typecheck", "npm test"],
  "maxParallel": 3,
  "verifyEnv":  { "DATABASE_URL": "postgres://user:pw@localhost:5432/app_foundry" },
  "builderEnv": { "DATABASE_URL": "postgres://user:pw@localhost:5432/app_t{ticket}" },
  "builderSetup": [
    "ln -sfn {repoRoot}/node_modules node_modules",
    "ln -sfn {repoRoot}/.env .env",
    "docker exec app-postgres createdb -U user app_t{ticket}",
    "npm run db:migrate"
  ],
  "builderTeardown": ["docker exec app-postgres dropdb --if-exists -U user app_t{ticket}"]
}
```

A repo whose tests touch nothing shared needs none of it — `verify` alone is enough.

**`verifyEnv` points at a database that must already exist and be migrated.** Creating it is a
one-off you do by hand; the program does not provision it, and an empty database fails every gate.

### `.claude/worktrees/` is not foundry's directory

A spoke may keep its own worktrees there — MediaSafe has 28, two locked. Foundry creates only
`ticket-<n>` and removes only those. It must never delete the parent directory.

## Authentication and cost

Three credential sources work, in the order the SDK resolves them. Preflight reports which one a run
will use and refuses only when none is present.

| Source | How | What it costs |
|---|---|---|
| `ANTHROPIC_API_KEY` | export the key | API rates, billed per token |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` | your Claude Code subscription |
| Claude Code OAuth on disk | just be logged in to Claude Code | your Claude Code subscription |

**Running locally, the third row needs no setup at all** — verified 2026-08-27: with no
`ANTHROPIC_API_KEY` set, `query()` authenticated off `~/.claude/.credentials.json` and returned
success. Use `claude setup-token` instead for headless or scheduled runs, where a long-lived token
beats depending on an interactive login's refresh cycle.

One caveat worth knowing rather than discovering: Anthropic's SDK terms say a third-party developer
may not **offer** claude.ai login or subscription rate limits **in a product they distribute**. That
is about shipping foundry to other people, not about running your own agent on your own account. If
this ever gets handed to someone else, they need their own credential, and an API key is the
supported path for that.

`--budget-usd N` caps each **individual** agent call, not the run total — a twelve-ticket spec is
thirteen or more calls.

**Builders run on Sonnet; the orchestrator's own calls run on Opus.** Ticket writing and conflict
resolution are the judgement calls and stay on Opus. A builder starts with its spec, its seams and
its exported symbols already decided, so what is left is writing code and getting the gates green —
and builders are where nearly all the tokens go, four at a time. Both models are named in
`config.ts` (`MODEL`, `BUILDER_MODEL`); a per-call `model` on `agent()` overrides the default.

## Two things a live run taught it

Both were found by running the whole pipeline against `Joyaroin/harness-fixture`, and neither is
visible from reading the code.

**Same-round builders collide on any file they all must create.** Every builder in a round branches
from the same base, so if the repo requires (say) a `CHANGELOG.md` entry, the second merge is an
add/add conflict. The first run handed a perfectly good ticket back over exactly that. The loop now
resolves the conflict — the model merges the text, and the tree is checked for remaining conflicts
before the gates run as normal.

**GitHub's dependency summary is eventually consistent.** A freshly written `blocked_by` edge read
back as `0`, `0`, then `1`. The build loop computes its first frontier moments after ticket creation,
so a blocked ticket can look ready and be built before its blocker exists. The first run saw
`3 ready` when only 2 were; `maxParallel: 2` is the only reason it did not build `slugify` against a
`normalise` that did not exist. `writeTickets` now waits for every edge it wrote to become visible,
and fails loudly after 60s rather than starting the loop on data it cannot trust.

## Cleaning up worktrees

```bash
foundry cleanup              # foundry's own leftovers, dry run
foundry cleanup --all        # also worktrees you made by hand, dry run
foundry cleanup --all --apply
```

Dry run by default; nothing is removed without `--apply`.

What removal actually costs decides the rules. Removing a worktree does **not** delete its branch —
committed work survives and can be checked out again. Only *uncommitted* changes are gone for good.
So:

| State | Verdict |
|---|---|
| `ticket-<n>` left by an interrupted run | removed (this is foundry's own debris) |
| clean, unlocked | removed with `--all`; any unmerged commits are reported, since the branch is now the only copy |
| uncommitted changes | **never removed** — the one irreversible loss |
| locked | **never removed** — locking is a deliberate act |

Without `--all` it touches only its own `ticket-<n>` directories. A run's debris is foundry's to
clean; another developer's worktree is not.

## Recovering an interrupted run

A claimed ticket is invisible to the frontier — that is what stops two builders taking the same one.
So a run killed mid-round leaves its tickets assigned with no builder behind them, and the next run
finds an empty frontier and reports a deadlock that is not real.

```bash
foundry release <spec-issue>
```

Un-claims every open ticket under the spec. It deliberately leaves labels alone: a ticket a builder
genuinely failed is `ready-for-human` and should stay that way.

## Exit code

`0` only when the run reached `done` with nothing handed back. Any other outcome exits `1`, so a
partial run cannot be mistaken for a finished feature by whatever called it.

## Failure is never retried

A ticket a builder fails loses `ready-for-agent` and never returns to the frontier. Anything
depending on it stops too, and the loop reports a deadlock. Re-running the program rebuilds nothing
— it is not a retry mechanism. Fix the ticket by hand, re-label it, and run again.
