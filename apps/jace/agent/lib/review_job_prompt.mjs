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
// exact-head boot. R7.1 attests the environment decision only: a ready boot
// remains `not_proven` until R7.2 provides server-custodied criterion
// execution artifacts; a before-ready terminal failure may be `not_testable`
// only when the tool returns the server-recomputed state/observation. The
// full-string EXPECTED pin in test/review_job_prompt.test.mjs is updated in
// lockstep.
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
    `- After fetching the confirmed Contract and before collecting proof, call plan_review_verification once with jobId ${id} and every confirmed criterion exactly once. For this R7.1 slice, only a ui criterion may be planned: give it modality ui, status planned, and a bounded criterion-specific flow. The console binds that plan to the isolated exact-head preview; do not put an environment, repository, PR, or head in the plan. Every api, job, or data criterion MUST use its actual modality, status not_testable, and the concrete reason that its executor is not available until R7.2. A user-visible criterion remains modality ui even when it is not_testable; never relabel it to avoid the UI path. A planned criterion needs flow and no notTestableReason; a not_testable criterion needs notTestableReason and no flow. If the plan cannot be recorded, do not report a successful review.`,
    `- If any ui criterion was planned, call request_preview_boot with jobId ${id}. The console derives the workspace, repo, PR, and exact head from the bound running job; never supply or substitute those fields yourself. R7.1 attests only the environment, not criterion execution: for every planned ui criterion use the tool's attestedState and attestedObservation verbatim and exactly one evidenceRef, preview-boot:<returned boot id>. A ready exact-head preview is therefore not_proven until R7.2 adds server-custodied criterion execution artifacts; never turn it into proven or failed from model-authored QA. A before-ready failed/torn-down boot is not_testable only when the tool returns an attestedState and attestedObservation. If the tool returns no attestedState, do not post or report success; let the turn fail. If it returns a bootLogKey, that exact key may be the only evidenceKeys entry; do not add screenshot or other artifact keys in R7.1. A PR-comment preview URL is not exact-head evidence unless the server attests it; no such existing-preview rung is currently wired. For a plan-declared not_testable criterion, use its stored concrete notTestableReason with no evidenceRefs.`,
    `- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules: acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.`,
    `- Only after every criterionResult is terminal, set verdict to not_proven when any criterion is not_proven, otherwise not_testable. Post once with post_pr_review and include reviewJob: { jobId: ${id}, criterionResults, verdict, summaryLine, evidenceKeys when present }. The console derives the target from the bound job, validates the exact Contract plan and preview evidence before GitHub, and reserves the one external write. Return the same verdict, summaryLine, criterionResults, and evidenceKeys verbatim after the tool succeeds. One review, one verdict.`,
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
 * In R7.1 the only allowed key is the exact `bootLogKey` returned by
 * `request_preview_boot`; screenshot and criterion-execution artifacts remain
 * unavailable until R7.2. review_job_worker.core.mjs passes a present array
 * through to `complete()` unchanged, where the Console resolves it against
 * the exact boot before accepting the posted outcome.
 */
export const REVIEW_JOB_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posted", "reviewUrl", "verdict", "blockers", "summaryLine", "criterionResults"],
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
      enum: ["not_proven", "not_testable"],
      description: "The R7.1 trust verdict: not_proven when any planned exact-head environment became ready, otherwise not_testable.",
    },
    blockers: {
      type: "array",
      items: { type: "string" },
      description: "Every blocker-severity finding's title, in the order they were posted.",
    },
    summaryLine: {
      type: "string",
      description: "One line for the owner: repo, PR, verdict, and the judgment verdicts.",
    },
    criterionResults: {
      type: "array",
      description: "Exactly one result for every confirmed Acceptance Contract criterion. In R7.1, a planned UI result uses only the tool-attested not_proven/not_testable state and observation plus exactly one preview-boot:<id> reference; proven and failed require R7.2 custody and are not allowed yet. A plan-declared not_testable result uses its stored reason and no evidenceRefs.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "state", "expected", "observed", "evidenceRefs"],
        properties: {
          criterionId: { type: "string" },
          state: { enum: ["not_proven", "not_testable"] },
          expected: { type: "string" }, observed: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidenceKeys: {
      type: "array",
      items: { type: "string" },
      description:
        "R7.1 permits only the exact server-custodied bootLogKey returned by " +
        "request_preview_boot. Screenshot and criterion artifact keys require " +
        "the R7.2 custody seam. Omit this field when no bootLogKey was returned.",
    },
  },
};
