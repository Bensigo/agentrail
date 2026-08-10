// Root, ungated tool: the claimed headless review job must persist its
// complete verification plan before it asks for any runtime proof.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { normalizeUiSteps, planReviewVerification } from "../lib/plan_review_verification.core.mjs";

const TIMEOUT_MS = 8000;

async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally {
    clearTimeout(timer);
  }
}

const uiText = z.string().max(2_000).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const uiStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), path: uiText }).strict(),
  z.object({ action: z.literal("click"), selector: uiText }).strict(),
  z.object({ action: z.literal("fill"), selector: uiText, value: uiText }).strict(),
  z.object({ action: z.literal("press"), key: z.enum(["Enter", "Tab", "Escape", "Space", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }).strict(),
  z.object({ action: z.literal("expect_text"), text: uiText }).strict(),
  z.object({ action: z.literal("screenshot"), label: uiText }).strict(),
]);
const uiSteps = z.array(uiStep).min(3).max(12).superRefine((value, ctx) => {
  if (!normalizeUiSteps(value)) {
    ctx.addIssue({ code: "custom", message: "uiSteps must be one bounded browser flow" });
  }
});
const plan = z.union([
  z.object({
    criterionId: z.string().min(1),
    modality: z.literal("ui"),
    status: z.literal("planned"),
    flow: z.string().min(1),
    uiSteps,
  }).strict(),
  z.object({
    criterionId: z.string().min(1),
    modality: z.enum(["ui", "api", "job", "data"]),
    status: z.literal("not_testable"),
    notTestableReason: z.string().min(1),
  }).strict(),
]);

export default defineTool({
  description:
    "Record the complete verification plan for the current review job before collecting proof. " +
    "The console binds the plan to the running job's workspace, repository, PR, exact head, and confirmed Acceptance Contract. " +
    "Use every confirmed criterion exactly once. This is ungated because a headless review job cannot wait for a human approval.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    plans: z.array(plan).min(1),
  }),
  async execute(input, ctx) {
    return planReviewVerification({
      eveSessionId: ctx.session.id,
      jobId: input.jobId,
      plans: input.plans,
      env: process.env,
      transport: realTransport,
    });
  },
});
