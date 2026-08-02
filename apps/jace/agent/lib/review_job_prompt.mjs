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
    `- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules: acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.`,
    `- Post the review with post_pr_review. One review, one verdict.`,
    `- If acceptance criteria are behavioral (running-app behavior a diff cannot prove) AND the PR carries a reachable preview URL, dispatch qa against it and fold its ac_results into the posted review's coverage before posting. If there is no preview URL, do NOT guess: the affected ACs are not_testable with the concrete reason, and the posted review says which environment rung was reached.`,
    `- Do not create issues, send channel messages, or take any action beyond the review itself.`,
    `Return ONLY the structured result: posted, reviewUrl, verdict, blockers (every blocker-severity finding title), summaryLine (one line for the owner: repo, PR, verdict, judgment verdicts).`,
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
 */
export const REVIEW_JOB_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posted", "reviewUrl", "verdict", "blockers", "summaryLine"],
  properties: {
    posted: {
      type: "boolean",
      description:
        "Whether post_pr_review actually posted a review. This turn must " +
        "only complete when a review was genuinely posted — if posting " +
        "fails, do not return this result at all; let the failure " +
        "propagate instead of reporting posted:false.",
    },
    reviewUrl: {
      type: ["string", "null"],
      description: "The posted review's URL, or null if the platform did not return one.",
    },
    verdict: {
      type: "string",
      description: "The posted review's verdict, exactly as post_pr_review recorded it.",
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
  },
};
