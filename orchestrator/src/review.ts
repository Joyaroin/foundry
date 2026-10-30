import { agent } from "./agent.js";
import * as git from "./git.js";

/**
 * Review one built ticket before it may land. The third place a model is asked for judgement,
 * and the only one that is one-way: a verdict can stop a ticket, never pass one on its own.
 *
 * Green gates prove the builder's tests pass, and the builder wrote those tests. Nothing else
 * checked the work against the acceptance criteria. So a second model, not the one that wrote
 * the code and never shown the builder's account of it, reads the ticket, the spec and the diff,
 * and reports each criterion as met or not. Code makes the decision from that report:
 *
 *   - an unmet criterion, or any blocking finding  → rejected
 *   - no report at all, or one that checked nothing → rejected; a review that did not happen
 *                                                     approves nothing
 *   - the branch moved while it looked             → rejected; a reviewer does not get to write
 *
 * An approved ticket still has to merge cleanly and pass the gates. Rejected, it is handed back
 * exactly like a ticket its builder failed.
 */

const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "blocking", "notes"],
  properties: {
    criteria: {
      type: "array",
      description: "Every acceptance criterion in the ticket, in order, each judged on its own.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met", "evidence"],
        properties: {
          criterion: { type: "string", description: "The criterion, as the ticket states it." },
          met: {
            type: "boolean",
            description: "true only if the code does it AND a test would fail if it stopped doing it.",
          },
          evidence: { type: "string", description: "The file:line of the code and of the test that show it." },
        },
      },
    },
    blocking: {
      type: "array",
      items: { type: "string" },
      description: "Defects you would refuse to merge over, each with its file:line. Empty if none.",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Everything worth saying that is not a reason to refuse the merge.",
    },
  },
};

export type Verdict = {
  criteria: { criterion: string; met: boolean; evidence: string }[];
  blocking: string[];
  notes: string[];
};

function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<Verdict>;
  return Array.isArray(r.criteria) && Array.isArray(r.blocking) && Array.isArray(r.notes);
}

function reviewPrompt(ticketText: string, specText: string, integration: string, branch: string): string {
  return [
    `Review one ticket's implementation before it merges. You did not write it.`,
    ``,
    `See the change with:  git diff ${integration}...${branch}`,
    `Read whatever else in the repository you need. You may run the tests.`,
    `Do NOT edit any file, commit, switch branches, or touch GitHub. You are read-only.`,
    ``,
    `Judge every acceptance criterion in the ticket. A criterion is met only if the code does it`,
    `and a test would fail if it stopped doing it.`,
    ``,
    `Blocking means you would refuse this merge over it:`,
    `- a bug: a wrong result, a crash, lost data, a security hole, an error path the ticket covers left unhandled`,
    `- a test that cannot fail: it re-computes its expected value the way the code does, asserts on its own`,
    `  mocks, or never exercises the behaviour its name claims`,
    `- a name, signature or seam that differs from what the spec's Shared Interfaces or Testing Decisions settled`,
    `- a change outside the ticket that alters existing behaviour`,
    ``,
    `Not blocking: style, naming you would have chosen differently, a cleaner approach, and problems`,
    `that were already there. Those go in notes.`,
    ``,
    `Be exact rather than generous or harsh. A wrong rejection hands back a good ticket and stops`,
    `every ticket that depends on it. A wrong approval puts a defect on the default branch.`,
    ``,
    `===== TICKET =====`,
    ticketText,
    ``,
    `===== SPEC =====`,
    specText,
  ].join("\n");
}

export async function review(opts: {
  /** Fetched by the caller rather than left to the reviewer, so what it judges against is a fact of the run. */
  ticketText: string;
  specText: string;
  branch: string;
  integration: string;
  worktree: string;
  repoDir: string;
  env?: Record<string, string>;
  budgetUsd?: number;
  onText?: (text: string) => void;
}): Promise<{ approved: boolean; detail: string }> {
  const { ticketText, specText, branch, integration, worktree, repoDir } = opts;
  const tipBefore = await git.revParse(branch, repoDir);

  const run = await agent(reviewPrompt(ticketText, specText, integration, branch), {
    cwd: worktree,
    maxTurns: 60,
    schema: VERDICT_SCHEMA,
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Task"],
    ...(opts.onText ? { onText: opts.onText } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.budgetUsd !== undefined ? { maxBudgetUsd: opts.budgetUsd } : {}),
  });

  if ((await git.revParse(branch, repoDir)) !== tipBefore) {
    return { approved: false, detail: `the reviewer changed ${branch}, so its verdict is void` };
  }
  if (!isVerdict(run.structured)) {
    return { approved: false, detail: `review did not complete (${run.detail})` };
  }
  return decide(run.structured);
}

/** The verdict, turned into a decision. Only a unanimous, unblocked, non-empty report passes. */
export function decide(verdict: Verdict): { approved: boolean; detail: string } {
  const { criteria, blocking, notes } = verdict;
  if (criteria.length === 0) {
    return { approved: false, detail: "the review judged no acceptance criteria" };
  }

  const unmet = criteria.filter((c) => !c.met);
  const lines = [
    `Review: ${criteria.length - unmet.length}/${criteria.length} acceptance criteria met` +
      (blocking.length ? `, ${blocking.length} blocking` : ""),
    ...unmet.map((c) => `- not met: ${c.criterion} — ${c.evidence}`),
    ...blocking.map((b) => `- blocking: ${b}`),
    ...notes.map((n) => `- note: ${n}`),
  ];
  return { approved: unmet.length === 0 && blocking.length === 0, detail: lines.join("\n") };
}
