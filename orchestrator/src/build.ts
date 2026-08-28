import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { agent } from "./agent.js";
import { MAX_PARALLEL, REPORT_FILE, STALL_ROUNDS } from "./config.js";
import { frontier, open, stranded } from "./frontier.js";
import * as git from "./git.js";
import * as gh from "./gh.js";
import type { BuilderReport, RunResult, SpokeConfig, Ticket, TicketOutcome } from "./types.js";

/**
 * Phase 4 — the build loop.
 *
 * The model writes code. Everything that decides the shape of the run is here, in code:
 * which tickets are eligible, how many run at once, what merges, what counts as green,
 * what closes, what is handed back, and when the loop stops.
 */

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function builderPrompt(t: Ticket, spec: number, integration: string, branch: string): string {
  return [
    `You are the foundry builder. Build exactly one ticket: #${t.number} — ${t.title}`,
    ``,
    `Follow the /foundry:implement skill, which works test-first through the /foundry:tdd skill.`,
    `Read the ticket with: gh issue view ${t.number} --comments`,
    `Read the spec with:   gh issue view ${spec} --comments`,
    `The spec's Testing Decisions name your seams and the exported symbols under test. Use those names exactly.`,
    ``,
    `You are in your own git worktree, cut from "${integration}". Other builders are working on other`,
    `tickets in their own worktrees right now. Only your own branch is safe to touch.`,
    ``,
    `1. Create your branch:  git switch -c ${branch}`,
    `2. Build the ticket, test-first. Stage only the files you changed — never \`git add -A\`.`,
    `3. Commit to ${branch}. Do NOT push, do NOT merge, do NOT switch to "${integration}",`,
    `   do NOT close the issue, and do NOT open a pull request. The orchestrator does all of that.`,
    `4. Stay inside your ticket's acceptance criteria. Note anything else you find; do not fix it.`,
    ``,
    `Finally, write ${REPORT_FILE} in your worktree root, as JSON of exactly this shape:`,
    ``,
    `{"outcome":"success"|"failure","ticket":${t.number},"branch":"${branch}",`,
    ` "summary":"one or two sentences on the behaviour that now works",`,
    ` "error":"only when outcome is failure: what blocked you, and the exact error",`,
    ` "noticed":["real problems outside this ticket you deliberately did not fix"]}`,
    ``,
    `Report "failure" honestly. A ticket handed back with a clear error costs one ticket.`,
    `A ticket reported green that is not green costs the whole round.`,
  ].join("\n");
}

/** Run one ticket to completion in its own worktree. Never throws; a crash is a failure report. */
async function build(
  t: Ticket,
  spec: number,
  repoDir: string,
  integration: string,
  budgetUsd: number | undefined,
): Promise<BuilderReport> {
  const branch = `foundry/${t.number}-${slug(t.title)}`;
  let worktree: string | undefined;

  try {
    worktree = await git.addWorktree(repoDir, t.number, integration);
    const run = await agent(builderPrompt(t, spec, integration, branch), {
      cwd: worktree,
      maxTurns: 300,
      ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
    });

    let report: BuilderReport;
    try {
      report = JSON.parse(await readFile(join(worktree, REPORT_FILE), "utf8")) as BuilderReport;
    } catch {
      return {
        outcome: "failure",
        ticket: t.number,
        branch,
        summary: "",
        error: `builder wrote no readable ${REPORT_FILE} (${run.detail}). Last words:\n${run.text.slice(-1500)}`,
      };
    }

    // The report is the builder's claim; the branch existing is the fact. Trust the fact.
    if (report.outcome === "success" && !(await git.branchExists(branch, repoDir))) {
      return {
        outcome: "failure",
        ticket: t.number,
        branch,
        summary: report.summary ?? "",
        error: `builder reported success but never created branch ${branch}`,
      };
    }
    return { ...report, ticket: t.number, branch };
  } catch (e) {
    return {
      outcome: "failure",
      ticket: t.number,
      branch,
      summary: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (worktree) await git.removeWorktree(repoDir, worktree);
  }
}

/**
 * Land one builder's work. Serialized across the round: merges and gate runs both
 * touch the integration branch, and two at once would race.
 */
async function land(
  report: BuilderReport,
  t: Ticket,
  repoDir: string,
  config: SpokeConfig,
): Promise<TicketOutcome> {
  if (report.outcome === "failure") {
    const reason = report.error ?? "builder reported failure without an error";
    await gh.handBack(t.number, `Builder could not finish this ticket.\n\n\`\`\`\n${reason.slice(0, 4000)}\n\`\`\``, repoDir);
    return { ticket: t.number, title: t.title, result: "handed-back", reason };
  }

  const merge = await git.mergeBranch(report.branch, repoDir);
  if (!merge.ok) {
    if (merge.conflict) await git.abortMerge(repoDir);
    const reason = `merge into the integration branch failed: ${merge.detail}`;
    await gh.handBack(t.number, `${reason}\n\nResolve by hand and re-run.`, repoDir);
    return { ticket: t.number, title: t.title, result: "handed-back", reason };
  }

  // A slice that was green alone can still break a sibling merged in the same round.
  const gates = await git.verify(config, repoDir);
  if (!gates.ok) {
    await git.revertLastMerge(repoDir);
    const reason = `post-merge gate failed: ${gates.failed}\n\n${gates.detail ?? ""}`;
    await gh.handBack(t.number, `Merged cleanly but failed the repo's gates, so the merge was reverted.\n\n\`\`\`\n${reason.slice(0, 4000)}\n\`\`\``, repoDir);
    return { ticket: t.number, title: t.title, result: "handed-back", reason };
  }

  await gh.closeTicket(t.number, `Built in \`${report.branch}\`, merged and green.\n\n${report.summary}`, repoDir);
  return { ticket: t.number, title: t.title, result: "closed" };
}

export async function buildLoop(opts: {
  spec: number;
  repoDir: string;
  repo: string;
  integration: string;
  config: SpokeConfig;
  budgetUsd?: number;
  log: (msg: string) => void;
}): Promise<Omit<RunResult, "prNumber" | "merged" | "mergeSkippedBecause">> {
  const { spec, repoDir, repo, integration, config, log } = opts;
  const cap = Math.max(1, config.maxParallel ?? MAX_PARALLEL);

  const closed: TicketOutcome[] = [];
  const handedBack: TicketOutcome[] = [];
  let quietRounds = 0;
  let round = 0;

  for (;;) {
    const all = await gh.tickets(repo, spec, repoDir);
    const ready = frontier(all);
    const stillOpen = open(all);

    if (ready.length === 0) {
      if (stillOpen.length === 0) {
        return { stop: "done", closed, handedBack, stillBlocked: [] };
      }
      return { stop: "deadlock", closed, handedBack, stillBlocked: stranded(all) };
    }

    round += 1;
    const batch = ready.slice(0, cap);
    log(`round ${round}: building ${batch.map((t) => `#${t.number}`).join(", ")} (${ready.length} ready, cap ${cap})`);

    // Claim before dispatch: the assignee is what keeps the next round off these tickets.
    for (const t of batch) await gh.claim(t.number, repoDir);

    // Builders run concurrently; landing is serialized below.
    const reports = await Promise.all(
      batch.map((t) => build(t, spec, repoDir, integration, opts.budgetUsd)),
    );

    let closedThisRound = 0;
    for (const [i, report] of reports.entries()) {
      const t = batch[i];
      if (!t) continue;
      const outcome = await land(report, t, repoDir, config);
      if (outcome.result === "closed") {
        closed.push(outcome);
        closedThisRound += 1;
        log(`  #${t.number} closed`);
      } else {
        handedBack.push(outcome);
        log(`  #${t.number} handed back: ${outcome.reason?.split("\n")[0] ?? "unknown"}`);
      }
    }

    await rm(join(repoDir, REPORT_FILE), { force: true });

    quietRounds = closedThisRound === 0 ? quietRounds + 1 : 0;
    if (quietRounds >= STALL_ROUNDS) {
      const all2 = await gh.tickets(repo, spec, repoDir);
      return { stop: "stall", closed, handedBack, stillBlocked: stranded(all2) };
    }
  }
}
