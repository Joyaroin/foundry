import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./review.js";

const met = (criterion: string) => ({ criterion, met: true, evidence: "a.js:1" });

test("every criterion met and nothing blocking is approved", () => {
  const v = decide({ criteria: [met("adds"), met("throws")], blocking: [], notes: ["style"] });
  assert.equal(v.approved, true);
  assert.match(v.detail, /^Review: 2\/2 acceptance criteria met/);
});

test("one unmet criterion rejects, and says which", () => {
  const v = decide({ criteria: [met("adds"), { criterion: "throws", met: false, evidence: "none" }], blocking: [], notes: [] });
  assert.equal(v.approved, false);
  assert.match(v.detail, /not met: throws/);
});

test("a blocking finding rejects even when every criterion is met", () => {
  const v = decide({ criteria: [met("adds")], blocking: ["a.js:3 loses data"], notes: [] });
  assert.equal(v.approved, false);
  assert.match(v.detail, /blocking: a.js:3 loses data/);
});

test("a review that judged nothing approves nothing", () => {
  assert.equal(decide({ criteria: [], blocking: [], notes: [] }).approved, false);
});
