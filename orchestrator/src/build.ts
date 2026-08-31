import { agent } from "./agent.js";
import { MAX_PARALLEL, STALL_ROUNDS } from "./config.js";
import { tryShell } from "./sh.js";
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

/**
 * The builder's report shape, enforced by the SDK rather than parsed out of prose or a file the
 * builder has to remember to write. `ticket` and `branch` are set by the orchestrator afterwards —
 * they are facts it already knows, not claims to accept from the builder.
 */
const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary"],
  properties: {
    outcome: {
      type: "string",
      enum: ["success", "failure"],
      description: "success only if the ticket is built, committed to your branch, and its tests pass.",
    },
    summary: { type: "string", description: "One or two sentences on the behaviour that now works." },
    error: {
      type: "string",
      description: "Only when outcome is failure: what blocked you, what you tried, and the exact error.",
    },
    noticed: {
      type: "array",
      items: { type: "string" },
      description: "Real problems outside this ticket's scope that you deliberately did not fix.",
    },
  },
};

function isReport(v: unknown): v is Pick<BuilderReport, "outcome" | "summary"> & Partial<BuilderReport> {
  if (typeof v !== "object" || v === null) return false;
  const outcome = (v as { outcome?: unknown }).outcome;
  return outcome === "success" || outcome === "failure";
}

/**
 * Two placeholders are available in builderEnv, builderSetup and builderTeardown:
 *
 * - `{ticket}`  — the ticket number. This is what makes one builder's resources distinct from its
 *                 siblings'. A repo whose tests share a database needs it.
 * - `{repoRoot}` — the main checkout. A fresh worktree has no `node_modules` (it is gitignored),
 *                 so setup usually needs to link or install dependencies, and linking to the main
 *                 checkout is far cheaper than an install per ticket.
 */
function expand(value: string, ticket: number, repoRoot: string): string {
  return value.replaceAll("{ticket}", String(ticket)).replaceAll("{repoRoot}", repoRoot);
}

function expandAll(
  values: Record<string, string>,
  ticket: number,
  repoRoot: string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expand(v, ticket, repoRoot)]));
}

const RESOLVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["resolved", "detail"],
  properties: {
    resolved: { type: "boolean", description: "true only if every conflicted file is resolved and staged." },
    detail: { type: "string", description: "What you kept from each side, or why it could not be resolved." },
  },
};

/**
 * Resolve an in-progress merge conflict rather than throwing the ticket away.
 *
 * Two slices touching one file is the normal case, not a defect: every builder in a round branches
 * from the same base, so any file they all must create — a changelog is the usual one — collides
 * add/add on the second merge. Handing that ticket back would discard good work over a bookkeeping
 * file.
 *
 * The model resolves the text; code decides whether the result counts. Nothing here trusts the
 * model's own claim: the staged tree is checked for remaining conflicts, and the gates still run
 * afterwards exactly as they would for a clean merge.
 */
async function resolveConflict(
  t: Ticket,
  repoDir: string,
  branch: string,
  budgetUsd: number | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const files = await git.conflictedFiles(repoDir);
  if (files.length === 0) return { ok: false, detail: "merge failed but git reports no conflicted files" };

  const run = await agent(
    [
      `A merge of ${branch} into the integration branch has stopped on conflicts.`,
      ``,
      `Conflicted files:`,
      ...files.map((f) => `  ${f}`),
      ``,
      `Resolve every one of them, keeping BOTH sides' intent — these are two independent slices of`,
      `the same feature, so neither side's content is wrong and neither should simply be discarded.`,
      `For an append-only file such as a changelog, that means keeping both entries.`,
      ``,
      `Edit the files, remove every conflict marker, and \`git add\` each one. Do NOT commit, do not`,
      `\`git merge --abort\`, and do not change any file that was not conflicted.`,
    ].join("\n"),
    {
      cwd: repoDir,
      maxTurns: 40,
      schema: RESOLVE_SCHEMA,
      ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
    },
  );

  // The claim is checked against the tree, never taken at face value.
  const remaining = await git.conflictedFiles(repoDir);
  if (remaining.length > 0) {
    return { ok: false, detail: `still conflicted after the attempt: ${remaining.join(", ")} (${run.detail})` };
  }
  const committed = await git.commitMerge(repoDir, `Merge ${branch} (conflicts resolved)`);
  if (!committed.ok) return { ok: false, detail: `could not commit the resolved merge: ${committed.detail}` };
  return { ok: true, detail: `resolved ${files.join(", ")}` };
}

/** Wall-clock since a start mark, as `1m23s`. A round takes tens of minutes; "still going" and
 *  "wedged" look identical without one. */
function since(start: number): string {
  const s = Math.round((Date.now() - start) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * One line of a builder's own narration, attributed and bounded.
 *
 * Up to `maxParallel` builders share this single stream, so the ticket number is what makes it
 * readable at all, and the truncation is what stops a builder that thinks in paragraphs from
 * burying the two that do not. First non-trivial line only: the point is a pulse showing what is
 * being worked on, not a transcript — the transcript is what the failure report already carries.
 */
function narrate(ticket: number, text: string, log: (msg: string) => void): void {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 3);
  if (line === undefined) return;
  log(`  #${ticket} | ${line.length > 140 ? `${line.slice(0, 137)}...` : line}`);
}

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
    `Then return the structured report describing what you did.`,
    ``,
    `Report "failure" honestly. A ticket handed back with a clear error costs one ticket.`,
    `A ticket reported green that is not green costs the whole round: it merges, the post-merge`,
    `gates fail, and the orchestrator reverts work that had nothing wrong with it.`,
  ].join("\n");
}

/** Run one ticket to completion in its own worktree. Never throws; a crash is a failure report. */
async function build(
  t: Ticket,
  spec: number,
  repoDir: string,
  integration: string,
  config: SpokeConfig,
  budgetUsd: number | undefined,
  log: (msg: string) => void,
): Promise<BuilderReport> {
  const branch = `foundry/${t.number}-${slug(t.title)}`;
  const env = config.builderEnv ? expandAll(config.builderEnv, t.number, repoDir) : undefined;
  const started = Date.now();
  let worktree: string | undefined;

  try {
    worktree = await git.addWorktree(repoDir, t.number, integration);
    log(`  #${t.number} worktree cut from ${integration}`);

    // A builder that cannot get its own resources must not fall back to a sibling's.
    for (const command of config.builderSetup ?? []) {
      const resolved = expand(command, t.number, repoDir);
      log(`  #${t.number} setup: ${resolved}`);
      const r = await tryShell(resolved, worktree, env);
      if (!r.ok) {
        return {
          outcome: "failure",
          ticket: t.number,
          branch,
          summary: "",
          error: `builder setup failed: ${resolved}\n${[r.stdout, r.stderr].filter(Boolean).join("\n").slice(-2000)}`,
        };
      }
    }
    log(`  #${t.number} builder started on ${branch}`);
    const run = await agent(builderPrompt(t, spec, integration, branch), {
      cwd: worktree,
      maxTurns: 300,
      schema: REPORT_SCHEMA,
      onText: (text) => narrate(t.number, text, log),
      ...(env ? { env } : {}),
      ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
    });
    log(`  #${t.number} builder finished in ${since(started)} (${run.detail})`);

    if (!isReport(run.structured)) {
      return {
        outcome: "failure",
        ticket: t.number,
        branch,
        summary: "",
        error: `builder returned no usable report (${run.detail}). Last words:\n${run.text.slice(-1500)}`,
      };
    }
    const report = run.structured;

    // The report is the builder's claim; the branch existing is the fact. Trust the fact.
    if (report.outcome === "success" && !(await git.branchExists(branch, repoDir))) {
      return {
        outcome: "failure",
        ticket: t.number,
        branch,
        summary: report.summary,
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
    // Teardown runs pass or fail, so a failed ticket does not leak its database.
    if (worktree) {
      for (const command of config.builderTeardown ?? []) {
        const resolved = expand(command, t.number, repoDir);
        log(`  #${t.number} teardown: ${resolved}`);
        const r = await tryShell(resolved, worktree, env);
        if (!r.ok) log(`  #${t.number} teardown failed (not fatal): ${resolved}`);
      }
      await git.removeWorktree(repoDir, worktree);
    }
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
  budgetUsd: number | undefined,
  log: (msg: string) => void,
): Promise<TicketOutcome> {
  if (report.outcome === "failure") {
    const reason = report.error ?? "builder reported failure without an error";
    await gh.handBack(t.number, `Builder could not finish this ticket.\n\n\`\`\`\n${reason.slice(0, 4000)}\n\`\`\``, repoDir);
    return { ticket: t.number, title: t.title, result: "handed-back", reason };
  }

  log(`  #${t.number} merging ${report.branch}`);
  const merge = await git.mergeBranch(report.branch, repoDir);
  if (!merge.ok) {
    if (!merge.conflict) {
      const reason = `merge into the integration branch failed: ${merge.detail}`;
      await gh.handBack(t.number, `${reason}\n\nResolve by hand and re-run.`, repoDir);
      return { ticket: t.number, title: t.title, result: "handed-back", reason };
    }
    const fix = await resolveConflict(t, repoDir, report.branch, budgetUsd);
    if (!fix.ok) {
      await git.abortMerge(repoDir);
      const reason = `merge conflict could not be resolved: ${fix.detail}`;
      await gh.handBack(t.number, `${reason}\n\nResolve by hand and re-run.`, repoDir);
      return { ticket: t.number, title: t.title, result: "handed-back", reason };
    }
    log(`  #${t.number} merge conflict resolved (${fix.detail})`);
  }

  // A slice that was green alone can still break a sibling merged in the same round.
  const gates = await git.verify(config, repoDir, (cmd) => log(`  #${t.number} gate: ${cmd}`));
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
      batch.map((t) => build(t, spec, repoDir, integration, config, opts.budgetUsd, log)),
    );

    let closedThisRound = 0;
    for (const [i, report] of reports.entries()) {
      const t = batch[i];
      if (!t) continue;
      const outcome = await land(report, t, repoDir, config, opts.budgetUsd, log);
      if (outcome.result === "closed") {
        closed.push(outcome);
        closedThisRound += 1;
        log(`  #${t.number} closed`);
      } else {
        handedBack.push(outcome);
        log(`  #${t.number} handed back: ${outcome.reason?.split("\n")[0] ?? "unknown"}`);
      }
    }


    quietRounds = closedThisRound === 0 ? quietRounds + 1 : 0;
    if (quietRounds >= STALL_ROUNDS) {
      const all2 = await gh.tickets(repo, spec, repoDir);
      return { stop: "stall", closed, handedBack, stillBlocked: stranded(all2) };
    }
  }
}
