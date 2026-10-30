import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBackwardEdges } from "./tickets.js";

const draft = (...edges: number[][]) => ({
  tickets: edges.map((blockedBy, i) => ({ title: `t${i + 1}`, body: "", blockedBy, touches: ["x"] })),
});

test("edges that point backwards are a valid draft", () => {
  assert.doesNotThrow(() => assertBackwardEdges(draft([], [1], [1, 2])));
});

test("a ticket cannot be blocked by itself", () => {
  assert.throws(() => assertBackwardEdges(draft([], [2])), /blockers must appear earlier/);
});

test("a ticket cannot be blocked by a later one, which is what makes a cycle unrepresentable", () => {
  assert.throws(() => assertBackwardEdges(draft([2], [])), /blockers must appear earlier/);
});

test("a blocker outside the draft is refused", () => {
  assert.throws(() => assertBackwardEdges(draft([], [5])), /not a ticket in this draft/);
});
