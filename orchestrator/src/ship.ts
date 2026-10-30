import { LABEL_HUMAN } from "./config.js";
import { open } from "./frontier.js";
import * as git from "./git.js";
import * as gh from "./gh.js";
import type { RunResult, SpokeConfig, Ticket } from "./types.js";

/**
 * The pull request's description, from the spec's tickets as GitHub has them.
 *
 * Not from this run's tallies: a resumed run adopts the PR an earlier run opened, and its own
 * tallies cover only what it built. Written from them, a resume that closed the last ticket listed
 * one ticket under a PR carrying all of them, and one that built nothing listed none.
 */
export function prBody(spec: number, all: Ticket[], loop: Pick<RunResult, "stop" | "handedBack">): string {
  const closed = all.filter((t) => t.state === "closed");
  const handedBack = open(all).filter((t) => t.labels.includes(LABEL_HUMAN));
  const blocked = open(all).filter((t) => !handedBack.includes(t));
  const reason = (n: number) => loop.handedBack.find((o) => o.ticket === n)?.reason?.split("\n")[0];
  const list = (heading: string, ts: Ticket[], note?: (t: Ticket) => string | undefined) =>
    ts.length
      ? [``, `**${heading} (${ts.length})**`, ...ts.map((t) => `- #${t.number} ${t.title}${note?.(t) ? ` — ${note(t)}` : ""}`)]
      : [];

  return [
    open(all).length === 0 ? `Closes #${spec}` : `Partial run against #${spec}.`,
    ...list("Closed", closed),
    ...list("Handed back", handedBack, (t) => reason(t.number)),
    ...list("Still open", blocked),
    ``,
    `Stop condition: **${loop.stop}**.`,
  ].join("\n");
}

/** Conditions 1 and 2, which need nothing but the run's own outcome. */
export function refusal(loop: Pick<RunResult, "stop" | "handedBack">, noMerge: boolean): string | undefined {
  // 1. A clean run only.
  if (loop.stop !== "done") return `run stopped on ${loop.stop}, not done`;
  if (loop.handedBack.length > 0) return `${loop.handedBack.length} ticket(s) were handed back`;
  // 2. Adham's opt-out.
  if (noMerge) return "--no-merge";
  return undefined;
}

/**
 * Phase 5 — pull request, then merge.
 *
 * The merge decision is four boolean checks, all evaluated here. No model is consulted,
 * and a refusal from GitHub is reported rather than routed around: never --admin, never force.
 */
export async function ship(opts: {
  spec: number;
  repo: string;
  repoDir: string;
  integration: string;
  base: string;
  config: SpokeConfig;
  noMerge: boolean;
  loop: Omit<RunResult, "prNumber" | "merged" | "mergeSkippedBecause">;
  log: (msg: string) => void;
}): Promise<RunResult> {
  const { spec, repo, repoDir, integration, base, config, noMerge, loop, log } = opts;

  await git.push(integration, repoDir);

  const body = prBody(spec, await gh.tickets(repo, spec, repoDir), loop);

  const { number: pr, created } = await gh.createPr(
    { title: `foundry: spec #${spec}`, body, base, head: integration },
    repoDir,
  );
  log(created ? `opened PR #${pr}` : `updated PR #${pr} (already open for ${integration})`);

  const result: RunResult = { ...loop, prNumber: pr, merged: false };

  const refused = refusal(loop, noMerge);
  if (refused) {
    result.mergeSkippedBecause = refused;
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
