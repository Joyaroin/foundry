import * as git from "./git.js";
import * as gh from "./gh.js";
import type { RunResult, SpokeConfig } from "./types.js";

/**
 * Phase 5 — pull request, then merge.
 *
 * The merge decision is four boolean checks, all evaluated here. No model is consulted,
 * and a refusal from GitHub is reported rather than routed around: never --admin, never force.
 */
export async function ship(opts: {
  spec: number;
  repoDir: string;
  integration: string;
  base: string;
  config: SpokeConfig;
  noMerge: boolean;
  loop: Omit<RunResult, "prNumber" | "merged" | "mergeSkippedBecause">;
  log: (msg: string) => void;
}): Promise<RunResult> {
  const { spec, repoDir, integration, base, config, noMerge, loop, log } = opts;

  await git.push(integration, repoDir);

  const complete = loop.stop === "done" && loop.handedBack.length === 0;
  const body = [
    complete ? `Closes #${spec}` : `Partial run against #${spec}.`,
    ``,
    `**Closed (${loop.closed.length})**`,
    ...loop.closed.map((t) => `- #${t.ticket} ${t.title}`),
    ...(loop.handedBack.length
      ? [``, `**Handed back (${loop.handedBack.length})**`, ...loop.handedBack.map((t) => `- #${t.ticket} ${t.title} — ${t.reason?.split("\n")[0] ?? ""}`)]
      : []),
    ...(loop.stillBlocked.length
      ? [``, `**Still blocked (${loop.stillBlocked.length})**`, ...loop.stillBlocked.map((t) => `- #${t.number} ${t.title}`)]
      : []),
    ``,
    `Stop condition: **${loop.stop}**.`,
  ].join("\n");

  const pr = await gh.createPr(
    { title: `foundry: spec #${spec}`, body, base, head: integration },
    repoDir,
  );
  log(`opened PR #${pr}`);

  const result: RunResult = { ...loop, prNumber: pr, merged: false };

  // 1. A clean run only.
  if (loop.stop !== "done") {
    result.mergeSkippedBecause = `run stopped on ${loop.stop}, not done`;
    return result;
  }
  if (loop.handedBack.length > 0) {
    result.mergeSkippedBecause = `${loop.handedBack.length} ticket(s) were handed back`;
    return result;
  }
  // 2. Adham's opt-out.
  if (noMerge) {
    result.mergeSkippedBecause = "--no-merge";
    return result;
  }
  // 3. The gates, on the final integration branch.
  const gates = await git.verify(config, repoDir);
  if (!gates.ok) {
    result.mergeSkippedBecause = `final gate failed: ${gates.failed}`;
    return result;
  }
  // 4. CI.
  const checks = await gh.prChecks(pr, repoDir);
  if (!checks.ok) {
    result.mergeSkippedBecause = `PR checks not green: ${checks.detail.split("\n")[0]}`;
    return result;
  }

  const merged = await gh.mergePr(pr, repoDir);
  if (!merged.ok) {
    result.mergeSkippedBecause = `GitHub refused the merge: ${merged.detail.split("\n")[0]}`;
    return result;
  }
  result.merged = true;
  log(`merged PR #${pr}`);
  return result;
}
