---
name: foundry
description: Take one idea from grilling through spec, tickets and implementation. Attended until the spec is approved, unattended after it. Run from inside the target repo.
argument-hint: "<the idea you want built>"
disable-model-invocation: true
---

# Foundry

One idea in, merged tickets out. Five phases, one gate.

```
  ATTENDED  ──────────────────────────┐   UNATTENDED ─────────────────────────
  0 preflight → 1 grill → 2 spec ─────┤── 3 tickets → 4 build loop → 5 PR → stop
                              ▲       │
                          the only gate
```

**Phases 0–2 are a conversation with Adham.** He answers, he corrects, he approves the spec.
**Phase 3 onward runs without him.** Tickets are written and built with no further approval.
The run ends by itself when no ticket can be built — never because it ran out of things to guess at.

Read that boundary literally. After the spec approval, do not ask questions, do not present
breakdowns for review, do not pause between tickets. If you find yourself wanting to ask, the
answer belongs in the spec — which means Phase 2 finished too early, and that is a bug in the
run, not a reason to interrupt him.

## 0. Preflight

Every one of these is refuse-to-run. Check them all, report every failure at once, then stop.
Do not offer to continue past any of them.

1. **You are inside the target repo.** `git rev-parse --show-toplevel` must succeed.
   Worktree isolation builds each builder's worktree from the session's working directory
   *before* the agent starts, and nothing you pass in later can redirect it. Started outside a
   repo, the run dies after the grilling has already been spent.

2. **The working tree is clean.** `git status --porcelain` is empty. Builders branch off HEAD;
   uncommitted work would be silently inherited by every one of them.

3. **`.claude/` is gitignored here.** Worktrees are created at `<repo>/.claude/worktrees/` and are
   untracked. `/implement` tells builders to commit, and agents reach for `git add -A` — without
   this, one slice commits its siblings' entire working trees. Add the line if it is missing.

4. **`gh` is authenticated** and the repo has the five triage labels. See
   `references/tracker.md` for the label list and the commands to create them.

5. **Issue dependencies are readable.** `scripts/frontier.sh` needs them to tell a blocked ticket
   from a ready one. You cannot verify this until tickets exist, so it is checked at the top of
   Phase 4 instead — but say now that it will be.

## 1. Grill (attended)

Invoke the bundled `grilling` skill on the idea Adham passed as the argument.

This phase is his. Do not shorten it, do not infer answers to skip a round, and do not move on
because the design "seems clear enough". Everything Phase 3 onward does unattended is built out of
what this phase settles — an unasked question becomes an invented requirement four tickets deep.

Grilling is done when the frontier is empty and Adham confirms shared understanding.

## 2. Spec (attended — the gate)

Invoke the bundled `to-spec` skill. It synthesises the conversation; it does not re-interview.

Publish the spec as a GitHub issue labelled `ready-for-agent`. Then show Adham the issue number
and ask him plainly to approve it, in these words or close to them:

> Spec is #N. Approving it starts the unattended half: I write the tickets and build them all
> without checking back. Approve?

**This is the last thing you ask him.** Once he approves, everything below runs to completion or
to a reported failure.

If he does not approve, take his corrections and revise the spec. Do not proceed on a maybe.

## 3. Tickets (unattended)

Invoke the bundled `to-tickets` skill against the spec issue, with one change:

> **Skip its "Quiz the user" step entirely.** Adham has chosen to have tickets written for him.
> Draft the slices, satisfy the vertical-slice rules, and publish.

Publish each ticket as a **sub-issue of the spec** with the `ready-for-agent` label, in dependency
order so blockers exist before the tickets that name them. Record every blocking edge as a
**native GitHub dependency** — the prose "Blocked by" line is for humans; `frontier.sh` reads the
dependency. `references/tracker.md` has both commands.

Then say, once, what you built: the ticket count, and the shape of the graph (how many can start
immediately, how deep the longest chain runs). This is a status line, not a question.

## 4. Build loop (unattended)

### Set up

Run `scripts/frontier.sh <spec> --check`. If it fails, stop and report — a run that cannot read
blockers would treat a dependency chain as parallel work and build ticket 4 before ticket 1.

Create the integration branch off the default branch and stay on it:

```bash
git switch -c "foundry/spec-<spec>"
```

Every builder branches off this, and every success merges back into it. The default branch is
never touched by the loop.

### One round

Repeat until a stop condition below fires.

1. **Read the frontier.** `scripts/frontier.sh <spec>` — open, unclaimed, unblocked, `ready-for-agent`.

2. **Take up to four.** Four concurrent builders is the cap. More than that and the round's merge
   step turns into the bottleneck the parallelism was meant to remove. Extras wait for the next round.

3. **Claim each** with `gh issue edit <n> --add-assignee @me` before dispatching. The assignee is
   what keeps a ticket off the next frontier while its builder is still running.

4. **Dispatch every builder for this round in a single message**, one `Agent` call each, so they
   actually run at once. Use the `builder` agent type with `isolation: "worktree"`. Tickets in one
   round are independent by construction — they have no blocking edges between them — which is
   exactly what makes it safe to run them together. Give each builder its ticket number, the spec
   number, and the integration branch name.

5. **Land each result, in the order they come back.**

   - **Success** — the builder committed to `foundry/<ticket>-<slug>`. Merge it into the
     integration branch. Run the repo's typecheck and full test suite *after the merge*: a slice
     that was green alone can still break a sibling merged in the same round. Then
     `gh issue close <n> --comment "..."`.
   - **Merge conflict** — resolve it now, on sight, not at the end of the run. Two slices touching
     the same file is normal; the fix is a merge resolution, not a failed ticket.
   - **Failure** — the builder could not finish, or the post-merge suite fails and the cause is the
     slice itself. Revert the merge, then hand the ticket back:
     `gh issue edit <n> --remove-assignee @me --remove-label ready-for-agent --add-label ready-for-human`
     and comment with what went wrong. It leaves the frontier permanently, and anything it blocks
     will never unblock — which the loop reports as a deadlock rather than silently skipping.

6. **Recompute the frontier and go again.** Closing tickets is what unblocks the next round; this
   is the only thing that advances the loop.

### Stop conditions

Check in this order at the top of every round.

| Condition | Meaning | What you do |
|---|---|---|
| Frontier empty, `--open` empty | Every ticket is closed | **Done.** Go to Phase 5. |
| Frontier empty, `--open` non-empty | The rest are blocked by tickets that failed | **Deadlock.** Go to Phase 5 with what landed, and name the tickets that are stuck and why. |
| Two consecutive rounds close nothing | The loop is spinning | **Stall.** Stop, and report the last round's failures verbatim. |

There is no round limit beyond these. A run of thirty tickets is a long run, not a runaway one —
the queue draining is the terminating condition, and it terminates because every round either
closes a ticket or trips the stall check.

## 5. Pull request, then stop

Push the integration branch and open **one** pull request against the default branch, titled for
the spec and with `Closes #<spec>` in the body when every ticket landed.

**Do not merge it.** Adham merges. That is the whole point of the run ending at a PR: the
unattended half writes code, and a human decides whether it ships.

Clean up the round's leftovers — `git worktree prune`, and remove anything still under
`.claude/worktrees/`.

Then report and stop:

- tickets closed, and the PR number
- tickets handed back as `ready-for-human`, each with the reason
- tickets left blocked, and which failure is blocking them

Report the run honestly. A deadlocked run that built four of nine tickets is a four-of-nine run;
do not present it as a finished feature.
