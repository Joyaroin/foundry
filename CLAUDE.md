# foundry

A Claude Code plugin: the `/foundry` pipeline — grill → spec → tickets → parallel build → PR.
Attended through the spec, unattended after it. See `README.md` for the shape.

## Status

v0.1.0, unproven. Written 2026-08-27, not yet run against a real spoke repo end to end.
Do not describe it as working until it has drained a real ticket queue — say what has and has not
been exercised.

## The constraint that shapes this repo

Its predecessor, `/ship` in `Joyaroin/claude-config`, was 1,889 lines and got deleted unused
(`3c1aa4a`, 2026-08-18) because Adham could not own it. **Comprehensibility outranks capability
here.** Every file must be readable in one sitting by someone who did not write it.

Concretely: no clever shell, no generated control flow, no abstraction with one caller. If a
feature needs a mechanism he would have to study to modify, the feature loses. When you add
something, the honest question is not "does this work" but "could he change it next month".

## Self-containment

This plugin reads nothing from `~/.claude` and syncs with nothing there. The four pipeline skills
are **vendored copies** and have already diverged from their originals on purpose:

- `to-tickets` had its "quiz the user" step replaced — foundry publishes tickets unattended
- `to-tickets` lost its local-markdown tracker branch — GitHub Issues only
- `to-spec` / `to-tickets` point at `foundry/references/tracker.md` instead of a per-repo setup skill
- `implement` inlines the TDD and self-review discipline instead of calling `/tdd` and `/code-review`,
  which this plugin does not ship

Do not "fix" these back toward the originals, and do not pull updates from `~/.claude/skills/`.

## Hub and spoke

The hub holds no per-project state. Every issue, branch and PR belongs to the spoke repo the run
executes in. Nothing project-specific gets written here — that was the failure mode that pushed
project status out of the global `CLAUDE.md` in the first place.

## Rules for the unattended half

- **The spec approval is the only gate.** Adding a second place that asks Adham a question defeats
  the design. If a phase needs an answer, the spec should have carried it.
- **Never merge the PR.** The run ends at a PR a human merges.
- **Never retry a failed ticket.** It becomes `ready-for-human` and the chain behind it deadlocks,
  loudly.
- **Report honestly.** Four of nine tickets is a four-of-nine run.
