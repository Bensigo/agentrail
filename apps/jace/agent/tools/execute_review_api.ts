// Root-only deterministic API verification. The model supplies only opaque
// ids; Console owns target, descriptor, result comparison, and receipt.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { createReviewApiExecuteFn } from "../lib/review_api_executor.mjs";

const executeReviewApi = createReviewApiExecuteFn();

export default defineTool({
  description:
    "Execute one persisted planned API criterion as a fixed same-origin GET against the isolated exact-head preview. " +
    "Use only after plan_review_verification and request_preview_boot. The model supplies only the current review job, criterion, and returned preview boot ids; URL, method, request controls, expected status, result state, and custody are resolved or attested server-side. " +
    "A degraded result is not criterion proof; use the preview tool's attested R7.1 not_proven/not_testable outcome.",
  inputSchema: z.object({ jobId: z.string().min(1), criterionId: z.string().min(1), previewBootId: z.string().min(1) }).strict(),
  async execute(input, ctx) {
    return executeReviewApi({ eveSessionId: ctx.session.id, jobId: input.jobId, criterionId: input.criterionId, previewBootId: input.previewBootId });
  },
});
