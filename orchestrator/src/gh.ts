import { run, tryRun } from "./sh.js";
import { LABEL_HUMAN, LABEL_READY } from "./config.js";
import type { Ticket } from "./types.js";

/**
 * Every GitHub mutation the run performs. All of it is code — a model never
 * decides that an issue closes, only what goes in its body.
 */

export async function repoSlug(cwd: string): Promise<string> {
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd);
}

export async function defaultBranch(cwd: string): Promise<string> {
  return run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd);
}

async function api(args: string[], cwd: string): Promise<string> {
  return run("gh", ["api", ...args], cwd);
}

/** An issue's numeric database id — what the sub-issue and dependency endpoints take, NOT its #number. */
export async function issueId(repo: string, n: number, cwd: string): Promise<number> {
  return Number(await api([`repos/${repo}/issues/${n}`, "--jq", ".id"], cwd));
}

export async function createIssue(
  opts: { title: string; body: string; labels: string[] },
  cwd: string,
): Promise<number> {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];
  for (const l of opts.labels) args.push("--label", l);
  const url = await run("gh", args, cwd);
  const n = Number(url.trim().split("/").pop());
  if (!Number.isInteger(n)) throw new Error(`could not read an issue number out of: ${url}`);
  return n;
}

export async function addSubIssue(repo: string, parent: number, child: number, cwd: string): Promise<void> {
  const id = await issueId(repo, child, cwd);
  await api(["--method", "POST", `repos/${repo}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`], cwd);
}

export async function addBlockedBy(repo: string, blocked: number, blocker: number, cwd: string): Promise<void> {
  const id = await issueId(repo, blocker, cwd);
  await api(
    ["--method", "POST", `repos/${repo}/issues/${blocked}/dependencies/blocked_by`, "-F", `issue_id=${id}`],
    cwd,
  );
}

export async function claim(n: number, cwd: string): Promise<void> {
  await run("gh", ["issue", "edit", String(n), "--add-assignee", "@me"], cwd);
}

/** Return a ticket to the frontier without touching its labels. */
export async function unclaim(n: number, cwd: string): Promise<void> {
  await run("gh", ["issue", "edit", String(n), "--remove-assignee", "@me"], cwd);
}

export async function closeTicket(n: number, comment: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "close", String(n), "--comment", comment], cwd);
}

/**
 * Release a ticket a builder could not finish. It loses `ready-for-agent`, so it never
 * returns to the frontier — a failure stops the chain behind it instead of being retried forever.
 */
export async function handBack(n: number, comment: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "comment", String(n), "--body", comment], cwd);
  await run(
    "gh",
    ["issue", "edit", String(n), "--remove-assignee", "@me", "--remove-label", LABEL_READY, "--add-label", LABEL_HUMAN],
    cwd,
  );
}

/**
 * A ticket's declared files, written into its body by the program and read back by it. Visible,
 * so a human reading the issue sees what the scheduler sees; marked, so nothing a model wrote in
 * the body can be mistaken for it.
 */
const TOUCHES_MARKER = "<!-- foundry:touches -->";

export function touchesBlock(paths: string[]): string {
  return `${TOUCHES_MARKER}\n**Expected to touch:** ${paths.map((p) => `\`${p}\``).join(", ")}`;
}

/**
 * Replace a body's declared files, or add them if it has none. Every old block goes: an issue that
 * had another folded into it can carry two, and the scheduler reads the first.
 */
export function withTouches(body: string | null, paths: string[]): string {
  const kept = (body ?? "").split("\n");
  for (let at = kept.findIndex((l) => l.trim() === TOUCHES_MARKER); at >= 0; at = kept.findIndex((l) => l.trim() === TOUCHES_MARKER)) {
    kept.splice(at, 2);
  }
  return `${kept.join("\n").trimEnd()}\n\n${touchesBlock(paths)}`;
}

export function parseTouches(body: string | null): string[] {
  const at = body?.indexOf(TOUCHES_MARKER) ?? -1;
  if (!body || at < 0) return [];
  const line = body.slice(at + TOUCHES_MARKER.length).trimStart().split("\n")[0] ?? "";
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter(Boolean);
}

/**
 * A plan's tickets, listed in the plan issue's body by the program that wrote it. A plan built from
 * a repo's existing issues cannot make them its sub-issues — GitHub allows one parent, and most
 * already have a spec — so it names them instead.
 */
const PLAN_MARKER = "<!-- foundry:plan";

export function planList(numbers: number[]): string {
  return `${PLAN_MARKER} ${numbers.join(" ")} -->`;
}

export function parsePlanList(body: string | null): number[] | null {
  const m = body?.match(/<!-- foundry:plan ([\d ]*)-->/);
  return m ? m[1]!.split(" ").filter(Boolean).map(Number) : null;
}

/** Every ticket in the run: the plan's list if the issue is a plan, its sub-issues otherwise. */
export async function tickets(repo: string, spec: number, cwd: string): Promise<Ticket[]> {
  const listed = parsePlanList(await api([`repos/${repo}/issues/${spec}`, "--jq", ".body"], cwd));
  const numbers =
    listed ??
    (await api([`repos/${repo}/issues/${spec}/sub_issues`, "--paginate", "--jq", ".[].number"], cwd))
      .split("\n")
      .filter(Boolean)
      .map(Number);

  const out: Ticket[] = [];
  for (const n of numbers) {
    const json = await api([`repos/${repo}/issues/${n}`], cwd);
    const issue = JSON.parse(json) as {
      number: number;
      title: string;
      body: string | null;
      state: "open" | "closed";
      assignee: { login: string } | null;
      labels: { name: string }[];
      issue_dependencies_summary?: { blocked_by: number };
    };
    if (!issue.issue_dependencies_summary) {
      throw new Error(
        `issue #${n} reports no issue_dependencies_summary — foundry cannot tell blocked tickets from ready ones`,
      );
    }
    out.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      assignee: issue.assignee?.login ?? null,
      labels: issue.labels.map((l) => l.name),
      blockedBy: issue.issue_dependencies_summary.blocked_by,
      touches: parseTouches(issue.body),
    });
  }
  return out;
}

/** Numbers of every open issue in the repo, pull requests excluded. */
export async function openIssues(repo: string, cwd: string): Promise<number[]> {
  const raw = await api(
    [`repos/${repo}/issues?state=open&per_page=100`, "--paginate", "--jq", ".[] | select(.pull_request | not) | .number"],
    cwd,
  );
  return raw.split("\n").filter(Boolean).map(Number);
}

export type IssueDetail = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  /** Sub-issues it has. A parent is a spec, not a ticket. */
  children: number;
};

export async function issueDetail(repo: string, n: number, cwd: string): Promise<IssueDetail> {
  const i = JSON.parse(await api([`repos/${repo}/issues/${n}`], cwd)) as {
    number: number;
    title: string;
    body: string | null;
    labels: { name: string }[];
    assignees: { login: string }[];
    updated_at: string;
    sub_issues_summary?: { total: number };
  };
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: i.labels.map((l) => l.name),
    assignees: i.assignees.map((a) => a.login),
    updatedAt: i.updated_at,
    children: i.sub_issues_summary?.total ?? 0,
  };
}

/** The issues this one is blocked by, open or closed, with the database id removal needs. */
export async function blockers(repo: string, n: number, cwd: string): Promise<{ number: number; id: number; open: boolean }[]> {
  const raw = await api(
    [`repos/${repo}/issues/${n}/dependencies/blocked_by`, "--paginate", "--jq", `.[] | "\\(.number) \\(.id) \\(.state)"`],
    cwd,
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "))
    .map(([num, id, state]) => ({ number: Number(num), id: Number(id), open: state === "open" }));
}

export async function removeBlockedBy(repo: string, blocked: number, blockerId: number, cwd: string): Promise<void> {
  await api(["--method", "DELETE", `repos/${repo}/issues/${blocked}/dependencies/blocked_by/${blockerId}`], cwd);
}

/** The issue this one is a sub-issue of, or null. */
export async function parentOf(repo: string, n: number, cwd: string): Promise<number | null> {
  const r = await tryRun("gh", ["api", `repos/${repo}/issues/${n}/parent`, "--jq", ".number"], cwd);
  return r.ok && r.stdout ? Number(r.stdout) : null;
}

export async function setBody(n: number, body: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "edit", String(n), "--body", body], cwd);
}

export async function addLabel(n: number, label: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "edit", String(n), "--add-label", label], cwd);
}

/** Closed as a duplicate, not deleted: reopening it undoes the merge. */
export async function closeAsDuplicate(n: number, of: number, comment: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "close", String(n), "--duplicate-of", String(of), "--comment", comment], cwd);
}

type IssueJson = { number: number; title: string; body: string; comments: { author: { login: string } | null; body: string }[] };

/**
 * An issue's title, body and comments, as one block of text for a prompt.
 *
 * Fetched by the program and put in the prompt, never left to a model to look up. Every prompt once
 * said "read it with `gh issue view N --comments`", and piped — which is how an agent's shell runs
 * it — that prints the comments ONLY: no title, no body. Builders, the ticket writer and reviewers
 * were all handed a command that returns nothing useful, and worked around it, one of them by
 * reading old session transcripts off the disk.
 */
export async function issueText(n: number, cwd: string): Promise<string> {
  const json = await run("gh", ["issue", "view", String(n), "--json", "number,title,body,comments"], cwd);
  return formatIssue(JSON.parse(json) as IssueJson);
}

export function formatIssue(i: IssueJson): string {
  return [
    `#${i.number} ${i.title}`,
    ``,
    i.body.trim(),
    ...i.comments.map((c) => `\n--- comment by ${c.author?.login ?? "unknown"} ---\n${c.body.trim()}`),
  ].join("\n");
}

export async function comment(n: number, body: string, cwd: string): Promise<void> {
  await run("gh", ["issue", "comment", String(n), "--body", body], cwd);
}

/**
 * Written on the spec as the last step of publishing its tickets. Sub-issues existing is not
 * enough to resume on: a run that died halfway through publishing leaves some of them, and
 * building a partial set would reach `done` — and merge — with tickets that were never written.
 */
export const PUBLISHED_MARKER = "<!-- foundry:tickets-published -->";

export async function ticketsPublished(spec: number, cwd: string): Promise<boolean> {
  const n = await run(
    "gh",
    ["issue", "view", String(spec), "--json", "comments", "--jq", `[.comments[].body | select(contains("${PUBLISHED_MARKER}"))] | length`],
    cwd,
  );
  return Number(n) > 0;
}

/** Open blockers for one issue. Used to confirm a just-written edge is visible. */
export async function blockedBy(repo: string, n: number, cwd: string): Promise<number> {
  const v = await api([`repos/${repo}/issues/${n}`, "--jq", ".issue_dependencies_summary.blocked_by"], cwd);
  return Number(v);
}

export async function ensureLabels(cwd: string): Promise<void> {
  for (const [name, color, desc] of [
    [LABEL_READY, "0E8A16", "Fully specified, ready for an agent"],
    [LABEL_HUMAN, "D93F0B", "Requires human implementation"],
  ] as const) {
    // Already existing is not an error worth stopping for.
    await tryRun("gh", ["label", "create", name, "--color", color, "--description", desc], cwd);
  }
}

/**
 * The run's pull request, created or brought up to date.
 *
 * **Idempotent on purpose.** A run that stops on a deadlock leaves its PR open, and the whole
 * point of fixing what deadlocked it is to run again against the same integration branch. `gh pr
 * create` fails on a branch that already has one, and it failed *after* the build loop had already
 * done its work — so the second run's entire outcome was lost to an error about bookkeeping. An
 * existing PR is the expected state of a resumed run, not a conflict, so it is adopted and its
 * body refreshed with this run's tallies.
 */
export async function createPr(
  opts: { title: string; body: string; base: string; head: string },
  cwd: string,
): Promise<{ number: number; created: boolean }> {
  const found = await tryRun(
    "gh",
    ["pr", "list", "--head", opts.head, "--base", opts.base, "--state", "open", "--json", "number", "--jq", ".[0].number"],
    cwd,
  );
  const existing = found.ok ? Number(found.stdout.trim()) : Number.NaN;
  if (Number.isInteger(existing) && existing > 0) {
    await run("gh", ["pr", "edit", String(existing), "--title", opts.title, "--body", opts.body], cwd);
    return { number: existing, created: false };
  }

  const url = await run(
    "gh",
    ["pr", "create", "--title", opts.title, "--body", opts.body, "--base", opts.base, "--head", opts.head],
    cwd,
  );
  return { number: Number(url.trim().split("/").pop()), created: true };
}

/**
 * Green, red, or "this repo has no checks", which is a pass — there is nothing to be red.
 *
 * "No checks" is only believed after it has held for a minute. This runs seconds after the push,
 * and CI registers its checks a few seconds after that — the same eventual consistency as the
 * dependency edges in `tickets.ts`. Read once, a repo whose CI simply had not started yet looked
 * like a repo with no CI, and the run merged without waiting for it.
 */
export async function prChecks(pr: number, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await tryRun("gh", ["pr", "checks", String(pr), "--watch"], cwd);
    if (r.ok) return { ok: true, detail: "checks green" };
    const noise = `${r.stdout}\n${r.stderr}`;
    if (!/no checks reported|no checks found/i.test(noise)) {
      return { ok: false, detail: noise.trim() || `gh pr checks exited ${r.code}` };
    }
    if (Date.now() > deadline) return { ok: true, detail: "no checks configured" };
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

/** Never --admin, never force. A refusal is reported, not routed around. */
export async function mergePr(pr: number, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const r = await tryRun("gh", ["pr", "merge", String(pr), "--merge", "--delete-branch"], cwd);
  return { ok: r.ok, detail: r.ok ? "merged" : (r.stderr || r.stdout || `exited ${r.code}`).trim() };
}
