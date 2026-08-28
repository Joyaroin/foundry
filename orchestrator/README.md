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
| What the tickets are, and their dependency edges | **model** (`tickets.ts`, as validated JSON) |
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

## Exit code

`0` only when the run reached `done` with nothing handed back. Any other outcome exits `1`, so a
partial run cannot be mistaken for a finished feature by whatever called it.

## Failure is never retried

A ticket a builder fails loses `ready-for-agent` and never returns to the frontier. Anything
depending on it stops too, and the loop reports a deadlock. Re-running the program rebuilds nothing
— it is not a retry mechanism. Fix the ticket by hand, re-label it, and run again.
