import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(
  new URL("../legacy/reviewer/instructions.md", import.meta.url),
);

test("reviewer instructions require explicit suppression investigation entries", () => {
  const src = readFileSync(instructionsPath, "utf8");

  assert.match(src, /reviewer_suppressions` once for the reviewed repo/);
  assert.match(src, /at least three review_outcome judgment events dismissed/);
  assert.match(src, /add an `investigated` entry instead/);
  assert.match(src, /Suppression is explicit,\s+never silent/);
});
