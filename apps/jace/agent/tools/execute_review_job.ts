// Root-only deterministic job verification. The model provides only opaque
// ids; Console binds the exact-head preview, request, readback, and custody.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { createReviewJobExecuteFn } from "../lib/review_job_executor.mjs";

const executeReviewJob = createReviewJobExecuteFn();
export default defineTool({
  description:
    "Execute one persisted planned preview-local job criterion: exactly one bodyless same-origin POST trigger and, only on its expected status, one immediate bounded JSON readback. The model supplies only jobId, criterionId, and previewBootId; all request controls, expected values, states, and evidence custody are server-bound.",
  inputSchema: z
    .object({
      jobId: z.string().min(1),
      criterionId: z.string().min(1),
      previewBootId: z.string().min(1),
    })
    .strict(),
  async execute(input, ctx) {
    return executeReviewJob({
      eveSessionId: ctx.session.id,
      jobId: input.jobId,
      criterionId: input.criterionId,
      previewBootId: input.previewBootId,
    });
  },
});
