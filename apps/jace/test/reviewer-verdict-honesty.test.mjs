// #1481 — root's `agent/instructions.md` "Reviewing a pull request"
// section IS the mechanism that stops root from upgrading the reviewer's
// verdict into an approval. The reviewer subagent's own
// `agent/subagents/reviewer/instructions.md` carries the matching charter
// for AC coverage, keeping it diff-honest rather than confabulated. Like
// fetch-work-status-instructions.test.mjs (whose header explains the
// convention), both files' prose carries functional weight the way code
// usually does: delete a rule and every other test still passes, silently
// re-enabling the bug it guards.
//
// The bug this guards, observed in prod 2026-07-27 on PR #1478: the reviewer
// returned the on-contract `verdict: "reviewed"` with a single minor
// documentation nit, and root relayed it to the human as "Verdict: Approved
// with a small documentation tweak" — an approval the reviewer never gave,
// on a PR that had real unflagged defects (#1480). Root had also handed the
// subagent an ad-hoc `outputSchema` whose verdict enum
// (approve/needs_changes/blocker) contains no value the subagent can produce.
//
// Asserts the PROSE states each rule, not that a model follows it — matching
// on the load-bearing keywords, not exact wording, so a reword doesn't break
// this but a deletion does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AC_COVERAGE_STATUSES } from "../agent/subagents/reviewer/lib/reviewer.core.mjs";

const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));
const verdictsPath = fileURLToPath(
  new URL("../agent/subagents/reviewer/lib/reviewer.core.mjs", import.meta.url),
);

function instructions() {
  return readFileSync(instructionsPath, "utf8");
}

test("the reviewer's verdict vocabulary is exactly reviewed|degraded — the contract the rules below describe", () => {
  // Pins the two files in lockstep: if REVIEW_VERDICTS ever grows an
  // approval-shaped value, the prose rules need revisiting, not silently
  // contradicting the schema.
  const src = readFileSync(verdictsPath, "utf8");
  assert.match(src, /REVIEW_VERDICTS\s*=\s*\[\s*"reviewed"\s*,\s*"degraded"\s*\]/);
});

test("instructions.md states that `reviewed` is NOT an approval", () => {
  const src = instructions();
  assert.match(
    src,
    /`reviewed` does\s+NOT\s+mean\s+approved/i,
    "must state the rule that shipped a false approval to a human",
  );
  assert.match(
    src,
    /[Zz]ero findings is a legitimate\s+`reviewed`/,
    "must say an empty review is still not a sign-off",
  );
});

test("instructions.md forbids root passing its own outputSchema to the reviewer", () => {
  const src = instructions();
  assert.match(
    src,
    /[Nn]ever hand the\s+`reviewer`\s+an\s+`outputSchema`/,
    "root inventing a competing verdict enum is what forced the mistranslation",
  );
});

test("instructions.md states the reviewer sees only the diff, so a review is not an audit", () => {
  const src = instructions();
  assert.match(
    src,
    /[Aa] review is not an\s+audit/,
    "must bound what a diff-only pass can establish",
  );
  // `\s+`, not a literal space: markdown wraps this section at ~72 cols, so
  // the phrase straddles a newline today and could straddle a different one
  // after any reflow. The rule is what must survive, not the line breaks.
  assert.match(
    src,
    /no\s+repo\s+access/i,
    "must name the actual limitation, not just caution generally",
  );
});

test("instructions.md still keeps the pre-existing degraded-verdict honesty rule (regression)", () => {
  const src = instructions();
  assert.match(
    src,
    /verdict is `degraded`/,
    "the new rules are additive — the degraded rule must survive them",
  );
});

const reviewerInstructionsPath = fileURLToPath(
  new URL("../agent/subagents/reviewer/instructions.md", import.meta.url),
);

test("reviewer instructions state the coverage vocabulary in lockstep with AC_COVERAGE_STATUSES", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  for (const status of AC_COVERAGE_STATUSES) {
    assert.ok(
      prose.includes(`\`${status}\``),
      `instructions must define coverage status \`${status}\``,
    );
  }
});

test("reviewer instructions carry both canonical null-coverage wordings", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  assert.ok(prose.includes("No recognizable acceptance criteria found"));
  assert.ok(prose.includes("could not be reliably parsed"));
});

test("reviewer instructions pin the source order: linked-issue ACs beat the PR body's own list", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  assert.ok(/never overrides or extends/.test(prose));
  assert.ok(/issueNumber: null/.test(prose) || /`issueNumber` of `null`/.test(prose));
});

test("root instructions: acCoverage is relayed verbatim to post_pr_review, never re-judged", () => {
  const prose = instructions();
  assert.ok(prose.includes("acCoverage"));
  assert.ok(/acCoverage[^.]*verbatim/i.test(prose));
});

test("root instructions: null coverage is reported as a diff-only review, echoing the reviewer's reason", () => {
  const prose = instructions();
  assert.ok(/diff-only/.test(prose));
  assert.ok(/no recognizable ACs|not reliably parseable/i.test(prose));
});
