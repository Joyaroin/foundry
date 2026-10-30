import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agent } from "./agent.js";
import { LABEL_HUMAN, LABEL_READY } from "./config.js";
import { batch, overlaps } from "./frontier.js";
import * as gh from "./gh.js";
import { waitForEdges } from "./tickets.js";
import type { Ticket } from "./types.js";

/**
 * `foundry plan` — the unattended half, started from the issues a repo already has.
 *
 * A model reads every open issue and the code, and proposes: which issues are the same work and
 * should be folded together, which can be built at all, what each depends on, which files each
 * touches, and the shared names and test conventions a spec would have settled. Code then decides
 * whether that proposal is usable — every issue accounted for, merges well-formed, no cycle — and
 * prints the run it implies, round by round.
 *
 * Nothing changes on GitHub until `--apply`, and `--apply` executes the plan that was printed, read
 * back from a file, never a second model call that could come out differently. It refuses if any
 * assessed issue changed since. Reading the printed plan is the gate, the way approving a spec is
 * for `/foundry`; after `--apply`, `foundry run <plan issue>` builds it like any other run.
 *
 * Merging is the one change that can lose work, so it is done in a way that cannot: the surviving
 * issue gets the other's whole text appended, and the other is closed as a duplicate, not deleted.
 */

export const PLAN_FILE = ".claude/foundry-plan.json";

/** Past this many characters of issue text, ask for fewer issues rather than overflow the prompt. */
const PROMPT_LIMIT = 400_000;

type Proposal = {
  title: string;
  sharedInterfaces: string;
  testingDecisions: string;
  issues: { number: number; decision: "build" | "skip"; reason: string; blockedBy: number[]; touches: string[] }[];
  merges: { issues: number[]; why: string }[];
};

export type PlannedIssue = { number: number; title: string; blockedBy: number[]; touches: string[]; reason: string };
type Listed = { number: number; title: string; reason: string };

export type Plan = {
  repo: string;
  title: string;
  sharedInterfaces: string;
  testingDecisions: string;
  build: PlannedIssue[];
  merges: { keep: number; absorb: number[]; why: string }[];
  skip: Listed[];
  /** Left out by rule before the model saw them: parents, plans, assigned or handed-back issues. */
  excluded: Listed[];
  /** Open blockers each built issue has now, so the printout can show what the plan changes. */
  before: Record<string, number[]>;
  /** When each assessed issue last changed. `--apply` refuses if any differs. */
  updatedAt: Record<string, string>;
};

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sharedInterfaces", "testingDecisions", "issues", "merges"],
  properties: {
    title: { type: "string", description: "A short name for this body of work." },
    sharedInterfaces: {
      type: "string",
      description:
        "Markdown. Every name more than one built issue will touch, written as code with where it lives. " +
        "'None' if nothing is shared.",
    },
    testingDecisions: {
      type: "string",
      description: "Markdown. Where tests go and the exported symbols under test, following the repo and any parent spec.",
    },
    issues: {
      type: "array",
      description: "Exactly one entry for every issue under ISSUES.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "decision", "reason", "blockedBy", "touches"],
        properties: {
          number: { type: "integer" },
          decision: { type: "string", enum: ["build", "skip"] },
          reason: { type: "string", description: "For skip: the decision a person must make first." },
          blockedBy: { type: "array", items: { type: "integer" } },
          touches: { type: "array", items: { type: "string" } },
        },
      },
    },
    merges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issues", "why"],
        properties: {
          issues: { type: "array", minItems: 2, items: { type: "integer" } },
          why: { type: "string" },
        },
      },
    },
  },
};

/**
 * The proposal, checked and put into the shape the program executes. Throws on anything malformed.
 *
 * Merged groups become their oldest issue (the lowest number), carrying the union of its members'
 * dependencies and files. An issue that depends on one not being built is not built either — a
 * dependency on missing work is decided here, in code, not left to deadlock the run.
 */
export function normalize(
  p: Proposal,
  candidates: { number: number; title: string }[],
): Pick<Plan, "title" | "sharedInterfaces" | "testingDecisions" | "build" | "merges" | "skip"> {
  const titles = new Map(candidates.map((c) => [c.number, c.title]));
  const entries = new Map<number, Proposal["issues"][number]>();
  for (const e of p.issues) {
    if (!titles.has(e.number)) throw new Error(`the plan names #${e.number}, which is not one of the issues assessed`);
    if (entries.has(e.number)) throw new Error(`the plan lists #${e.number} twice`);
    entries.set(e.number, e);
  }
  const missing = candidates.filter((c) => !entries.has(c.number));
  if (missing.length) throw new Error(`the plan says nothing about #${missing.map((c) => c.number).join(", #")}`);

  const survivor = new Map<number, number>();
  const merges: Plan["merges"] = [];
  for (const g of p.merges) {
    const members = [...new Set(g.issues)].sort((a, b) => a - b);
    if (members.length < 2) throw new Error(`a merge needs two issues: ${g.issues.join(", ")}`);
    for (const n of members) {
      if (!entries.has(n)) throw new Error(`the plan merges #${n}, which is not one of the issues assessed`);
      if (survivor.has(n)) throw new Error(`#${n} is in two merges`);
      if (entries.get(n)!.decision !== "build") throw new Error(`#${n} is merged but decided skip`);
    }
    const keep = members[0]!;
    for (const n of members) survivor.set(n, keep);
    merges.push({ keep, absorb: members.slice(1), why: g.why });
  }
  const root = (n: number) => survivor.get(n) ?? n;

  const build = new Map<number, { blockedBy: Set<number>; touches: Set<string>; reason: string }>();
  for (const e of entries.values()) {
    if (e.decision !== "build") continue;
    const k = root(e.number);
    const b = build.get(k) ?? { blockedBy: new Set<number>(), touches: new Set<string>(), reason: "" };
    for (const x of e.blockedBy) {
      if (!entries.has(x)) throw new Error(`#${e.number} is blocked by #${x}, which is not one of the issues assessed`);
      b.blockedBy.add(root(x));
    }
    for (const f of e.touches) b.touches.add(f);
    if (k === e.number) b.reason = e.reason;
    build.set(k, b);
  }
  for (const [k, b] of build) b.blockedBy.delete(k);

  const skip: Listed[] = [...entries.values()]
    .filter((e) => e.decision === "skip")
    .map((e) => ({ number: e.number, title: titles.get(e.number)!, reason: e.reason }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [k, b] of build) {
      const gone = [...b.blockedBy].find((x) => !build.has(x));
      if (gone === undefined) continue;
      build.delete(k);
      skip.push({ number: k, title: titles.get(k)!, reason: `depends on #${gone}, which is not being built` });
      changed = true;
    }
  }

  const planned: PlannedIssue[] = [...build.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, b]) => {
      if (b.touches.size === 0) throw new Error(`#${number} is to be built but declares no files`);
      return { number, title: titles.get(number)!, blockedBy: [...b.blockedBy].sort((x, y) => x - y), touches: [...b.touches], reason: b.reason };
    });
  assertAcyclic(planned);

  return {
    title: p.title,
    sharedInterfaces: p.sharedInterfaces,
    testingDecisions: p.testingDecisions,
    build: planned,
    merges,
    skip: skip.sort((a, b) => a.number - b.number),
  };
}

/** Existing issues come in no particular order, so unlike a ticket draft a cycle is possible. */
export function assertAcyclic(issues: PlannedIssue[]): void {
  const left = new Map(issues.map((i) => [i.number, new Set(i.blockedBy)]));
  for (let progressed = true; progressed && left.size > 0; ) {
    progressed = false;
    for (const [n, blockers] of left) {
      if ([...blockers].every((b) => !left.has(b))) {
        left.delete(n);
        progressed = true;
      }
    }
  }
  if (left.size > 0) throw new Error(`the plan's dependencies form a cycle through #${[...left.keys()].join(", #")}`);
}

/**
 * The rounds a run would take if every ticket succeeded, using the same `batch()` the build loop
 * uses, in the same order the plan lists them.
 */
export function rounds(issues: PlannedIssue[], cap: number): { built: number[]; held: number[] }[] {
  const asTicket = (i: PlannedIssue): Ticket => ({
    number: i.number,
    title: i.title,
    blockedBy: 0,
    assignee: null,
    labels: [LABEL_READY],
    state: "open",
    touches: i.touches,
  });
  const done = new Set<number>();
  const out: { built: number[]; held: number[] }[] = [];
  for (;;) {
    const ready = issues.filter((i) => !done.has(i.number) && i.blockedBy.every((b) => done.has(b))).map(asTicket);
    if (ready.length === 0) return out;
    const chosen = batch(ready, Math.max(1, cap));
    const held = ready.filter((t) => !chosen.includes(t) && chosen.some((c) => overlaps(c.touches, t.touches)));
    for (const t of chosen) done.add(t.number);
    out.push({ built: chosen.map((t) => t.number), held: held.map((t) => t.number) });
  }
}

/** The plan as a person reads it: in the terminal before `--apply`, and in the plan issue after. */
export function describe(plan: Plan, cap: number): string[] {
  const lines: string[] = [];
  for (const m of plan.merges) lines.push(`merge   #${m.keep} ← ${m.absorb.map((n) => `#${n}`).join(", ")}   ${m.why}`);
  for (const [i, r] of rounds(plan.build, cap).entries()) {
    lines.push(`round ${i + 1} ${r.built.map((n) => `#${n}`).join(", ")}${r.held.length ? `   (held: ${r.held.map((n) => `#${n}`).join(", ")} — shares files)` : ""}`);
  }
  for (const i of plan.build) {
    const before = plan.before[i.number] ?? [];
    for (const b of i.blockedBy.filter((x) => !before.includes(x))) lines.push(`link  + #${i.number} blocked by #${b}`);
    for (const b of before.filter((x) => !i.blockedBy.includes(x))) lines.push(`link  − #${i.number} blocked by #${b}   (removed)`);
  }
  for (const s of plan.skip) lines.push(`skip    #${s.number} ${s.title} — ${s.reason}`);
  for (const s of plan.excluded) lines.push(`left    #${s.number} ${s.title} — ${s.reason}`);
  return lines;
}

function planBody(plan: Plan, cap: number): string {
  return [
    `foundry assessed this repo's open issues and planned ${plan.build.length} of them. Build it with \`foundry run\` on this issue.`,
    ``,
    `## Shared Interfaces`,
    ``,
    plan.sharedInterfaces,
    ``,
    `## Testing Decisions`,
    ``,
    plan.testingDecisions,
    ``,
    `## The plan`,
    ``,
    "```",
    ...describe(plan, cap),
    "```",
    ``,
    gh.planList(plan.build.map((i) => i.number)),
  ].join("\n");
}

type Candidate = gh.IssueDetail & { openBlockers: number[] };

/** Every open issue, sorted into what the model assesses, what it reads as a spec, and what it never sees. */
async function gather(repo: string, repoDir: string) {
  let candidates: Candidate[] = [];
  const specs: gh.IssueDetail[] = [];
  const excluded: Listed[] = [];
  for (const n of await gh.openIssues(repo, repoDir)) {
    const d = await gh.issueDetail(repo, n, repoDir);
    const leave = (reason: string) => excluded.push({ number: n, title: d.title, reason });
    if (d.children > 0) {
      specs.push(d);
      leave("has sub-issues: read as a spec, not built");
    } else if (gh.parsePlanList(d.body)) leave("a foundry plan");
    else if (d.assignees.length) leave(`assigned to ${d.assignees.join(", ")}: someone is on it`);
    else if (d.labels.includes(LABEL_HUMAN) || d.labels.includes("wontfix")) leave(`labelled ${d.labels.includes(LABEL_HUMAN) ? LABEL_HUMAN : "wontfix"}`);
    else {
      const openBlockers = (await gh.blockers(repo, n, repoDir)).filter((b) => b.open).map((b) => b.number);
      candidates.push({ ...d, openBlockers });
    }
  }

  // The model may rewrite links between issues it assesses, never a link to one it does not see:
  // an issue waiting on someone's in-progress work stays out of the plan, and so does anything
  // waiting on it.
  for (let changed = true; changed; ) {
    changed = false;
    const inPlan = new Set(candidates.map((c) => c.number));
    for (const c of candidates) {
      const outside = c.openBlockers.find((b) => !inPlan.has(b));
      if (outside === undefined) continue;
      excluded.push({ number: c.number, title: c.title, reason: `blocked by #${outside}, which this plan does not cover` });
      candidates = candidates.filter((x) => x !== c);
      changed = true;
      break;
    }
  }
  return { candidates, specs, excluded };
}

function planPrompt(candidates: Candidate[], specs: gh.IssueDetail[]): string {
  const issue = (d: gh.IssueDetail, extra = "") => `--- #${d.number} ${d.title}${extra} ---\n${d.body.trim()}`;
  return [
    `Assess this repository's open GitHub issues so foundry can build them with nobody watching.`,
    `Read the codebase as much as you need. Do NOT edit files, commit, or change anything on GitHub:`,
    `the program applies your plan after a person has read it.`,
    ``,
    `For EVERY issue under ISSUES, return exactly one entry in issues:`,
    `- decision "build" if an agent can build it as written without inventing a decision it does not`,
    `  make. Otherwise "skip", and make the reason the question a person must answer first.`,
    `- blockedBy: issues from this list whose code it needs to exist first. This REPLACES the links the`,
    `  issues have now: keep the right ones, drop the wrong ones, add the missing ones.`,
    `- touches: repo-relative files or directories it will create or change, tests included. Leave out`,
    `  append-only files every change adds to, such as a changelog. Issues that list the same file are`,
    `  never built at the same time, so an honest list is what keeps parallel builders apart.`,
    ``,
    `merges: groups of issues that are the same work, where building both would build one thing twice.`,
    `Related work is a dependency, not a merge. Every member must be decided "build". The program keeps`,
    `the oldest of each group and appends the others' full text to it, so nothing in them is lost.`,
    ``,
    `sharedInterfaces and testingDecisions become the spec every builder and reviewer works from.`,
    `Settle, as code, the names more than one built issue touches. Take test conventions from the repo`,
    `and from the parent specs below.`,
    ``,
    `===== PARENT SPECS (context only; not to be built) =====`,
    ...(specs.length ? specs.map((d) => issue(d)) : ["None."]),
    ``,
    `===== ISSUES =====`,
    ...candidates.map((d) =>
      issue(d, `${d.labels.length ? ` [${d.labels.join(", ")}]` : ""}${d.openBlockers.length ? ` (now blocked by #${d.openBlockers.join(", #")})` : ""}`),
    ),
  ].join("\n");
}

async function propose(repo: string, repoDir: string, budgetUsd: number | undefined, log: (msg: string) => void): Promise<Plan> {
  const { candidates, specs, excluded } = await gather(repo, repoDir);
  log(`${candidates.length + excluded.length} open issues: ${candidates.length} to assess, ${excluded.length} left out by rule`);
  if (candidates.length === 0) throw new Error("no open issue is left to assess");

  const prompt = planPrompt(candidates, specs);
  if (prompt.length > PROMPT_LIMIT) {
    throw new Error(
      `${candidates.length} open issues are ${prompt.length} characters of text, past the ${PROMPT_LIMIT} a plan ` +
        `will read in one go. Close or label stale ones (wontfix, ready-for-human) and plan again.`,
    );
  }

  const run = await agent(prompt, {
    cwd: repoDir,
    maxTurns: 80,
    schema: PLAN_SCHEMA,
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Task"],
    ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
  });
  const p = run.structured as Proposal | undefined;
  if (!p || !Array.isArray(p.issues)) throw new Error(`the planning agent returned no usable plan (${run.detail})`);

  const shaped = normalize(p, candidates);
  const open = new Map(candidates.map((c) => [c.number, c.openBlockers]));
  return {
    repo,
    ...shaped,
    excluded,
    before: Object.fromEntries(shaped.build.map((i) => [i.number, open.get(i.number) ?? []])),
    updatedAt: Object.fromEntries(candidates.map((c) => [c.number, c.updatedAt])),
  };
}

/** Write the printed plan to GitHub, exactly as printed. Returns the plan issue's number. */
async function apply(plan: Plan, cap: number, repoDir: string, log: (msg: string) => void): Promise<number> {
  const { repo } = plan;

  const changed: number[] = [];
  for (const [n, at] of Object.entries(plan.updatedAt)) {
    if ((await gh.issueDetail(repo, Number(n), repoDir)).updatedAt !== at) changed.push(Number(n));
  }
  if (changed.length) {
    throw new Error(`#${changed.join(", #")} changed since this plan was made. Run \`foundry plan\` again.`);
  }

  for (const m of plan.merges) {
    let body = (await gh.issueDetail(repo, m.keep, repoDir)).body;
    for (const a of m.absorb) {
      const d = await gh.issueDetail(repo, a, repoDir);
      body += `\n\n## Folded in from #${a} — ${d.title}\n\n${d.body.trim()}`;
    }
    await gh.setBody(m.keep, body, repoDir);
    for (const a of m.absorb) {
      await gh.closeAsDuplicate(a, m.keep, `Folded into #${m.keep} by \`foundry plan\`: ${m.why}`, repoDir);
    }
    log(`merged ${m.absorb.map((n) => `#${n}`).join(", ")} into #${m.keep}`);
  }

  const expected = new Map<number, number>();
  for (const i of plan.build) {
    const d = await gh.issueDetail(repo, i.number, repoDir);
    await gh.setBody(i.number, gh.withTouches(d.body, i.touches), repoDir);
    if (!d.labels.includes(LABEL_READY)) await gh.addLabel(i.number, LABEL_READY, repoDir);

    const current = await gh.blockers(repo, i.number, repoDir);
    for (const c of current.filter((c) => c.open && !i.blockedBy.includes(c.number))) {
      await gh.removeBlockedBy(repo, i.number, c.id, repoDir);
      log(`  #${i.number} no longer blocked by #${c.number}`);
    }
    for (const b of i.blockedBy.filter((b) => !current.some((c) => c.number === b))) {
      await gh.addBlockedBy(repo, i.number, b, repoDir);
      log(`  #${i.number} now blocked by #${b}`);
    }
    expected.set(i.number, i.blockedBy.length);
  }
  await waitForEdges(repo, expected, repoDir);

  const n = await gh.createIssue({ title: `Plan: ${plan.title}`, body: planBody(plan, cap), labels: [] }, repoDir);
  // Last, so its presence means everything above landed. `foundry run` resumes on it.
  await gh.comment(n, `${gh.PUBLISHED_MARKER}\nfoundry plan applied: ${plan.build.length} issues.`, repoDir);
  return n;
}

export async function planCommand(
  repoDir: string,
  repo: string,
  opts: { apply: boolean; cap: number; budgetUsd?: number; log: (msg: string) => void },
): Promise<void> {
  const { log, cap } = opts;
  const file = join(repoDir, PLAN_FILE);

  if (opts.apply) {
    if (!existsSync(file)) throw new Error(`no saved plan at ${PLAN_FILE}. Run \`foundry plan\` first and read it.`);
    const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
    if (plan.repo !== repo) throw new Error(`the saved plan is for ${plan.repo}, not ${repo}`);
    const n = await apply(plan, cap, repoDir, log);
    rmSync(file);
    log(`plan is #${n}. Build it with: foundry run ${n}`);
    return;
  }

  const plan = await propose(repo, repoDir, opts.budgetUsd, log);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(plan, null, 2));
  log("");
  log(`Plan: ${plan.title} — build ${plan.build.length}, merge ${plan.merges.length}, skip ${plan.skip.length}`);
  for (const line of describe(plan, cap)) log(line);
  log("");
  log(`Nothing has changed on GitHub. Read the plan above, then: foundry plan --apply`);
}
