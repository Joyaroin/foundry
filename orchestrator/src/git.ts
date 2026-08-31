import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run, tryRun, tryShell } from "./sh.js";
import { WORKTREE_DIR } from "./config.js";
import type { SpokeConfig } from "./types.js";

export async function repoRoot(cwd: string): Promise<string> {
  return run("git", ["rev-parse", "--show-toplevel"], cwd);
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await run("git", ["status", "--porcelain"], cwd)) === "";
}

export async function currentBranch(cwd: string): Promise<string> {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function createBranch(name: string, from: string, cwd: string): Promise<void> {
  await run("git", ["switch", "-c", name, from], cwd);
}

export async function switchTo(name: string, cwd: string): Promise<void> {
  await run("git", ["switch", name], cwd);
}

/**
 * A worktree per builder, so concurrent builders cannot see or clobber each other's
 * working trees. Created from the integration branch's current commit.
 */
export async function addWorktree(repo: string, ticket: number, base: string): Promise<string> {
  const path = join(repo, WORKTREE_DIR, `ticket-${ticket}`);
  if (existsSync(path)) await removeWorktree(repo, path);
  await run("git", ["worktree", "add", "--detach", path, base], repo);
  return path;
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await tryRun("git", ["worktree", "remove", "--force", path], repo);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
}

/**
 * Clean up only the worktrees THIS run created.
 *
 * `.claude/worktrees/` is not foundry's directory. A spoke may keep dozens of its own worktrees
 * there — MediaSafe had 28, two of them locked — and an earlier version of this function deleted
 * the whole directory, which would have destroyed every one of them. Never remove the parent, and
 * never touch a path foundry did not create: builder worktrees are always `ticket-<n>`.
 */
export async function pruneWorktrees(repo: string): Promise<void> {
  const dir = join(repo, WORKTREE_DIR);
  if (existsSync(dir)) {
    for (const entry of await readdir(dir)) {
      if (/^ticket-\d+$/.test(entry)) await removeWorktree(repo, join(dir, entry));
    }
  }
  await tryRun("git", ["worktree", "prune"], repo);
}

export type WorktreeInfo = {
  path: string;
  /** Branch name without refs/heads/, or null for a detached checkout. */
  branch: string | null;
  locked: boolean;
  /** True for the repository's own main checkout, which is never a removal candidate. */
  isMain: boolean;
};

/** Every worktree of this repo, main checkout included. */
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await run("git", ["worktree", "list", "--porcelain"], repo);
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
        locked: current.locked ?? false,
        isMain: current.path === repo,
      });
    }
    current = {};
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }
  flush();
  return worktrees;
}

/** Uncommitted changes in a worktree. This is the only thing removal can destroy for good. */
export async function isDirty(worktreePath: string): Promise<boolean> {
  const r = await tryRun("git", ["status", "--porcelain"], worktreePath);
  return !r.ok || r.stdout !== "";
}

/** Commits on `branch` that `base` does not have. The branch survives removal, so this is a signal, not a loss. */
export async function commitsAhead(branch: string, base: string, repo: string): Promise<number> {
  const r = await tryRun("git", ["rev-list", "--count", `${base}..${branch}`], repo);
  return r.ok ? Number(r.stdout) || 0 : 0;
}

export async function branchExists(name: string, cwd: string): Promise<boolean> {
  return (await tryRun("git", ["rev-parse", "--verify", `refs/heads/${name}`], cwd)).ok;
}

/** Merge a builder's branch into the integration branch. Reports conflict rather than throwing. */
export async function mergeBranch(
  branch: string,
  cwd: string,
): Promise<{ ok: boolean; conflict: boolean; detail: string }> {
  const r = await tryRun("git", ["merge", "--no-ff", "-m", `Merge ${branch}`, branch], cwd);
  if (r.ok) return { ok: true, conflict: false, detail: "merged" };
  const conflict = /conflict/i.test(`${r.stdout}\n${r.stderr}`);
  return { ok: false, conflict, detail: (r.stderr || r.stdout).trim() };
}

export async function abortMerge(cwd: string): Promise<void> {
  await tryRun("git", ["merge", "--abort"], cwd);
}

/** Paths git could not merge on its own. Empty means the conflict is resolved. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await run("git", ["diff", "--name-only", "--diff-filter=U"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Finish a merge whose conflicts have been resolved and staged. */
export async function commitMerge(cwd: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const r = await tryRun("git", ["commit", "--no-edit", "-m", message], cwd);
  return { ok: r.ok, detail: (r.stderr || r.stdout).trim() };
}

/** Undo the last merge commit. Used when a slice merges cleanly but fails the gates. */
export async function revertLastMerge(cwd: string): Promise<void> {
  await run("git", ["reset", "--hard", "HEAD~1"], cwd);
}

export async function push(branch: string, cwd: string): Promise<void> {
  await run("git", ["push", "-u", "origin", branch], cwd);
}

/**
 * The spoke's declared gate commands. Green means every one exits 0.
 * They are declared in foundry.config.json, never inferred — "is it green" must not be a judgment call.
 * `verifyEnv` keeps a database-backed suite off the developer's own local data.
 */
export async function verify(
  config: SpokeConfig,
  cwd: string,
  /** Called with each gate command before it runs. A gate can take minutes; without this the
   *  run looks wedged between "merging" and a verdict. */
  onCommand?: (command: string) => void,
): Promise<{ ok: boolean; failed?: string; detail?: string }> {
  for (const command of config.verify) {
    onCommand?.(command);
    const r = await tryShell(command, cwd, config.verifyEnv);
    if (!r.ok) {
      const detail = [r.stdout, r.stderr].filter(Boolean).join("\n").slice(-4000);
      return { ok: false, failed: command, detail };
    }
  }
  return { ok: true };
}
