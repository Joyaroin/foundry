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

/**
 * What a builder returns when it finishes. The SDK enforces this shape against a JSON Schema and
 * retries the model on a mismatch, so control flow never interprets prose. `ticket` and `branch`
 * are filled in by the orchestrator, which already knows them.
 */
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

  /**
   * Environment for the `verify` commands, which run in the MAIN working tree after each merge.
   * Without it a repo whose suite touches a database runs it against whatever the developer's own
   * `.env` points at — their real local data, repeatedly, unattended. Point it somewhere disposable.
   */
  verifyEnv?: Record<string, string>;

  /**
   * Per-builder isolation, for a repo whose tests touch a shared resource — a database being the
   * usual one. Without it, concurrent builders all run the suite against the same instance and
   * fail for reasons that have nothing to do with their code.
   *
   * `{ticket}` in any value is replaced with the ticket number, which is what makes each builder's
   * resource distinct. Setup runs before the builder starts, teardown always runs after.
   */
  builderEnv?: Record<string, string>;
  /** Run in the builder's worktree, with builderEnv applied, before it starts. A failure fails the ticket. */
  builderSetup?: string[];
  /** Run after the builder finishes, pass or fail. Best-effort: a failure here is logged, not fatal. */
  builderTeardown?: string[];
};
