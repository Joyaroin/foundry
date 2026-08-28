#!/usr/bin/env bash
#
# frontier.sh -- which tickets can be built right now?
#
#   frontier.sh <spec-issue>          the frontier: open, unclaimed, unblocked tickets
#   frontier.sh <spec-issue> --open   every open ticket, blocked or not
#   frontier.sh <spec-issue> --check  verify GitHub issue dependencies are readable
#
# Output is one ticket per line: "<number><TAB><title>".
# No output at all means the set is empty -- that is how /foundry knows it is done.
#
# A ticket is on the frontier when all four are true:
#   open, no assignee, labelled ready-for-agent, zero OPEN blockers.
#
# GitHub's native issue dependencies are the single source of truth for blockers.
# The "Blocked by" prose in a ticket body is documentation for humans, not a gate.

set -euo pipefail

spec="${1:?usage: frontier.sh <spec-issue-number> [--open|--check]}"
mode="${2:-frontier}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# Ticket numbers under the spec, in creation order --
# which to-tickets guarantees is dependency order.
children() {
  gh api --paginate "repos/$repo/issues/$spec/sub_issues" --jq '.[].number'
}

case "$mode" in
  --check)
    first="$(children | head -1)"
    if [ -z "$first" ]; then
      echo "no sub-issues under #$spec -- nothing to build" >&2
      exit 3
    fi
    if ! gh api "repos/$repo/issues/$first" --jq 'has("issue_dependencies_summary")' | grep -qx true; then
      echo "issue dependencies are not readable on $repo --" >&2
      echo "/foundry cannot tell blocked tickets from ready ones. Stopping." >&2
      exit 4
    fi
    echo "ok: $repo reports issue dependencies" >&2
    exit 0
    ;;

  --open)
    filter='select(.state == "open")'
    ;;

  frontier)
    filter='select(.state == "open")
          | select(.assignee == null)
          | select([.labels[].name] | index("ready-for-agent"))
          | select(.issue_dependencies_summary.blocked_by == 0)'
    ;;

  *)
    echo "unknown mode: $mode (expected --open or --check)" >&2
    exit 2
    ;;
esac

for n in $(children); do
  gh api "repos/$repo/issues/$n" --jq "$filter | [.number, .title] | @tsv"
done
