// backlog_close — a GATED backlog-grooming write (issue #1291, epic #1257):
// close ONE existing open GitHub issue during triage, with an optional reason
// comment. One of Jace's human-gated mutating tools (see
// apps/jace/test/no-second-write-path.test.mjs for the enumerated set).
//
// Human-gated via consoleGatedApproval — the SAME gate class as every other
// mutating tool: the member sees the exact issue, the close reason, and any
// comment in-chat and must approve before anything is written. On deny/timeout,
// execute() never runs and nothing is closed. There is no silent write path.
//
// NOT the run-failure "triage" (FAILURE DIAGNOSIS). This is BACKLOG GROOMING.
//
// The console posts the reason comment first (when given), then closes the
// issue with the chosen state_reason — if the comment can't be posted, nothing
// is closed. Root resolves `eveSessionId` from `ctx.session.id`; the apply goes
// over HTTP to the console (no child_process), which holds the GitHub token.

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
    "Close ONE existing open GitHub issue during backlog grooming, with an " +
    "optional reason comment. Always human-approved before it runs: the member " +
    "sees the exact repo, issue number, reason comment, and state_reason and " +
    "must approve before anything is written. Use only for an issue the member " +
    "asked to close or explicitly approved closing while triaging — never close " +
    "issues on your own. Set stateReason to 'completed' for done work or " +
    "'not_planned' for won't-do/stale (default). To close as a DUPLICATE of " +
    "another issue, use backlog_dedupe instead. On failure it reports honestly " +
    "(e.g. if the comment posted but the close failed).",
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    repo: z.string().min(1).describe("The issue's repo, as owner/name."),
    issueNumber: z.number().int().positive().describe("The issue number to close."),
    comment: z
      .string()
      .default("")
      .describe("Optional reason comment posted before the issue is closed."),
    stateReason: z
      .enum(["completed", "not_planned"])
      .default("not_planned")
      .describe("'completed' for finished work, 'not_planned' for won't-do/stale."),
  }),
  async execute(input, ctx) {
    return runBacklogMutation({
      eveSessionId: ctx.session.id,
      action: "close",
      repo: input.repo,
      issueNumber: input.issueNumber,
      comment: input.comment,
      stateReason: input.stateReason,
      env: process.env,
      transport: realTransport,
    });
  },
});
