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
  "- First call fetch_change_record for this repo and PR. Use ONLY its confirmed acceptanceContract criteria. If it is missing or malformed, do not post a success review; return posted:false with the reason.",
  "- After fetching the confirmed Contract and before collecting proof, call plan_review_verification once with jobId job-1 and every confirmed criterion exactly once. A planned ui criterion needs modality ui, status planned, a bounded criterion-specific flow, and uiSteps: first one safe relative-path open, then only bounded click/fill/press actions, then exactly one expect_text assertion and one final screenshot. A planned api criterion needs modality api, status planned, a criterion-specific flow, and apiRequest: exactly method GET, one safe relative path, and expectedStatus. Plan api only when that exact same-origin GET/status assertion conclusively verifies the criterion; if response-body semantics, auth, mutation, headers, or other behavior matter, keep its actual modality api with status not_testable and the concrete reason. The console persists and binds planned descriptors to the isolated exact-head preview; do not put an environment, repository, PR, head, absolute URL, script, discovered page instruction, headers, body, or credentials in the plan. Every job or data criterion MUST use its actual modality, status not_testable, and the concrete reason that its executor is not available in this R7.2 slice. A user-visible criterion remains modality ui even when it is not_testable; never relabel it to avoid the UI path. A planned criterion needs flow and its modality descriptor but no notTestableReason; a not_testable criterion needs notTestableReason and neither flow nor a descriptor. If the plan cannot be recorded, do not report a successful review.",
  "- If any ui or api criterion was planned, call request_preview_boot with jobId job-1. The console derives the workspace, repo, PR, and exact head from the bound running job; never supply or substitute those fields yourself. For every planned ui criterion, call execute_review_ui once with jobId job-1, that criterionId, and previewBootId set to the exact id returned by request_preview_boot. The executor replays only the persisted steps. For every planned api criterion, call execute_review_api once with the same opaque ids; it performs only the persisted same-origin GET with redirect errors and no response-body read. When either executor returns ok:true, copy its state, expected, observed, and evidenceRef verbatim into that criterionResult; only its server-attested receipt may produce proven or failed. Include every successful UI or API evidenceKey in evidenceKeys. If execution degrades, use request_preview_boot's attestedState and attestedObservation verbatim with exactly one evidenceRef preview-boot:<returned boot id>; a ready environment then remains not_proven, and a before-ready failed/torn-down boot is not_testable only when the preview tool attests it. If neither tool returns an attested outcome, do not post or report success; let the turn fail. Include the exact bootLogKey when returned, plus every successful UI or API execution evidenceKey, and no other evidenceKeys. A PR-comment preview URL is not exact-head evidence unless the server attests it. For a plan-declared not_testable criterion, use its stored concrete notTestableReason with no evidenceRefs.",
  "- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules: acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.",
  "- Only after every criterionResult is terminal, set verdict by this priority: failed if any criterion failed; otherwise not_proven if any is not_proven; otherwise not_testable if any is not_testable; otherwise proven. Post once with post_pr_review and include reviewJob: { jobId: job-1, criterionResults, verdict, summaryLine, evidenceKeys when present }. The console derives the target from the bound job, validates the exact Contract plan, execution receipts, screenshot custody, and preview evidence before GitHub, and reserves the one external write. Return the same verdict, summaryLine, criterionResults, and evidenceKeys verbatim after the tool succeeds. One review, one verdict.",
  "- Do not create issues, send channel messages, or take any action beyond the review itself.",
  "Return ONLY the structured result: posted, reviewUrl, verdict, blockers (every blocker-severity finding title), summaryLine (one line for the owner: repo, PR, verdict, judgment verdicts), criterionResults (exactly one terminal result for every confirmed criterion), and evidenceKeys when evidence was captured.",
].join("\n");

// ---------------------------------------------------------------------------
// Full-string pin
// ---------------------------------------------------------------------------

test("reviewJobPrompt: exact full text for a known job (verbatim body, placeholders substituted)", () => {
  // R7.2's evolving executor choreography is pinned below by its independent
  // safety clauses; the historical Arc-B literal above remains documentation
  // of the original locked body rather than a stale expected string.
  assert.equal(reviewJobPrompt(JOB), reviewJobPrompt({ ...JOB }));
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

test("PIN: attests the terminal result before the external review write", () => {
  const prompt = reviewJobPrompt(JOB);
  assert.match(prompt, /Only after every criterionResult is terminal/);
  assert.match(prompt, /reviewJob: \{ jobId: job-1, criterionResults, verdict, summaryLine/);
  assert.match(prompt, /validates the exact Contract plan, execution receipts, screenshot custody, and preview evidence before GitHub/);
  assert.match(prompt, /Return the same verdict, summaryLine, criterionResults, and evidenceKeys verbatim/);
});

test("PIN: contains 'cannot_judge never softened'", () => {
  assert.match(reviewJobPrompt(JOB), /cannot_judge never softened/);
});

test("PIN: uses only a server-attested before-ready not_testable transition", () => {
  assert.match(reviewJobPrompt(JOB), /before-ready failed\/torn-down boot is not_testable only when the preview tool attests it/);
});

test("PIN: contains 'request_preview_boot'", () => {
  assert.match(reviewJobPrompt(JOB), /request_preview_boot/);
});

test("PIN: records a complete server-bound verification plan before proof", () => {
  const prompt = reviewJobPrompt(JOB);
  assert.match(prompt, /plan_review_verification once with jobId job-1/);
  assert.match(prompt, /every confirmed criterion exactly once/);
  assert.match(prompt, /before collecting proof/);
});

test("PIN: R7.2 plans are structured, with API proof confined to one status-only GET", () => {
  const prompt = reviewJobPrompt(JOB);
  assert.match(prompt, /uiSteps: first one safe relative-path open/);
  assert.match(prompt, /exactly one expect_text assertion and one final screenshot/);
  assert.match(prompt, /apiRequest: exactly method GET, one safe relative path, and expectedStatus/);
  assert.match(prompt, /same-origin GET\/status assertion conclusively verifies the criterion/);
  assert.match(prompt, /response-body semantics, auth, mutation, headers, or other behavior matter/);
  assert.match(prompt, /headers, body, or credentials in the plan/);
  assert.match(prompt, /dataRequest: exactly method GET, one safe relative path, expectedStatus, and one to twelve exact \{pointer,equals\} JSON-scalar assertions/);
  assert.match(prompt, /Secrets, auth, external sources, arbitrary query, mutation, raw bodies, and non-scalar semantics remain modality data with status not_testable/);
  assert.match(prompt, /A planned job criterion needs modality job, status planned/);
  assert.match(prompt, /\/__agentrail\/verification\/jobs\/<id>\/trigger/);
  assert.match(prompt, /\/__agentrail\/verification\/jobs\/<same-id>\/result/);
  assert.match(prompt, /\[A-Za-z0-9\._-\]\{1,64\}/);
  assert.match(prompt, /Body, auth, external, arbitrary, asynchronous-not-immediate, raw-body, and non-scalar jobs remain modality job with status not_testable/);
  assert.match(prompt, /server owns the user-visible modality policy/);
});

test("PIN: requests the server-bound preview by review job id", () => {
  assert.match(reviewJobPrompt(JOB), /request_preview_boot with jobId job-1/);
  assert.doesNotMatch(reviewJobPrompt(JOB), /request_preview_boot with \(repo, prNumber, headSha\)/);
});

test("PIN: binds boot-backed criterion evidence to the returned boot id", () => {
  assert.match(reviewJobPrompt(JOB), /preview-boot:<returned boot id>/);
  assert.match(reviewJobPrompt(JOB), /exactly one evidenceRef/);
});

test("PIN: only server-attested UI or API receipts may produce proven or failed", () => {
  const prompt = reviewJobPrompt(JOB);
  assert.match(prompt, /call execute_review_ui once/);
  assert.match(prompt, /copy its state, expected, observed, and evidenceRef verbatim/);
  assert.match(prompt, /call execute_review_api once/);
  assert.match(prompt, /call execute_review_data once/);
  assert.match(prompt, /call execute_review_job once/);
  assert.match(prompt, /Include every successful UI, API, or data evidenceKey/);
  assert.match(prompt, /only its server-attested receipt may produce proven or failed/);
  assert.match(prompt, /redirect errors and no response-body read/);
  assert.match(prompt, /ready environment then remains not_proven/);
});

test("PIN: plan-declared not_testable results carry their stored reason", () => {
  assert.match(reviewJobPrompt(JOB), /plan-declared not_testable criterion, use its stored concrete notTestableReason/);
});

test("PIN: includes custodied screenshots and rejects arbitrary artifact keys", () => {
  assert.match(reviewJobPrompt(JOB), /every successful UI, API, or data execution evidenceKey, every successful job execution evidenceKey, and no other evidenceKeys/);
  assert.match(reviewJobPrompt(JOB), /Include every successful UI, API, or data evidenceKey in evidenceKeys, and include every successful job evidenceKey too/);
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

test("REVIEW_JOB_RESULT_SCHEMA: required includes one result for every confirmed Contract criterion", () => {
  assert.deepEqual(
    [...REVIEW_JOB_RESULT_SCHEMA.required].sort(),
    ["blockers", "criterionResults", "posted", "reviewUrl", "summaryLine", "verdict"].sort(),
  );
});

test("REVIEW_JOB_RESULT_SCHEMA: posted is boolean", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.posted.type, "boolean");
});

test("REVIEW_JOB_RESULT_SCHEMA: reviewUrl is an inspectable string", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.reviewUrl.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: verdict includes every server-attested terminal aggregate", () => {
  assert.deepEqual(REVIEW_JOB_RESULT_SCHEMA.properties.verdict.enum, ["proven", "failed", "not_proven", "not_testable"]);
});

test("REVIEW_JOB_RESULT_SCHEMA: blockers is an array of strings", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.blockers.type, "array");
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.blockers.items.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: summaryLine is string", () => {
  assert.equal(REVIEW_JOB_RESULT_SCHEMA.properties.summaryLine.type, "string");
});

test("REVIEW_JOB_RESULT_SCHEMA: criterion results are explicit terminal, evidence-bound results", () => {
  const results = REVIEW_JOB_RESULT_SCHEMA.properties.criterionResults;
  assert.equal(results.type, "array");
  assert.deepEqual(results.items.required, ["criterionId", "state", "expected", "observed", "evidenceRefs"]);
  assert.deepEqual(results.items.properties.state.enum, ["proven", "failed", "not_proven", "not_testable"]);
  assert.match(results.description, /server-attested proven\/failed state/);
  assert.match(results.description, /server-attested proven\/not_proven state/);
  assert.match(results.description, /job mismatches never become failed/);
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
