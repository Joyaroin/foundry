/** Constants the loop is allowed to depend on. Change them here, not inline. */

export const LABEL_READY = "ready-for-agent";
export const LABEL_HUMAN = "ready-for-human";

/**
 * Concurrent builders. Above this the round's merge step becomes the bottleneck
 * the parallelism was meant to remove.
 */
export const MAX_PARALLEL = 4;

/** Consecutive no-progress rounds before the loop declares a stall. */
export const STALL_ROUNDS = 2;

/** Where builder worktrees live in the spoke repo. Must be gitignored. */
export const WORKTREE_DIR = ".claude/worktrees";

/** The plugin whose skills and builder agent every query loads. */
export const PLUGIN_PATH = new URL("../../plugin", import.meta.url).pathname;

/** Model for every agent call. */
export const MODEL = "claude-opus-5";
