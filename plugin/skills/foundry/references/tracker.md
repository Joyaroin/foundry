# Tracker: GitHub Issues

Foundry tracks everything as GitHub issues in the **spoke repo** — the repo the run is executing
in. `gh` infers it from the working directory, which Phase 0 has already established is that repo.

There is no per-repo setup file. This document is the configuration, it ships with the plugin, and
it is the same for every spoke.

## The shape of a run

```
#12  spec            label: ready-for-agent
 ├── #13 ticket      sub-issue of #12, no blockers        ← frontier, round 1
 ├── #14 ticket      sub-issue of #12, no blockers        ← frontier, round 1
 └── #15 ticket      sub-issue of #12, blocked_by #13     ← frontier, round 2
```

The spec is a plain issue. Every ticket is a **sub-issue** of it. Blocking edges are **native issue
dependencies**. `frontier.sh` walks exactly this structure; nothing else is read.

## Labels

The five canonical triage roles, label string equal to name. Foundry writes two of them:
`ready-for-agent` on everything it publishes, and `ready-for-human` on a ticket a builder failed.

| Label | Meaning |
|---|---|
| `needs-triage` | Needs evaluation |
| `needs-info` | Waiting on the reporter |
| `ready-for-agent` | Fully specified, an agent can take it |
| `ready-for-human` | Requires a human |
| `wontfix` | Will not be actioned |

Create any that are missing:

```bash
gh label create ready-for-agent --description "Fully specified, ready for an agent" --color 0E8A16
gh label create ready-for-human --description "Requires human implementation" --color D93F0B
```

## Commands

**Publish the spec**

```bash
gh issue create --title "Spec: <feature>" --label ready-for-agent --body "$(cat <<'BODY'
...spec markdown...
BODY
)"
```

**Publish a ticket as a sub-issue of the spec.** The sub-issues endpoint takes the child's numeric
**database id**, not its `#number`:

```bash
child_id=$(gh api "repos/$REPO/issues/$CHILD" --jq .id)
gh api --method POST "repos/$REPO/issues/$SPEC/sub_issues" -F sub_issue_id="$child_id"
```

**Record a blocking edge.** Also a database id, and also not the `#number`:

```bash
blocker_id=$(gh api "repos/$REPO/issues/$BLOCKER" --jq .id)
gh api --method POST "repos/$REPO/issues/$BLOCKED/dependencies/blocked_by" -F issue_id="$blocker_id"
```

Getting `#number` and `.id` the wrong way round is the single easiest mistake here, and it fails
loudly rather than silently — a 404, not a wrong edge.

**Claim / hand back / close**

```bash
gh issue edit  <n> --add-assignee @me
gh issue edit  <n> --remove-assignee @me --remove-label ready-for-agent --add-label ready-for-human
gh issue close <n> --comment "Built in <branch>, merged into <integration branch>."
```

**Merge the run's PR**

```bash
gh pr checks <pr> --watch          # must pass before the merge, or have no checks at all
gh pr merge  <pr> --merge --delete-branch
```

`--merge`, never `--squash`: each ticket is its own commit, and the ticket numbers in that history
are how a later run's `git log` explains itself. Never `--admin` — see the plugin's merge rules.

## Why the assignee matters

`frontier.sh` drops any ticket with an assignee. Claiming a ticket *before* dispatching its builder
is what keeps the next round from handing the same ticket to a second agent. Un-assigning is
therefore how a failed ticket is released — and foundry deliberately does not release it, so that
a failure stops the chain that depends on it instead of being retried forever.
