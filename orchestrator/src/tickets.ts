import { agent } from "./agent.js";
import { LABEL_READY } from "./config.js";
import * as gh from "./gh.js";

/**
 * Phase 3 — spec to tickets.
 *
 * The model decides what the slices are. Everything after that is code: the issues are created
 * here, in dependency order, and the blocking edges are recorded here. A model never calls `gh`
 * for this — a hallucinated edge would corrupt the frontier for the entire run.
 *
 * The handoff is a schema-enforced object, not prose and not a file the model has to remember to
 * write. The SDK validates the shape and retries the model on a mismatch, so by the time this code
 * runs the only thing left to check is the one rule a JSON Schema cannot express: that every edge
 * points backwards.
 */

type Draft = {
  tickets: {
    title: string;
    body: string;
    /** Positions (1-based) of tickets earlier in this same array that must close first. */
    blockedBy: number[];
  }[];
};

const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["tickets"],
  properties: {
    tickets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "blockedBy"],
        properties: {
          title: { type: "string", description: "Short descriptive ticket title." },
          body: {
            type: "string",
            description:
              "Full issue body in Markdown: what to build, acceptance criteria as a '- [ ]' checklist, " +
              "and a 'Blocked by' line naming the blocking ticket titles.",
          },
          blockedBy: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            description:
              "1-based positions in this same tickets array. Must be EARLIER than this ticket's own " +
              "position. Empty means it can start immediately.",
          },
        },
      },
    },
  },
};

/**
 * The one invariant the schema cannot state. Requiring every edge to point backwards does more
 * than order the list: it makes a dependency cycle unrepresentable, so the loop cannot be handed
 * a graph that deadlocks it.
 */
function assertBackwardEdges(draft: Draft): void {
  draft.tickets.forEach((t, i) => {
    for (const b of t.blockedBy) {
      if (b > draft.tickets.length) {
        throw new Error(`ticket ${i + 1} is blocked by ${b}, which is not a ticket in this draft`);
      }
      if (b >= i + 1) {
        throw new Error(
          `ticket ${i + 1} is blocked by ${b}: blockers must appear earlier in the list, ` +
            `so the draft is in dependency order and cannot contain a cycle`,
        );
      }
    }
  });
}

function isDraft(v: unknown): v is Draft {
  if (typeof v !== "object" || v === null) return false;
  const tickets = (v as { tickets?: unknown }).tickets;
  return Array.isArray(tickets) && tickets.length > 0;
}

export async function writeTickets(spec: number, repoDir: string): Promise<number[]> {
  const prompt = [
    `Use the /foundry:to-tickets skill to break spec issue #${spec} of this repository into tickets.`,
    ``,
    `Read the spec with: gh issue view ${spec} --comments`,
    ``,
    `Do NOT create any GitHub issues, and do not run \`gh issue create\`, \`gh issue edit\` or`,
    `\`gh api\`. Publishing is the orchestrator's job, not yours — it records the dependency edges,`,
    `and an edge invented here would corrupt the build order for the whole run.`,
    ``,
    `Return your breakdown as the structured answer. The tickets array must be in dependency order:`,
    `a ticket's blockers appear EARLIER in the array than the ticket itself.`,
    ``,
    `Every ticket is a vertical slice: a complete path through every layer, demoable on its own,`,
    `and small enough to fit in one fresh context window.`,
  ].join("\n");

  const run = await agent(prompt, { cwd: repoDir, maxTurns: 60, schema: DRAFT_SCHEMA });

  if (!isDraft(run.structured)) {
    throw new Error(
      `the ticket-writing agent returned no usable breakdown (${run.detail}).\n` +
        `Its last words were:\n${run.text.slice(-2000)}`,
    );
  }
  const draft = run.structured;
  assertBackwardEdges(draft);

  const repo = await gh.repoSlug(repoDir);
  const numbers: number[] = [];

  // Published in order, so every blocker already exists when its edge is recorded.
  for (const t of draft.tickets) {
    const n = await gh.createIssue({ title: t.title, body: t.body, labels: [LABEL_READY] }, repoDir);
    numbers.push(n);
    await gh.addSubIssue(repo, spec, n, repoDir);
  }
  const shouldBeBlocked: number[] = [];
  for (const [i, t] of draft.tickets.entries()) {
    for (const b of t.blockedBy) {
      const blocked = numbers[i];
      const blocker = numbers[b - 1];
      if (blocked === undefined || blocker === undefined) continue;
      await gh.addBlockedBy(repo, blocked, blocker, repoDir);
      if (!shouldBeBlocked.includes(blocked)) shouldBeBlocked.push(blocked);
    }
  }

  await waitForEdges(repo, shouldBeBlocked, repoDir);
  return numbers;
}

/**
 * Wait until GitHub reports the edges we just wrote.
 *
 * `issue_dependencies_summary.blocked_by` is eventually consistent: measured on a live repo, a
 * freshly recorded edge read back as 0, 0, then 1. The build loop computes its first frontier
 * moments after this function returns, so without the wait a blocked ticket looks ready and gets
 * built before its blocker exists — silently, and only when the concurrency cap is wide enough to
 * reach it. A run that once escaped this did so because the cap was 2.
 *
 * Failing loudly is the right end state: building in the wrong order corrupts the run in a way
 * nothing downstream would notice.
 */
async function waitForEdges(repo: string, blocked: number[], repoDir: string): Promise<void> {
  if (blocked.length === 0) return;

  const deadline = Date.now() + 60_000;
  for (;;) {
    const lagging: number[] = [];
    for (const n of blocked) {
      const summary = await gh.blockedBy(repo, n, repoDir);
      if (summary === 0) lagging.push(n);
    }
    if (lagging.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `GitHub still reports no blockers for #${lagging.join(", #")} 60s after the edges were ` +
          `recorded. Refusing to start the build loop: a blocked ticket that looks ready would be ` +
          `built before the work it depends on exists.`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
