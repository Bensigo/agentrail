// #1277 (replyable run-outcome threads) — Jace's ONE persona-level line
// wiring an inbound bracketed reply-context preface to the existing triage
// subagent. The console/dispatcher side (parsing the reply, resolving the
// run, building the preface) is covered in apps/console's own test suites;
// this file only asserts Jace's instructions.md actually tells the persona
// what to DO with that preface once it arrives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(
  new URL("../agent/instructions.md", import.meta.url),
);

test("instructions.md tells Jace a bracketed run-outcome reply preface means invoking triage with that run_id", () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(
    src,
    /reply to the run-outcome notification/,
    "instructions.md must reference the #1277 reply-context preface marker",
  );
  assert.match(
    src,
    /triage/i,
    "the reply-context guidance must connect to the existing triage subagent",
  );
});

test("the reply-context line sits near the existing triage guidance, not off on its own", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const triageHeadingIndex = src.indexOf("## Diagnosing a failed run (the triage subagent)");
  const nextHeadingIndex = src.indexOf("\n## ", triageHeadingIndex + 1);
  const replyContextIndex = src.indexOf("reply to the run-outcome notification");

  assert.notEqual(triageHeadingIndex, -1, "the triage section heading must exist");
  assert.notEqual(nextHeadingIndex, -1, "there must be a following section heading");
  assert.ok(
    replyContextIndex > triageHeadingIndex && replyContextIndex < nextHeadingIndex,
    "the #1277 reply-context line must live inside the triage section, near the existing guidance",
  );
});

test("a 'no matching run found' preface gets the same honest-gap treatment as a degraded triage call", () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(
    src,
    /no matching run found/,
    "instructions.md must acknowledge the not-found preface case, not just the found one",
  );
});
