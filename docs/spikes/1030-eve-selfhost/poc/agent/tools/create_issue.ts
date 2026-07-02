import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * The coordinator's ONLY write path into the AgentRail factory.
 *
 * `approval: always()` is the load-bearing line for spike #1030: every call to
 * this tool is parked on an approval request and cannot run until a human
 * answers. `always()` (from eve/tools/approval) requires a fresh human yes on
 * every invocation — the right posture for a boundary that files real work
 * into the queue.
 *
 * SPIKE FINDING (AC2): the published eve.dev docs show this key as
 * `needsApproval: always()`, but the installed eve@0.19.0 rejects that
 * ("Unknown key 'needsApproval'") — its authored-tool shape names the key
 * `approval`. The helper is the same; only the key differs. This is the
 * docs-vs-installed-beta drift the issue warned about. See findings.md.
 *
 * The execute() here is a stand-in: in production it POSTs the house-format
 * issue to the AgentRail server / GitHub. Kept side-effect-free and portable
 * so the same contract works behind a thin-shell fallback if Eve is rejected.
 */
export default defineTool({
  description:
    "File one house-format issue into the AgentRail factory queue. Human-gated: pauses for approval on every call.",
  inputSchema: z.object({
    title: z.string().min(8).describe("Imperative issue title, e.g. 'Add rate limit to /session'"),
    parent: z.string().describe("Parent epic/issue reference, e.g. '#1024'"),
    body: z
      .string()
      .min(20)
      .describe("House format: Parent / Required context / What to build / AC1.. / Verification"),
    labels: z.array(z.string()).default(["ready-for-agent"]),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    simulated: z.boolean(),
    issue: z.object({
      title: z.string(),
      parent: z.string(),
      labels: z.array(z.string()),
      bodyPreview: z.string(),
    }),
    note: z.string(),
  }),
  // The gate the whole coordinator boundary depends on. In eve@0.19.0 the key
  // is `approval` (NOT `needsApproval` as the current docs show).
  approval: always(),
  async execute({ title, parent, body, labels }) {
    // STAND-IN for the real create-issue call (server API / gh). No live side
    // effect in the spike — we only prove the gate + the shape of the payload.
    return {
      created: true,
      simulated: true,
      issue: { title, parent, labels, bodyPreview: body.slice(0, 120) },
      note: "Spike stub — real impl POSTs to AgentRail server / GitHub after approval.",
    };
  },
});
