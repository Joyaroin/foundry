# foundry

One idea in, a reviewable pull request out.

`/foundry` grills you on an idea, writes the spec, breaks it into dependency-aware tickets, and
then builds them all without you — parallel where they are independent, sequential where they
block each other — stopping when the queue is empty.

```
  ATTENDED  ──────────────────────────┐   UNATTENDED ─────────────────────────
  0 preflight → 1 grill → 2 spec ─────┤── 3 tickets → 4 build loop → 5 PR → stop
                              ▲       │
                          the only gate
```

You are in the loop for the grilling and the spec. After you approve the spec, nothing asks you
anything until it hands you a PR.

## Hub and spoke

This repo is the **hub**. It ships the orchestrator, the four skills it drives, and the builder
agent, as a Claude Code plugin. It is entirely self-contained — it does not read anything from
`~/.claude` and nothing here needs to stay in sync with your global setup.

Your project repos are the **spokes**. `/foundry` runs *inside* a spoke, and every issue, branch
and PR it creates belongs to that spoke. The hub holds no per-project state.

```
              ┌─────────────┐
              │   foundry   │  hub: skills, builder agent, frontier.sh
              └──────┬──────┘
        ┌────────────┼────────────┐
   ┌────▼───┐   ┌────▼───┐   ┌────▼────┐
   │tvtracker│   │MediaSafe│   │ any repo │   spokes: issues, branches, PRs
   └─────────┘   └─────────┘   └──────────┘
```

## Install

```bash
claude
> /plugin marketplace add /Users/adhamsedik/foundry
> /plugin install foundry@foundry
```

Then `cd` into any repo and run `/foundry <the thing you want built>`.

## What it needs from a spoke repo

Checked in Phase 0, all refuse-to-run:

- you are inside the repo, and the working tree is clean
- `.claude/` is gitignored (builder worktrees live at `.claude/worktrees/`)
- `gh` is authenticated, and the repo has the `ready-for-agent` / `ready-for-human` labels
- GitHub **issue dependencies** are readable — this is how blocked tickets are told from ready ones

## What's inside

| Path | What it is |
|---|---|
| `plugin/skills/foundry/` | the orchestrator — phases, the build loop, the stop conditions |
| `plugin/skills/foundry/references/tracker.md` | the GitHub issue conventions, and the `gh` commands |
| `plugin/skills/{grilling,to-spec,to-tickets,implement}/` | the four pipeline stages |
| `plugin/agents/builder.md` | builds exactly one ticket, in its own worktree, on its own branch |
| `plugin/scripts/frontier.sh` | which tickets can be built right now |

## How the loop terminates

Every round either closes a ticket or trips a check. There are exactly three ways to stop:

- **done** — no open tickets left; opens the PR
- **deadlock** — the only tickets left are blocked by ones a builder failed; opens a PR for what landed and names what is stuck
- **stall** — two consecutive rounds closed nothing

It does not merge the PR. You do.

## Failure is not retried

A ticket a builder fails is handed back as `ready-for-human` and stays off the frontier. Anything
depending on it stops too, and the run reports a deadlock. This is deliberate: a loop that retries
a failing ticket burns the whole budget on the one thing that cannot work.
