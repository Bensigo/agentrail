// create_goal — Jace's newest GATED write action on the outside world
// (issue #1289), alongside create_issue / create_workspace / create_repo /
// update_issue. Creates a real, durable `goals` row (workspace + repository
// scoped) that the goal loop then pursues: on each terminal run outcome for
// an issue filed toward this goal, Jace evaluates the leash + stuck rule
// and either files the next issue (still through the SAME gated
// create_issue tool — no second write path), declares the goal reached, or
// escalates in-thread (see agent/lib/goal_outcome_dispatch.core.mjs and the
// wiring in agent/channels/run-outcome.ts).
//
// Human-gated via consoleGatedApproval — the SAME gate class as
// create_issue: every invocation records an approval request with the
// console, rendered in-chat with an Approve/Deny keyboard, and this only
// runs once approved. Per the PRD (docs/prd/jace-goal-loop.md, Design #2):
// "a human states every goal; Jace never self-creates one" — this tool
// requiring approval on every call is exactly how that's enforced, not just
// documented.
//
// The model supplies the objective (and, optionally, a non-default leash/
// check threshold) — the human approves the EXACT objective before this
// runs. Everything else (which workspace, which repo) is resolved
// server-side from `ctx.session.id`, never model-supplied — see
// agent/lib/create_goal.core.mjs's module comment.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { consoleGatedApproval } from "../lib/console_gated_approval.core.mjs";
import { runCreateGoal } from "../lib/create_goal.core.mjs";

const TIMEOUT_MS = 8000;

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

export default defineTool({
  description:
    "Create a standing AgentRail GOAL for this conversation's workspace — " +
    "an objective Jace pursues by filing issues (through the same gated " +
    "create_issue tool) until a machine-checkable condition is met or its " +
    "leash trips. Only call this AFTER grilling the objective with the " +
    "user the way you would for an issue: confirm the exact objective " +
    "text, and offer sensible leash defaults (10 issues / $50) unless they " +
    "want different ones — this is human-approved before it runs, same as " +
    "create_issue. v1 only auto-completes a goal via a metric threshold " +
    "(a count of green/successful outcomes); if the user wants a " +
    "command-based check (e.g. 'until coverage hits 80%'), still create " +
    "the goal, but tell them it will need a manual 'mark reached' from the " +
    "console once they judge it done — it will not auto-complete. On " +
    "success returns { goalId, objective, slug, status }. If the workspace " +
    "has no connected GitHub repo yet, returns { connected: false, message } " +
    "— relay that guidance instead of retrying. Any other failure returns " +
    "a short honest message — relay it verbatim.",
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    objective: z
      .string()
      .min(1)
      .max(500)
      .describe("The goal's objective, confirmed with the user before calling."),
    checkThreshold: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The metric threshold (count of green outcomes) that completes this goal. Omit for a command-type goal that needs a manual 'mark reached'.",
      ),
    maxIssues: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Leash: max issues to file before this goal pauses for a human (default 10)."),
    maxSpendUsd: z
      .number()
      .positive()
      .optional()
      .describe("Leash: max USD to spend before this goal pauses for a human (default 50)."),
  }),
  async execute(input, ctx) {
    return runCreateGoal({
      eveSessionId: ctx.session.id,
      objective: input.objective,
      checkThreshold: input.checkThreshold,
      maxIssues: input.maxIssues,
      maxSpendUsd: input.maxSpendUsd,
      env: process.env,
      transport: realTransport,
    });
  },
});
