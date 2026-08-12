// Draft the contract for the Acceptance Intake already bound to this hosted
// channel session. This is intentionally not an MCP surface: Jace uses it
// while clarifying the original request in its originating conversation.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { draftAcceptanceContractFromBoundIntake } from "../lib/acceptance_intake_draft.core.mjs";

const TIMEOUT_MS = 8000;

async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
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

const criterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  required: z.boolean().default(true),
  userVisible: z.boolean(),
});

const contractSchema = z.object({
  originalRequest: z.string().min(1),
  normalizedRequirements: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(criterionSchema).min(1),
  nonGoals: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  stops: z.array(z.string().min(1)).default([]),
  unresolvedQuestions: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    status: z.enum(["open", "resolved"]),
    resolution: z.string().min(1).optional(),
  })).default([]),
  environment: z.record(z.string(), z.unknown()),
});

export default defineTool({
  description:
    "Draft the canonical Acceptance Contract for the task in this bound hosted-channel conversation. " +
    "First ask only the missing questions needed to state the goal, repository, and observable acceptance criteria. " +
    "Then call this exactly once with the proposed contract. Do not call it for casual chat, unbound sessions, " +
    "or before the repository is known. This creates a draft only: explicitly tell the human it still needs their " +
    "confirmation before Jace compiles a Context Pack, hands work to a builder, reviews a PR, or runs anything. " +
    "The workspace and intake identity are derived from the trusted session, never from tool input. " +
    "Return degraded results honestly and do not claim a contract was created unless this tool returns ok: true.",
  inputSchema: z.object({
    repo: z.string().min(1).describe("Connected repository for this work, as owner/name."),
    contract: contractSchema.describe("The complete proposed Acceptance Contract. Open questions remain explicit and prevent human confirmation."),
  }),
  async execute(input, ctx) {
    return draftAcceptanceContractFromBoundIntake({
      sessionAuth: ctx?.session?.auth,
      repo: input.repo,
      contract: input.contract,
      env: process.env,
      transport: realTransport,
    });
  },
});
