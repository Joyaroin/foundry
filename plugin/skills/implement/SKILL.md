---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Work test-first at the seams the spec's **Testing Decisions** already named. Do not invent a new
seam mid-implementation — if the named one turns out to be wrong, say so rather than quietly
testing somewhere else. Red, green, refactor, one behaviour at a time. Test external behaviour
only; a test that asserts on internals fails the next refactor and teaches you nothing.

If a `tdd` skill is installed, use it — this is a compressed version of the same discipline.

Run typechecking regularly and single test files regularly. Run the full suite once at the end.

Review your own work before calling it done: read the whole diff and say what is wrong with it.
Check it against every acceptance criterion, look for behaviour you changed but did not intend to,
and for tests that pass without actually constraining anything. If a `code-review` skill is
installed, use it instead of doing this by hand.

Commit your work to the current branch. Stage the files you changed — never `git add -A`.
