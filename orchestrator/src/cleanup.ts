import { WORKTREE_DIR } from "./config.js";
import * as git from "./git.js";
import * as gh from "./gh.js";

/**
 * Remove worktrees that are finished with, and refuse to touch the ones that are not.
 *
 * `.claude/worktrees/` is shared ground: foundry's `ticket-<n>` directories sit alongside
 * whatever the developer created by hand. MediaSafe had 28 of the latter, two of them locked.
 * So this classifies before it deletes, and the classification is deliberately conservative.
 *
 * What removal actually costs is the thing that decides the rules. Removing a worktree does NOT
 * delete its branch — committed work survives and can be checked out again. Only *uncommitted*
 * changes are gone for good. So:
 *
 *   - uncommitted changes  → never removed. This is the only irreversible loss.
 *   - locked               → never removed. Locking is a deliberate act by someone.
 *   - unmerged commits     → removable, but always reported, because the branch is the thing
 *                            that survives and you should know it is now the only copy.
 */

export type Verdict = "foundry-leftover" | "removable" | "keep-dirty" | "keep-locked";

export type Candidate = {
  path: string;
  name: string;
  branch: string | null;
  verdict: Verdict;
  /** Commits the branch has that the base does not. Zero for a fully merged branch. */
  ahead: number;
  reason: string;
};

function isFoundryWorktree(path: string): boolean {
  return /\/ticket-\d+$/.test(path) && path.includes(WORKTREE_DIR);
}

export async function classify(repoDir: string): Promise<Candidate[]> {
  const base = await gh.defaultBranch(repoDir);
  const worktrees = await git.listWorktrees(repoDir);
  const out: Candidate[] = [];

  for (const wt of worktrees) {
    if (wt.isMain) continue;
    const name = wt.path.split("/").pop() ?? wt.path;
    const ahead = wt.branch ? await git.commitsAhead(wt.branch, base, repoDir) : 0;

    if (wt.locked) {
      out.push({ ...wt, name, verdict: "keep-locked", ahead, reason: "locked — someone locked this deliberately" });
      continue;
    }
    if (await git.isDirty(wt.path)) {
      out.push({ ...wt, name, verdict: "keep-dirty", ahead, reason: "has uncommitted changes, which removal would destroy" });
      continue;
    }
    if (isFoundryWorktree(wt.path)) {
      out.push({ ...wt, name, verdict: "foundry-leftover", ahead, reason: "left behind by an interrupted foundry run" });
      continue;
    }
    out.push({
      ...wt,
      name,
      verdict: "removable",
      ahead,
      // The unmerged count is carried by the note at print time, not repeated here.
      reason: ahead === 0 ? `clean, and fully merged into ${base}` : "clean",
    });
  }
  return out;
}

export async function cleanup(
  repoDir: string,
  opts: { all: boolean; apply: boolean; log: (msg: string) => void },
): Promise<void> {
  const { all, apply, log } = opts;
  const candidates = await classify(repoDir);

  if (candidates.length === 0) {
    log("no worktrees besides the main checkout");
    return;
  }

  // Without --all this only touches foundry's own leftovers: a run's debris is unambiguously
  // foundry's to clean, another developer's worktree is not.
  const targets = candidates.filter((c) =>
    all ? c.verdict === "removable" || c.verdict === "foundry-leftover" : c.verdict === "foundry-leftover",
  );
  const kept = candidates.filter((c) => !targets.includes(c));

  for (const c of targets) {
    const note = c.ahead > 0 ? `  (branch ${c.branch} keeps ${c.ahead} unmerged commit(s))` : "";
    if (apply) {
      await git.removeWorktree(repoDir, c.path);
      log(`removed  ${c.name}${note}`);
    } else {
      log(`would remove  ${c.name}  — ${c.reason}${note}`);
    }
  }
  for (const c of kept) {
    log(`keeping  ${c.name}  — ${c.reason}`);
  }

  if (apply) {
    await git.pruneWorktrees(repoDir);
    log(`\nremoved ${targets.length}, kept ${kept.length}`);
  } else {
    log(`\n${targets.length} would be removed, ${kept.length} kept. Re-run with --apply to do it.`);
    if (!all && candidates.some((c) => c.verdict === "removable")) {
      log("Add --all to also consider worktrees foundry did not create (clean and unlocked ones only).");
    }
  }
}
