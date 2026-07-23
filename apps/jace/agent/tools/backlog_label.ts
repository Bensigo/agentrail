// backlog_label — a GATED backlog-grooming write (issue #1291, epic #1257):
// add or remove labels on ONE existing open GitHub issue during triage. One of
// Jace's human-gated mutating tools alongside create_issue / create_workspace /
// create_repo / update_issue / create_goal / post_pr_review (see
// apps/jace/test/no-second-write-path.test.mjs for the enumerated set).
//
// Human-gated via consoleGatedApproval — the SAME gate class as every other
// mutating tool: every invocation records an approval request with the console,
// which renders the exact issue + labels in-chat with an Approve/Deny keyboard,
// and this only runs once that request comes back approved. On deny/timeout,
// execute() never runs and nothing is written. There is no silent write path.
//
// NOT the run-failure "triage" (FAILURE DIAGNOSIS). This is BACKLOG GROOMING.
//
// Root resolves `eveSessionId` from `ctx.session.id` directly — a ROOT tool, so
// ctx.session.id already IS the top-level session the jace_sessions ledger
// anchors (same as create_repo.ts / post_pr_review.ts). The apply itself goes
// over HTTP to the console (no child_process), which holds the workspace's
// GitHub token — same shape as post_pr_review/create_repo.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { consoleGatedApproval } from "../lib/console_gated_approval.core.mjs";
import { runBacklogMutation } from "../lib/backlog_mutation.core.mjs";

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
    "Add or remove labels on ONE existing open GitHub issue during backlog " +
    "grooming. Always human-approved before it runs: the member sees the exact " +
    "repo, issue number, action, and labels and must approve before anything " +
    "is written. Use only for a labeling change the member asked for or " +
    "explicitly approved while triaging — never relabel issues on your own. " +
    "Removing a label the issue doesn't carry is a no-op, not an error. " +
    "Returns a structured result you can relay; on failure it never partially " +
    "wrote.",
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    repo: z.string().min(1).describe("The issue's repo, as owner/name."),
    issueNumber: z.number().int().positive().describe("The issue number."),
    action: z
      .enum(["add", "remove"])
      .describe("Whether to add the labels to, or remove them from, the issue."),
    labels: z
      .array(z.string().min(1))
      .min(1)
      .describe("The label names to add or remove."),
  }),
  async execute(input, ctx) {
    return runBacklogMutation({
      eveSessionId: ctx.session.id,
      action: input.action === "add" ? "add_labels" : "remove_labels",
      repo: input.repo,
      issueNumber: input.issueNumber,
      labels: input.labels,
      env: process.env,
      transport: realTransport,
    });
  },
});
