import { test } from "node:test";
import assert from "node:assert/strict";
import { prBody, refusal } from "./ship.js";
import type { Ticket } from "./types.js";

const back = [{ ticket: 4, title: "x", result: "handed-back" as const }];

test("a done run with nothing handed back may go on to the gates and CI", () => {
  assert.equal(refusal({ stop: "done", handedBack: [] }, false), undefined);
});

test("a deadlocked or stalled run never merges", () => {
  assert.match(refusal({ stop: "deadlock", handedBack: [] }, false) ?? "", /deadlock/);
  assert.match(refusal({ stop: "stall", handedBack: [] }, false) ?? "", /stall/);
});

test("a done run that handed a ticket back never merges", () => {
  assert.match(refusal({ stop: "done", handedBack: back }, false) ?? "", /handed back/);
});

test("--no-merge stops a clean run at its pull request", () => {
  assert.equal(refusal({ stop: "done", handedBack: [] }, true), "--no-merge");
});

const ticket = (number: number, over: Partial<Ticket> = {}): Ticket => ({
  number,
  title: `ticket ${number}`,
  blockedBy: 0,
  assignee: null,
  labels: ["ready-for-agent"],
  state: "closed",
  touches: [],
  ...over,
});

test("a resumed run that built nothing still lists every ticket an earlier run closed", () => {
  const body = prBody(11, [ticket(12), ticket(13)], { stop: "done", handedBack: [] });
  assert.match(body, /^Closes #11/);
  assert.match(body, /\*\*Closed \(2\)\*\*\n- #12 ticket 12\n- #13 ticket 13/);
});

test("a ticket still open means the PR does not close the spec, and says why", () => {
  const all = [
    ticket(12),
    ticket(13, { state: "open", labels: ["ready-for-human"] }),
    ticket(14, { state: "open", blockedBy: 1 }),
  ];
  const body = prBody(11, all, {
    stop: "deadlock",
    handedBack: [{ ticket: 13, title: "ticket 13", result: "handed-back", reason: "review rejected the ticket:\nmore" }],
  });
  assert.match(body, /^Partial run against #11\./);
  assert.match(body, /- #13 ticket 13 — review rejected the ticket:$/m);
  assert.match(body, /\*\*Still open \(1\)\*\*\n- #14 ticket 14/);
});
