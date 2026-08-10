// Root-only deterministic UI verification for a bound headless review job.
// The model selects only opaque ids already returned by server-owned tools;
// the Console supplies the persisted steps and exact preview coordinates.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { createReviewUiExecuteFn } from "../lib/review_ui_executor.mjs";

const executeReviewUi = createReviewUiExecuteFn();

export default defineTool({
  description:
    "Execute one persisted planned UI criterion against the isolated exact-head preview and retain the decisive screenshot. " +
    "Use only after plan_review_verification and request_preview_boot. The model supplies only the current review job, criterion, and returned preview boot ids; repository, PR, head, flow, browser target, result state, observation, and artifact custody are all resolved or attested server-side. " +
    "This tool is ungated because it runs only the already-reserved bounded flow inside an isolated preview. A degraded result is not criterion proof; fall back to the preview tool's attested R7.1 not_proven/not_testable outcome.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    criterionId: z.string().min(1),
    previewBootId: z.string().min(1),
  }).strict(),
  async execute(input, ctx) {
    return executeReviewUi({
      eveSessionId: ctx.session.id,
      jobId: input.jobId,
      criterionId: input.criterionId,
      previewBootId: input.previewBootId,
    });
  },
});
