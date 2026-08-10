// The canned choreography prompt for Arc B's headless review-job worker —
// the single message sent to a fresh root Jace session once a review job has
// been claimed (review_job_worker.mjs's assembler; the poll/claim/execute/
// complete loop itself lives in review_job_worker.core.mjs, Task 5). Root
// already knows how to review a PR in chat (dispatch the reviewer subagent,
// relay it honestly, post via post_pr_review, fold in qa for behavioral ACs
// when a preview URL is reachable) — this prompt just names the ONE PR and
// asks for exactly that same choreography, headlessly, with no human in the
// loop to ask a follow-up question or catch a softened answer.
//
// The bulleted body below is VERBATIM from the Arc B plan's Task 6 brief
// (docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md §4) — only
// the four placeholders and incidental line-wrapping are not verbatim. The
// brief hard-wraps mid-sentence to fit its markdown code fence; that
// wrapping carries no meaning and is collapsed here to one line per bullet.
// Every prose-pin substring the brief requires ("Dispatch the reviewer
// subagent", "post_pr_review", "cannot_judge never softened", "not_testable
// with the concrete reason", "Do not create issues", "Return ONLY the
// structured result") survives that collapse intact — none of them straddled
// a wrap boundary in the source text (verified word-for-word against the
// brief before writing this; test/review_job_prompt.test.mjs pins the FULL
// text exact-string, not just these substrings, so any future wording drift
// fails loudly regardless of which phrase moved).
//
// UPDATED (B2b-ii's Task 2, 2026-08-03 — docs/superpowers/plans/2026-08-03-
// b2b-reviewer-wiring.md): the QA-fold bullet now has explicit environment
// handling. The tool now accepts only the review job id; the console resolves
// the workspace/repo/PR/head from that bound running job and admits an isolated
// exact-head boot. R7.2 adds deterministic UI, API, and bounded JSON-data
// execution paths: server-reserved exact-head runs and retained receipts. Job
// criteria still hold, and any execution gap falls
// back to R7.1's attested not_proven/not_testable environment outcome. The
// full-string EXPECTED pin in test/review_job_prompt.test.mjs moves in lockstep.
//
// WHAT THIS PROMPT DELIBERATELY DOES NOT SAY: it never tells the model what
// to do if posting fails. That is intentional, not an oversight. See
// review_job_worker.mjs's header comment ("THE HONESTY COUPLING") for the
// full mechanics — UPDATED post-live-smoke (2026-08-02):
// review_job_worker.core.mjs now READS `result.posted` and completes a
// `posted:false` (or field-absent) turn as `outcome:"failed"` rather than
// `"posted"`, so it is no longer true that this loop never reads the field.
// The Task 6 brief is still explicit that the structured-result contract
// (this prompt's text, verbatim above) stays exactly as specified,
// unchanged — so the honesty instruction ("a failed post must never
// complete as posted:false; let it fail instead") still lives in this
// schema's own field descriptions below as the FIRST line of defense (the
// one place this task is free to add it without touching the locked prompt
// text); the core's own read of `result.posted` is now a SECOND, enforced
// backstop for a model that reports `posted:false` honestly instead of
// throwing — exactly what live smoke observed root do.

/**
 * Build the one message sent to root for a single claimed review job.
 *
 * @param {{ id: string, repo: string, prNumber: number, headSha: string }} job
 * @returns {string}
 */
export function reviewJobPrompt(job) {
  const { id, repo, prNumber, headSha } = job;
  return [
    `You are executing review job ${id} headlessly — no human is in this conversation.`,
    `Review PR #${prNumber} in ${repo} at head ${headSha}. Do exactly your normal review choreography:`,
    `- First call fetch_change_record for this repo and PR. Use ONLY its confirmed acceptanceContract criteria. If it is missing or malformed, do not post a success review; return posted:false with the reason.`,
    `- After fetching the confirmed Contract and before collecting proof, call plan_review_verification once with jobId ${id} and every confirmed criterion exactly once. A planned ui criterion needs modality ui, status planned, a bounded criterion-specific flow, and uiSteps: first one safe relative-path open, then only bounded click/fill/press actions, then exactly one expect_text assertion and one final screenshot. A planned api criterion needs modality api, status planned, a criterion-specific flow, and apiRequest: exactly method GET, one safe relative path, and expectedStatus. Plan api only when that exact same-origin GET/status assertion conclusively verifies the criterion; if response-body semantics, auth, mutation, headers, or other behavior matter, keep its actual modality api with status not_testable and the concrete reason. A planned data criterion needs modality data, status planned, a bounded criterion-specific flow, and dataRequest: exactly method GET, one safe relative path, expectedStatus, and one to twelve exact {pointer,equals} JSON-scalar assertions. Plan data only when that bounded exact-preview JSON readback conclusively verifies the criterion. A planned job criterion needs modality job, status planned, a bounded criterion-specific flow, and jobRequest: exactly one preview-local POST trigger at /__agentrail/verification/jobs/<id>/trigger with 200-299 expectedStatus, immediately followed by one GET JSON-scalar readback at /__agentrail/verification/jobs/<same-id>/result with 200-299 expectedStatus and one to twelve exact {pointer,equals} assertions; the id must match [A-Za-z0-9._-]{1,64}. Plan job only when this explicit trigger plus immediate bounded readback conclusively verifies the criterion. Body, auth, external, arbitrary, asynchronous-not-immediate, raw-body, and non-scalar jobs remain modality job with status not_testable and the concrete reason. Secrets, auth, external sources, arbitrary query, mutation, raw bodies, and non-scalar semantics remain modality data with status not_testable and the concrete reason. The console persists and binds planned descriptors to the isolated exact-head preview; do not put an environment, repository, PR, head, absolute URL, script, discovered page instruction, headers, body, or credentials in the plan. The server owns the user-visible modality policy; never relabel a user-visible criterion to avoid the UI path. A planned criterion needs flow and its modality descriptor but no notTestableReason; a not_testable criterion needs notTestableReason and neither flow nor a descriptor. If the plan cannot be recorded, do not report a successful review.`,
    `- If any ui, api, data, or job criterion was planned, call request_preview_boot with jobId ${id}. The console derives the workspace, repo, PR, and exact head from the bound running job; never supply or substitute those fields yourself. For every planned ui criterion, call execute_review_ui once with jobId ${id}, that criterionId, and previewBootId set to the exact id returned by request_preview_boot. The executor replays only the persisted steps. For every planned api criterion, call execute_review_api once with the same opaque ids; it performs only the persisted same-origin GET with redirect errors and no response-body read. For every planned data criterion, call execute_review_data once with the same opaque ids; it performs only the persisted same-origin GET, redirects are errors, sends no headers, body, auth, or credentials, bounds JSON before parsing, and resolves only the declared scalar pointers. For every planned job criterion, call execute_review_job once with the same opaque ids; it performs exactly one same-origin bodyless POST trigger with redirect errors, then only on its expected status one immediate bounded JSON GET readback with no headers, body, auth, or credentials. A job status or assertion mismatch is server-attested not_proven, never a failed criterion. When any executor returns ok:true, copy its state, expected, observed, and evidenceRef verbatim into that criterionResult; only its server-attested receipt may produce proven or failed. Include every successful UI, API, or data evidenceKey in evidenceKeys, and include every successful job evidenceKey too. If execution degrades, use request_preview_boot's attestedState and attestedObservation verbatim with exactly one evidenceRef preview-boot:<returned boot id>; a ready environment then remains not_proven, and a before-ready failed/torn-down boot is not_testable only when the preview tool attests it. If neither tool returns an attested outcome, do not post or report success; let the turn fail. Include the exact bootLogKey when returned, plus every successful UI, API, or data execution evidenceKey, every successful job execution evidenceKey, and no other evidenceKeys. A PR-comment preview URL is not exact-head evidence unless the server attests it. For a plan-declared not_testable criterion, use its stored concrete notTestableReason with no evidenceRefs.`,
    `- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules: acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.`,
    `- Only after every criterionResult is terminal, set verdict by this priority: failed if any criterion failed; otherwise not_proven if any is not_proven; otherwise not_testable if any is not_testable; otherwise proven. Post once with post_pr_review and include reviewJob: { jobId: ${id}, criterionResults, verdict, summaryLine, evidenceKeys when present }. The console derives the target from the bound job, validates the exact Contract plan, execution receipts, screenshot custody, and preview evidence before GitHub, and reserves the one external write. Return the same verdict, summaryLine, criterionResults, and evidenceKeys verbatim after the tool succeeds. One review, one verdict.`,
    `- Do not create issues, send channel messages, or take any action beyond the review itself.`,
    `Return ONLY the structured result: posted, reviewUrl, verdict, blockers (every blocker-severity finding title), summaryLine (one line for the owner: repo, PR, verdict, judgment verdicts), criterionResults (exactly one terminal result for every confirmed criterion), and evidenceKeys when evidence was captured.`,
  ].join("\n");
}

/**
 * The structured result schema every claimed review-job turn must satisfy
 * (eve's `outputSchema`, which forces task mode). Field names and
 * nullability are the Arc B plan's Task 6 contract verbatim — see
 * review_job_worker.core.mjs (Task 5) for exactly how each field is consumed
 * once the turn resolves: `reviewUrl` -> `postedReviewUrl`, `verdict`/
 * `summaryLine` pass through unchanged, `blockers` is read by NOTHING
 * downstream of this schema, and `posted` — UPDATED post-live-smoke
 * (2026-08-02; see this module's header comment) — IS now read: the core
 * completes `outcome:"failed"` instead of `"posted"` whenever this field is
 * anything but a literal `true`.
 *
 * `evidenceKeys` is optional because a preview boot may have no retained log.
 * Allowed keys are exact boot logs plus server-custodied UI, API, data, and
 * job evidence.
 * review_job_worker.core.mjs passes a present array through to `complete()`
 * unchanged, where the Console resolves every key against the exact plan,
 * receipt, and boot before accepting the posted outcome.
 */
export const REVIEW_JOB_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "posted",
    "reviewUrl",
    "verdict",
    "blockers",
    "summaryLine",
    "criterionResults",
  ],
  properties: {
    posted: {
      type: "boolean",
      description:
        "Whether the job-scoped, pre-write-attested post_pr_review call actually posted a review. This turn must " +
        "only complete when a review was genuinely posted — if posting " +
        "fails, do not return this result at all; let the failure " +
        "propagate instead of reporting posted:false.",
    },
    reviewUrl: {
      type: "string",
      description: "The inspectable URL returned for the posted GitHub review.",
    },
    verdict: {
      enum: ["proven", "failed", "not_proven", "not_testable"],
      description:
        "The server-attested criterion aggregate: failed, then not_proven, then not_testable, otherwise proven.",
    },
    blockers: {
      type: "array",
      items: { type: "string" },
      description:
        "Every blocker-severity finding's title, in the order they were posted.",
    },
    summaryLine: {
      type: "string",
      description:
        "One line for the owner: repo, PR, verdict, and the judgment verdicts.",
    },
    criterionResults: {
      type: "array",
      description:
        "Exactly one result for every confirmed Acceptance Contract criterion. A successful planned UI, API, or data execution uses only its server-attested proven/failed state, expected, observed, and exact receipt. A successful planned job execution uses only its server-attested proven/not_proven state and exact review-job-execution:<id> receipt; job mismatches never become failed without a trusted terminal-failure predicate. If execution is unavailable, the exact preview tool may attest the R7.1 not_proven/not_testable fallback. A plan-declared not_testable result uses its stored reason and no evidenceRefs.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "criterionId",
          "state",
          "expected",
          "observed",
          "evidenceRefs",
        ],
        properties: {
          criterionId: { type: "string" },
          state: { enum: ["proven", "failed", "not_proven", "not_testable"] },
          expected: { type: "string" },
          observed: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidenceKeys: {
      type: "array",
      items: { type: "string" },
      description:
        "Include every exact UI screenshot, API status-card, data assertion-card, or job assertion-card evidenceKey returned by an executor and the optional exact bootLogKey returned by request_preview_boot. No model-authored or arbitrary keys are allowed.",
    },
  },
};
