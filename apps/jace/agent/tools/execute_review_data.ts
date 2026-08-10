// Root-only deterministic data verification. The model supplies only opaque
// ids; Console owns the exact-head target, immutable descriptor, and receipt.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { createReviewDataExecuteFn } from "../lib/review_data_executor.mjs";

const executeReviewData = createReviewDataExecuteFn();
export default defineTool({
  description:
    "Execute one persisted planned data criterion as a fixed same-origin GET against the isolated exact-head preview. The model supplies only jobId, criterionId, and previewBootId; the server resolves the URL, JSON pointers, expected values, result state, and evidence custody. A degraded result is not criterion proof; use the preview tool's attested outcome.",
  inputSchema: z
    .object({
      jobId: z.string().min(1),
      criterionId: z.string().min(1),
      previewBootId: z.string().min(1),
    })
    .strict(),
  async execute(input, ctx) {
    return executeReviewData({
      eveSessionId: ctx.session.id,
      jobId: input.jobId,
      criterionId: input.criterionId,
      previewBootId: input.previewBootId,
    });
  },
});
