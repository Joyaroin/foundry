import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { agent } from "./agent.js";
import { LABEL_READY } from "./config.js";
import * as gh from "./gh.js";

/**
 * Phase 3 — spec to tickets.
 *
 * The model decides what the slices are. Everything after that is code: the issues
 * are created here, in dependency order, and the blocking edges are recorded here.
 * A model never calls `gh` for this — a hallucinated edge would corrupt the frontier
 * for the entire run.
 */

const DRAFT_FILE = ".foundry-tickets.json";

type Draft = {
  tickets: {
    /** 1-based position in this array. Referenced by `blockedBy`. */
    title: string;
    body: string;
    /** Positions (1-based) of tickets in this same array that must close first. */
    blockedBy: number[];
  }[];
};

function validate(draft: Draft): void {
  if (!Array.isArray(draft.tickets) || draft.tickets.length === 0) {
    throw new Error("the ticket draft is empty");
  }
  draft.tickets.forEach((t, i) => {
    if (!t.title?.trim()) throw new Error(`ticket ${i + 1} has no title`);
    if (!t.body?.trim()) throw new Error(`ticket ${i + 1} has no body`);
    for (const b of t.blockedBy ?? []) {
      if (!Number.isInteger(b) || b < 1 || b > draft.tickets.length) {
        throw new Error(`ticket ${i + 1} is blocked by ${b}, which is not a ticket in this draft`);
      }
      // Blockers must come first, so every edge points backwards. This also makes cycles impossible.
      if (b >= i + 1) {
        throw new Error(
          `ticket ${i + 1} is blocked by ${b}: blockers must appear earlier in the list, so the draft is in dependency order`,
        );
      }
    }
  });
}

export async function writeTickets(spec: number, repoDir: string): Promise<number[]> {
  const draftPath = join(repoDir, DRAFT_FILE);
  await rm(draftPath, { force: true });

  const prompt = [
    `Use the /foundry:to-tickets skill to break spec issue #${spec} of this repository into tickets.`,
    ``,
    `Read the spec with: gh issue view ${spec} --comments`,
    ``,
    `Do NOT create any GitHub issues yourself, and do not run any \`gh issue create\`,`,
    `\`gh api\` or \`gh issue edit\` command. Publishing is done by the orchestrator, not by you.`,
    ``,
    `Instead, write your breakdown to ${DRAFT_FILE} in the repository root as JSON of exactly this shape:`,
    ``,
    `{"tickets":[{"title":"...","body":"...","blockedBy":[]}]}`,
    ``,
    `Rules for that file:`,
    `- The list must be in dependency order: a ticket's blockers appear EARLIER in the array.`,
    `- "blockedBy" holds 1-based positions in this same array. Use [] for a ticket that can start immediately.`,
    `- "body" is the full issue body in Markdown: what to build, acceptance criteria as a "- [ ]" checklist,`,
    `  and a "Blocked by" line naming the blocking ticket titles (prose for humans; the real edges come from this JSON).`,
    `- Every ticket is a vertical slice: a complete path through every layer, demoable on its own,`,
    `  and small enough to fit in one fresh context window.`,
    ``,
    `Write the file and stop. Your final message should just say how many tickets you wrote.`,
  ].join("\n");

  const run = await agent(prompt, { cwd: repoDir, maxTurns: 60 });

  let draft: Draft;
  try {
    draft = JSON.parse(await readFile(draftPath, "utf8")) as Draft;
  } catch {
    throw new Error(
      `the ticket-writing agent produced no readable ${DRAFT_FILE} (${run.detail}).\n` +
        `Its last words were:\n${run.text.slice(-2000)}`,
    );
  }
  validate(draft);

  const repo = await gh.repoSlug(repoDir);
  const numbers: number[] = [];

  // Published in order, so every blocker already exists when the edge is recorded.
  for (const t of draft.tickets) {
    const n = await gh.createIssue({ title: t.title, body: t.body, labels: [LABEL_READY] }, repoDir);
    numbers.push(n);
    await gh.addSubIssue(repo, spec, n, repoDir);
  }
  for (const [i, t] of draft.tickets.entries()) {
    for (const b of t.blockedBy ?? []) {
      const blocked = numbers[i];
      const blocker = numbers[b - 1];
      if (blocked === undefined || blocker === undefined) continue;
      await gh.addBlockedBy(repo, blocked, blocker, repoDir);
    }
  }

  await rm(draftPath, { force: true });
  return numbers;
}

export { DRAFT_FILE };
