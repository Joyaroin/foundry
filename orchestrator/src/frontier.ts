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

/**
 * The tickets to build together this round: frontier order, at most `cap`, skipping any ticket
 * whose declared files overlap one already chosen.
 *
 * Every builder in a round branches from the same commit, so two that edit one file collide when
 * the second merges, and a model has to reconcile two implementations of the same code. Holding the
 * second ticket back a round costs time; letting it run costs a merge nobody can check. A skipped
 * ticket stays ready and is first in line next round. The first ticket is always chosen, so a round
 * can never come out empty while anything is ready.
 */
export function batch(ready: Ticket[], cap: number): Ticket[] {
  const chosen: Ticket[] = [];
  for (const t of ready) {
    if (chosen.length >= cap) break;
    if (chosen.some((c) => overlaps(c.touches, t.touches))) continue;
    chosen.push(t);
  }
  return chosen;
}

/** Same path, or one is a directory holding the other. `src/text` does not hold `src/text.js`. */
export function overlaps(a: string[], b: string[]): boolean {
  const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return a.some((x) =>
    b.some((y) => {
      const [p, q] = [norm(x), norm(y)];
      return p === q || q.startsWith(`${p}/`) || p.startsWith(`${q}/`);
    }),
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
