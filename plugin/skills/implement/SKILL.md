---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Work test-first, following the bundled **`tdd`** skill — it ships with this plugin and it is the
reference for what a good test is, where tests go, and the anti-patterns. Read it before the first
test, not after.

The seams are the ones the spec's **Testing Decisions** already named. Do not invent a new seam
mid-implementation; if the named one turns out to be wrong, say so and stop rather than quietly
testing somewhere else.

Run typechecking regularly and single test files regularly. Run the full suite once at the end.

Review your own work before calling it done: read the whole diff and say what is wrong with it.
Check it against every acceptance criterion, look for behaviour you changed but did not intend to,
and for tests that pass without actually constraining anything. If a `code-review` skill is
installed, use it instead of doing this by hand.

Commit your work to the current branch. Stage the files you changed — never `git add -A`.
