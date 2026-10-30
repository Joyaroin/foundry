import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, normalize, rounds, type Plan } from "./plan.js";

const candidates = [41, 44, 50, 57, 60].map((number) => ({ number, title: `issue ${number}` }));
const build = (number: number, blockedBy: number[] = [], touches = [`src/${number}.ts`]) => ({
  number,
  decision: "build" as const,
  reason: "",
  blockedBy,
  touches,
});
const skip = (number: number, reason = "needs a decision") => ({ number, decision: "skip" as const, reason, blockedBy: [], touches: [] });
const proposal = (issues: ReturnType<typeof build | typeof skip>[], merges: { issues: number[]; why: string }[] = []) => ({
  title: "t",
  sharedInterfaces: "None",
  testingDecisions: "node:test",
  issues,
  merges,
});

test("every assessed issue must be accounted for, once", () => {
  assert.throws(() => normalize(proposal([build(41), build(44), build(50), build(57)]), candidates), /says nothing about #60/);
  assert.throws(() => normalize(proposal([build(41), build(41), build(44), build(50), build(57), skip(60)]), candidates), /lists #41 twice/);
  assert.throws(() => normalize(proposal([build(41), build(44), build(50), build(57), skip(60), build(99)]), candidates), /#99/);
});

test("a merge keeps the oldest issue and gives it every member's links and files", () => {
  const p = normalize(
    proposal([build(41), build(44, [57]), build(50), build(57, [50], ["src/export.ts"]), skip(60)], [{ issues: [57, 41], why: "same export" }]),
    candidates,
  );
  assert.deepEqual(p.merges, [{ keep: 41, absorb: [57], why: "same export" }]);
  const kept = p.build.find((i) => i.number === 41)!;
  assert.deepEqual(kept.blockedBy, [50]);
  assert.deepEqual(kept.touches.sort(), ["src/41.ts", "src/export.ts"]);
  assert.deepEqual(p.build.find((i) => i.number === 44)!.blockedBy, [41], "a link to the absorbed issue now points at the survivor");
  assert.equal(p.build.some((i) => i.number === 57), false);
});

test("an issue cannot be merged and skipped at once, or merged twice", () => {
  assert.throws(() => normalize(proposal([build(41), build(44), build(50), build(57), skip(60)], [{ issues: [41, 60], why: "" }]), candidates), /merged but decided skip/);
  assert.throws(
    () => normalize(proposal([build(41), build(44), build(50), build(57), skip(60)], [{ issues: [41, 44], why: "" }, { issues: [44, 50], why: "" }]), candidates),
    /#44 is in two merges/,
  );
});

test("an issue that depends on one not being built is not built either, and neither is what depends on it", () => {
  const p = normalize(proposal([build(41, [60]), build(44, [41]), build(50), build(57), skip(60)]), candidates);
  assert.deepEqual(p.build.map((i) => i.number), [50, 57]);
  assert.match(p.skip.find((s) => s.number === 41)!.reason, /depends on #60/);
  assert.match(p.skip.find((s) => s.number === 44)!.reason, /depends on #41/);
});

test("a dependency cycle is refused", () => {
  assert.throws(() => normalize(proposal([build(41, [44]), build(44, [41]), build(50), build(57), skip(60)]), candidates), /cycle through #41, #44/);
});

test("an issue to be built must declare its files", () => {
  assert.throws(() => normalize(proposal([build(41, [], []), build(44), build(50), build(57), skip(60)]), candidates), /#41 .* declares no files/);
});

test("the rounds follow dependencies and hold back an issue sharing files with one already chosen", () => {
  const issues = [
    { number: 41, title: "", blockedBy: [], touches: ["src/a.ts"], reason: "" },
    { number: 44, title: "", blockedBy: [], touches: ["src/a.ts"], reason: "" },
    { number: 50, title: "", blockedBy: [41], touches: ["src/b.ts"], reason: "" },
  ];
  assert.deepEqual(rounds(issues, 3), [
    { built: [41], held: [44] },
    { built: [44, 50], held: [] },
  ]);
});

test("the printout shows every link the plan adds and every one it removes", () => {
  const plan: Plan = {
    repo: "o/r",
    title: "t",
    sharedInterfaces: "",
    testingDecisions: "",
    build: [{ number: 44, title: "", blockedBy: [41], touches: ["x"], reason: "" }, { number: 41, title: "", blockedBy: [], touches: ["y"], reason: "" }],
    merges: [],
    skip: [],
    excluded: [],
    before: { "44": [33] },
    updatedAt: {},
  };
  const lines = describe(plan, 2);
  assert.ok(lines.includes("link  + #44 blocked by #41"));
  assert.ok(lines.some((l) => l.startsWith("link  − #44 blocked by #33")));
});
