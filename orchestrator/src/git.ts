import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
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

export async function pruneWorktrees(repo: string): Promise<void> {
  await tryRun("git", ["worktree", "prune"], repo);
  const dir = join(repo, WORKTREE_DIR);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
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
): Promise<{ ok: boolean; failed?: string; detail?: string }> {
  for (const command of config.verify) {
    const r = await tryShell(command, cwd, config.verifyEnv);
    if (!r.ok) {
      const detail = [r.stdout, r.stderr].filter(Boolean).join("\n").slice(-4000);
      return { ok: false, failed: command, detail };
    }
  }
  return { ok: true };
}
