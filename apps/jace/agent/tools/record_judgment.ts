// record_judgment — Jace's chat/grilling learning seam for Arc E.
//
// This tool records only chat-originated judgment events:
//   - rejected_approach: a user explicitly rejected an approach during chat
//     or grilling, with concrete terms Jace should avoid proposing again.
//   - requirement_correction: the user corrected a requirement or constraint
//     Jace had misunderstood.
//
// It is ungated because it writes internal AgentRail learning evidence only;
// it does not create GitHub issues, merge code, deploy, or contact users. The
// console resolves tenant ownership from the root Eve session, validates the
// repo, bounds the payload, and owns actor/source refs. This wrapper resolves
// ctx.session.parent?.rootSessionId ?? ctx.session.id so subagent calls still
// land on the root chat session.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { recordJudgment } from "../lib/record_judgment.core.mjs";

const TIMEOUT_MS = 10_000;

async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

const refsSchema = {
  briefSlug: z.string().optional().describe("Optional brief slug this judgment came from."),
  itemId: z.string().optional().describe("Optional brief item id this judgment corrects."),
  sourceTurnId: z.string().optional().describe("Optional chat turn/message id for provenance."),
  issueNumber: z.number().int().positive().optional().describe("Optional linked GitHub issue number."),
  prNumber: z.number().int().positive().optional().describe("Optional linked GitHub pull request number."),
  headSha: z.string().optional().describe("Optional linked PR head SHA."),
};

export default defineTool({
  description:
    "Record a chat/grilling judgment event so Jace does not repeat a " +
    "rejected approach or stale requirement. Use rejected_approach only when " +
    "the human explicitly rejects an approach; include concrete blockedTerms " +
    "such as 'Redis queue' or 'polling loop'. Use requirement_correction when " +
    "the human corrects what the requirement actually is. This records " +
    "internal learning evidence only; it never creates work and never " +
    "changes GitHub. Never throws: on console/config/network failure it " +
    "returns a degraded result with a rendered explanation to relay plainly.",
  inputSchema: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("rejected_approach"),
      repo: z.string().min(1).describe("Target owner/repo, e.g. Bensigo/agentrail."),
      reason: z.string().min(1).describe("Why this approach was rejected."),
      blockedTerms: z
        .array(z.string().min(1))
        .min(1)
        .describe("Concrete terms or approach labels that should be blocked from future proposals."),
      ...refsSchema,
    }),
    z.object({
      type: z.literal("requirement_correction"),
      repo: z.string().min(1).describe("Target owner/repo, e.g. Bensigo/agentrail."),
      reason: z.string().min(1).describe("What was corrected and why the previous understanding was wrong."),
      correction: z.string().optional().describe("The corrected requirement, if it can be stated compactly."),
      ...refsSchema,
    }),
  ]),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return recordJudgment({
      eveSessionId,
      repo: input.repo,
      type: input.type,
      reason: input.reason,
      blockedTerms: "blockedTerms" in input ? input.blockedTerms : undefined,
      correction: "correction" in input ? input.correction : undefined,
      briefSlug: input.briefSlug,
      itemId: input.itemId,
      sourceTurnId: input.sourceTurnId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      headSha: input.headSha,
      env: process.env,
      transport: realTransport,
    });
  },
});
