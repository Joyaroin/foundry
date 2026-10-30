import { test } from "node:test";
import assert from "node:assert/strict";
import { refusal } from "./ship.js";

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
