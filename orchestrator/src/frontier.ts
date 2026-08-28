import { LABEL_READY } from "./config.js";
import type { Ticket } from "./types.js";

/**
 * Which tickets can be built right now.
 *
 * This is the whole scheduler. There is no plan and no dependency graph held in memory:
 * every round re-asks this question, and tickets with no blocking edge between them simply
 * appear together. Parallelism and sequencing both fall out of the data.
 */
export function frontier(all: Ticket[]): Ticket[] {
  return all.filter(
    (t) =>
      t.state === "open" &&
      t.assignee === null &&
      t.labels.includes(LABEL_READY) &&
      t.blockedBy === 0,
  );
}

export function open(all: Ticket[]): Ticket[] {
  return all.filter((t) => t.state === "open");
}

/**
 * Open tickets that can never become buildable, because they lost `ready-for-agent`
 * when a builder failed them, or because something they depend on did.
 */
export function stranded(all: Ticket[]): Ticket[] {
  return open(all).filter((t) => !t.labels.includes(LABEL_READY) || t.blockedBy > 0);
}
