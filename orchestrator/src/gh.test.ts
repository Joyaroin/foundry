import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTouches, touchesBlock } from "./gh.js";

test("the files a ticket declares survive the round trip through its issue body", () => {
  const body = `## What to build\n\nA thing.\n\n${touchesBlock(["src/text.js", "test/text.test.js"])}\n`;
  assert.deepEqual(parseTouches(body), ["src/text.js", "test/text.test.js"]);
});

test("code spans the model wrote elsewhere in the body are not read as files", () => {
  const body = `Use \`normalise\` from \`src/text.js\`.\n\n${touchesBlock(["src/num.js"])}`;
  assert.deepEqual(parseTouches(body), ["src/num.js"]);
});

test("a body with no declared files declares none", () => {
  assert.deepEqual(parseTouches("Use `src/text.js`."), []);
  assert.deepEqual(parseTouches(null), []);
});
