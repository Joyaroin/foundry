/** Everything the loop passes around. Deliberately small. */

export type Ticket = {
  number: number;
  title: string;
  /** Open blockers. Zero means buildable now. */
  blockedBy: number;
  assignee: string | null;
  labels: string[];
  state: "open" | "closed";
};

/** What a builder writes to disk when it finishes. Read by the orchestrator, never parsed out of prose. */
export type BuilderReport = {
  outcome: "success" | "failure";
  ticket: number;
  branch: string;
  summary: string;
  /** Present on failure; the error the builder could not get past. */
  error?: string;
  /** Real problems found outside the ticket's scope and deliberately not fixed. */
  noticed?: string[];
};

/** Per-round outcome for one ticket, after the orchestrator has landed (or refused) the work. */
export type TicketOutcome = {
  ticket: number;
  title: string;
  result: "closed" | "handed-back";
  reason?: string;
};

export type RunResult = {
  stop: "done" | "deadlock" | "stall";
  closed: TicketOutcome[];
  handedBack: TicketOutcome[];
  stillBlocked: Ticket[];
  prNumber?: number;
  merged: boolean;
  mergeSkippedBecause?: string;
};

/** `foundry.config.json` at the spoke repo root. The gate commands must be declared, never guessed. */
export type SpokeConfig = {
  /** Commands that must exit 0 for work to count as green. Run in the repo root, in order. */
  verify: string[];
  /** Optional cap on concurrent builders. Defaults to MAX_PARALLEL. */
  maxParallel?: number;
};
