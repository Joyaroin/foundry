import { test } from "node:test";
import assert from "node:assert/strict";
import { batch, frontier, overlaps, stranded } from "./frontier.js";
import type { Ticket } from "./types.js";

const t = (number: number, over: Partial<Ticket> = {}): Ticket => ({
  number,
  title: `ticket ${number}`,
  blockedBy: 0,
  assignee: null,
  labels: ["ready-for-agent"],
  state: "open",
  touches: [],
  ...over,
});

test("the frontier is open, unclaimed, ready and unblocked tickets only", () => {
  const all = [
    t(1),
    t(2, { state: "closed" }),
    t(3, { assignee: "someone" }),
    t(4, { labels: ["ready-for-human"] }),
    t(5, { blockedBy: 1 }),
  ];
  assert.deepEqual(frontier(all).map((x) => x.number), [1]);
});

test("stranded tickets are the open ones that can never be built: handed back, or blocked", () => {
  const all = [t(1), t(2, { labels: ["ready-for-human"] }), t(3, { blockedBy: 1 }), t(4, { state: "closed" })];
  assert.deepEqual(stranded(all).map((x) => x.number), [2, 3]);
});

test("a round takes ready tickets in order up to the cap", () => {
  assert.deepEqual(batch([t(1), t(2), t(3)], 2).map((x) => x.number), [1, 2]);
});

test("a ticket sharing a file with one already chosen waits, and the next one takes its place", () => {
  const ready = [t(1, { touches: ["src/text.js"] }), t(2, { touches: ["src/text.js"] }), t(3, { touches: ["src/num.js"] })];
  assert.deepEqual(batch(ready, 2).map((x) => x.number), [1, 3]);
});

test("the first ready ticket is always built, so a round is never empty", () => {
  const ready = [t(1, { touches: ["src"] }), t(2, { touches: ["src/a.js"] })];
  assert.deepEqual(batch(ready, 4).map((x) => x.number), [1]);
});

test("tickets written before files were recorded schedule as they always did", () => {
  assert.deepEqual(batch([t(1), t(2)], 2).map((x) => x.number), [1, 2]);
});

test("a directory overlaps everything inside it, and nothing that merely shares a prefix", () => {
  assert.equal(overlaps(["src/"], ["src/text.js"]), true);
  assert.equal(overlaps(["./src/text.js"], ["src/text.js"]), true);
  assert.equal(overlaps(["src/text"], ["src/text.js"]), false);
  assert.equal(overlaps(["src/a.js"], ["test/a.test.js"]), false);
});
