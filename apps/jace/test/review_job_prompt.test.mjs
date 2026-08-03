// Unit tests for the Arc B headless review-job worker's canned choreography
// prompt (Task 6). Two things are pinned:
//
// 1. The FULL prompt text, exact-string, for a known job — the strongest
//    possible pin against wording drift in the brief's verbatim-required
//    bulleted body (docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md
//    §4). The brief hard-wraps mid-sentence to fit its markdown code fence;
//    that wrapping carries no meaning and review_job_prompt.mjs collapses it
//    to one line per bullet — this exact-string test proves that collapse
//    changed no actual words.
// 2. Each individual prose-pin substring the brief calls out by name, so a
//    future edit that broke just ONE of them (without necessarily breaking
//    the full-string pin, e.g. an edit to a DIFFERENT job's rendering) still
//    fails loudly and names exactly which phrase went missing.
//
// UPDATED (B2b-ii's Task 2, 2026-08-03 — docs/superpowers/plans/2026-08-03-
// b2b-reviewer-wiring.md): EXPECTED below carries the rung-2
// request_preview_boot wording for no-preview PRs. See
// review_job_prompt.mjs's own header comment for the full disclosure of this
// deviation from the original Arc B brief.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewJobPrompt, REVIEW_JOB_RESULT_SCHEMA } from "../agent/lib/review_job_prompt.mjs";

const JOB = { id: "job-1", repo: "ada/widgets", prNumber: 7, headSha: "abc123" };

const EXPECTED = [
  "You are executing review job job-1 headlessly — no human is in this conversation.",
  "Review PR #7 in ada/widgets at head abc123. Do exactly your normal review choreography:",
  "- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules: acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.",
  "- Post the review with post_pr_review. One review, one verdict.",
  "- If acceptance criteria are behavioral (running-app behavior a diff cannot prove) AND the PR carries a reachable preview URL, dispatch qa against it and fold its ac_results into the posted review's coverage before posting (rung 1). Fold its evidence_images through too, verbatim — the posted review links them per AC. If there is no preview URL, call request_preview_boot with (repo, prNumber, headSha); if it returns a booted URL, dispatch qa against THAT url exactly as rung 1 (rung 2). Regardless of whether the boot becomes ready, if request_preview_boot returns a bootLogKey, include that key in evidenceKeys in the structured result. If there is no preview URL AND no boot becomes ready, do NOT guess: the affected ACs are not_testable with the concrete reason, and the posted review says which environment rung was reached.",
  "- Do not create issues, send channel messages, or take any action beyond the review itself.",
  "Return ONLY the structured result: posted, reviewUrl, verdict, blockers (every blocker-severity finding title), summaryLine (one line for the owner: repo, PR, verdict, judgment verdicts), and evidenceKeys when evidence was captured.",
].join("\n");

// ---------------------------------------------------------------------------
// Full-string pin
// ---------------------------------------------------------------------------

test("reviewJobPrompt: exact full text for a known job (verbatim body, placeholders substituted)", () => {
  assert.equal(reviewJobPrompt(JOB), EXPECTED);
});

test("reviewJobPrompt: substitutes a DIFFERENT job's fields correctly (proves it's not hardcoded to the fixture)", () => {
  const other = { id: "job-99", repo: "octo/cat", prNumber: 42, headSha: "deadbeef" };
  const text = reviewJobPrompt(other);
  assert.match(text, /review job job-99 headlessly/);
  assert.match(text, /Review PR #42 in octo\/cat at head deadbeef\./);
  assert.doesNotMatch(text, /job-1\b/);
  assert.doesNotMatch(text, /ada\/widgets/);
});

// ---------------------------------------------------------------------------
// Individual prose pins (brief's mandatory list)
// ---------------------------------------------------------------------------

test("PIN: contains 'Dispatch the reviewer subagent'", () => {
  assert.match(reviewJobPrompt(JOB), /Dispatch the reviewer subagent/);
});

test("PIN: contains 'post_pr_review'", () => {
  assert.match(reviewJobPrompt(JOB), /post_pr_review/);
});

test("PIN: contains 'cannot_judge never softened'", () => {
  assert.match(reviewJobPrompt(JOB), /cannot_judge never softened/);
});

test("PIN: contains 'not_testable with the concrete reason'", () => {
  assert.match(reviewJobPrompt(JOB), /not_testable with the concrete reason/);
});

test("PIN: contains 'request_preview_boot'", () => {
  assert.match(reviewJobPrompt(JOB), /request_preview_boot/);
});

test("PIN: contains 'Fold its evidence_images through too'", () => {
  assert.match(reviewJobPrompt(JOB), /Fold its evidence_images through too/);
});

test("PIN: carries a rung-2 boot log key into evidenceKeys", () => {
  assert.match(reviewJobPrompt(JOB), /bootLogKey/);
  assert.match(reviewJobPrompt(JOB), /evidenceKeys/);
});

test("PIN: contains 'Do not create issues'", () => {
  assert.match(reviewJobPrompt(JOB), /Do not create issues/);
});

test("PIN: contains 'Return ONLY the structured result'", () => {
  assert.match(reviewJobPrompt(JOB), /Return ONLY the structured result/);
});

// ---------------------------------------------------------------------------
// REVIEW_JOB_RESULT_SCHEMA — field names, types, nullability pinned
// ---------------------------------------------------------------------------

test("REVIEW_JOB_RESULT_SCHEMA: is a JSON-schema object type with additionalProperties false", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.type, "object");
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.additionalProperties, false);
});

test("REVIEW_JOB_RESULT_SCHEMA: required is exactly the five brief fields", () => {
  assert.deepEqual(
    [...REVIEW_JOB_RESULT_SCHEMA.required].sort(),
    ["blockers", "posted", "reviewUrl", "summaryLine", "verdict"].sort(),
  );
});

test("REVIEW_JOB_RESULT_SCHEMA: posted is boolean", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.posted.type, "boolean");
});

test("REVIEW_JOB_RESULT_SCHEMA: reviewUrl is string|null", () => {
  assert.deepEqual([...REVIEW_JOB_RESULT_SCHEMA.properties.reviewUrl.type].sort(), ["null", "string"].sort());
});

test("REVIEW_JOB_RESULT_SCHEMA: verdict is string", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.verdict.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: blockers is an array of strings", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.blockers.type, "array");
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.blockers.items.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: summaryLine is string", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.summaryLine.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: posted's description instructs failing loudly rather than reporting posted:false (the honesty coupling review_job_worker.core.mjs depends on)", () => {
  const desc = REVIEW_JOB_RESULT_SCHEMA.properties.posted.description ?? "";
  assert.match(desc, /fail|propagat|do not return/i);
});

// ---------------------------------------------------------------------------
// evidenceKeys — B2a §1 Task 3 (spec
// docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md).
// OPTIONAL: not in `required` (pinned above as "exactly the five brief
// fields") — a model that never captured evidence must still validate
// against this schema exactly as it did before this field existed.
// ---------------------------------------------------------------------------

test("REVIEW_JOB_RESULT_SCHEMA: evidenceKeys is an array of strings", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.evidenceKeys.type, "array");
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.evidenceKeys.items.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: evidenceKeys is NOT required — additive, absent must still validate", () => {
  assert.ok(!REVIEW_JOB_RESULT_SCHEMA.required.includes("evidenceKeys"));
});
