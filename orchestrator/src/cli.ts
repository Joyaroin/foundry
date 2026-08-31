#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { credential } from "./auth.js";
import { buildLoop } from "./build.js";
import { PLUGIN_PATH, WORKTREE_DIR } from "./config.js";
import * as git from "./git.js";
import * as gh from "./gh.js";
import { ship } from "./ship.js";
import { writeTickets } from "./tickets.js";
import type { SpokeConfig } from "./types.js";

/**
 * foundry run     <spec-issue> [--no-merge] [--budget-usd N] [--skip-tickets]
 * foundry release <spec-issue>
 *
 * The unattended half. Phases 0-2 (preflight, grilling, spec) happen in Claude Code,
 * because grilling needs a human; this program starts once the spec is approved.
 */

const log = (msg: string) => console.log(msg);
const die = (msg: string): never => {
  console.error(`foundry: ${msg}`);
  process.exit(1);
};

function usage(): never {
  console.error("usage: foundry run     <spec-issue> [--no-merge] [--budget-usd N] [--skip-tickets]");
  console.error("       foundry release <spec-issue>");
  process.exit(2);
}

/**
 * Un-claim every ticket still assigned from an interrupted run.
 *
 * A claimed ticket is invisible to the frontier — that is what stops two builders taking the same
 * one. So a run killed mid-round leaves its tickets assigned with no builder behind them, and the
 * next run finds an empty frontier and reports a deadlock that is not real. This releases them.
 * It deliberately does not touch labels: a ticket a builder genuinely failed is `ready-for-human`
 * and should stay that way.
 */
async function release(spec: number, repoDir: string): Promise<void> {
  const repo = await gh.repoSlug(repoDir);
  const all = await gh.tickets(repo, spec, repoDir);
  const stuck = all.filter((t) => t.state === "open" && t.assignee !== null);
  if (stuck.length === 0) {
    log("nothing to release: no open ticket is claimed");
    return;
  }
  for (const t of stuck) {
    await gh.unclaim(t.number, repoDir);
    log(`released #${t.number} ${t.title}`);
  }
  log(`released ${stuck.length} ticket(s) back to the frontier`);
}

async function loadConfig(repoDir: string): Promise<SpokeConfig> {
  const path = join(repoDir, "foundry.config.json");
  if (!existsSync(path)) {
    die(
      `no foundry.config.json at the repo root.\n` +
        `It declares the gate commands that decide whether work is green — foundry will not guess them.\n` +
        `Minimum: {"verify":["npm run typecheck","npm test"]}`,
    );
  }
  const config = JSON.parse(await readFile(path, "utf8")) as SpokeConfig;
  if (!Array.isArray(config.verify) || config.verify.length === 0) {
    die(`foundry.config.json declares no "verify" commands`);
  }
  for (const key of ["builderSetup", "builderTeardown"] as const) {
    const v = config[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((c) => typeof c !== "string"))) {
      die(`foundry.config.json: "${key}" must be an array of shell commands`);
    }
  }
  for (const key of ["builderEnv", "verifyEnv"] as const) {
    const v = config[key];
    if (
      v !== undefined &&
      (typeof v !== "object" || v === null || Object.values(v).some((x) => typeof x !== "string"))
    ) {
      die(`foundry.config.json: "${key}" must be an object of string values`);
    }
  }
  return config;
}

async function preflight(repoDir: string): Promise<void> {
  const problems: string[] = [];

  if (!(await git.isClean(repoDir))) {
    problems.push("the working tree is dirty — builders branch off HEAD and would inherit uncommitted work");
  }
  const ignore = join(repoDir, ".gitignore");
  const ignored = existsSync(ignore) ? await readFile(ignore, "utf8") : "";
  if (!/^\s*\.claude\/?\s*$/m.test(ignored) && !ignored.includes(WORKTREE_DIR)) {
    problems.push(`.claude/ is not gitignored — builder worktrees live in ${WORKTREE_DIR} and would be committed`);
  }
  if (!existsSync(PLUGIN_PATH)) {
    problems.push(`the foundry plugin is missing at ${PLUGIN_PATH}`);
  }
  const cred = credential();
  if (cred.kind === "none") {
    problems.push(cred.detail);
  }
  if (problems.length) {
    die(`preflight failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== "run" && command !== "release") usage();

  const spec = Number(argv[1]);
  if (!Number.isInteger(spec) || spec <= 0) usage();

  if (command === "release") {
    await release(spec, await git.repoRoot(process.cwd()));
    return;
  }

  const noMerge = argv.includes("--no-merge");
  const skipTickets = argv.includes("--skip-tickets");
  const budgetIdx = argv.indexOf("--budget-usd");
  const budgetUsd = budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : undefined;
  if (budgetIdx >= 0 && !Number.isFinite(budgetUsd)) usage();

  const repoDir = await git.repoRoot(process.cwd());
  await preflight(repoDir);

  const config = await loadConfig(repoDir);
  const repo = await gh.repoSlug(repoDir);
  const base = await gh.defaultBranch(repoDir);
  await gh.ensureLabels(repoDir);

  log(`foundry: ${repo}, spec #${spec}, base ${base}`);
  log(`auth   : ${credential().detail}`);

  // Phase 3 — tickets.
  if (skipTickets) {
    log("skipping ticket creation (--skip-tickets)");
  } else {
    const created = await writeTickets(spec, repoDir);
    log(`wrote ${created.length} tickets: ${created.map((n) => `#${n}`).join(", ")}`);
  }

  // Phase 4 — the build loop, on its own integration branch.
  const integration = `foundry/spec-${spec}`;
  if (await git.branchExists(integration, repoDir)) {
    await git.switchTo(integration, repoDir);
  } else {
    await git.createBranch(integration, base, repoDir);
  }

  const loop = await buildLoop({
    spec,
    repoDir,
    repo,
    integration,
    config,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    log,
  });

  // Phase 5 — PR, and the merge decision.
  const result = await ship({ spec, repoDir, integration, base, config, noMerge, loop, log });

  await git.pruneWorktrees(repoDir);

  log("");
  log(`stop condition : ${result.stop}`);
  log(`closed         : ${result.closed.length}`);
  log(`handed back    : ${result.handedBack.length}`);
  log(`still blocked  : ${result.stillBlocked.length}`);
  log(`pull request   : #${result.prNumber}`);
  log(`merged         : ${result.merged ? "yes" : `no — ${result.mergeSkippedBecause}`}`);
  for (const t of result.handedBack) log(`  handed back #${t.ticket}: ${t.reason?.split("\n")[0] ?? ""}`);
  for (const t of result.stillBlocked) log(`  blocked #${t.number}: ${t.title}`);

  // A run that did not finish is not a success, and the exit code must say so.
  process.exit(result.stop === "done" && result.handedBack.length === 0 ? 0 : 1);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
