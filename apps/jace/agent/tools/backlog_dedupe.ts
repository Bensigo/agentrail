// backlog_dedupe — a GATED backlog-grooming write (issue #1291, epic #1257):
// close ONE existing open GitHub issue AS A DUPLICATE of a canonical issue,
// posting a comment that links the canonical, during triage. One of Jace's
// human-gated mutating tools (see apps/jace/test/no-second-write-path.test.mjs
// for the enumerated set).
//
// Human-gated via consoleGatedApproval — the SAME gate class as every other
// mutating tool: the member sees the exact duplicate issue, the canonical it
// links to, and any note in-chat and must approve before anything is written.
// On deny/timeout, execute() never runs and nothing is closed. There is no
// silent write path.
//
// NOT the run-failure "triage" (FAILURE DIAGNOSIS). This is BACKLOG GROOMING.
//
// The console posts a "Duplicate of #<canonical>" comment (plus any supplied
// note) first, then closes the duplicate as not_planned — if the comment can't
// be posted, nothing is closed. Root resolves `eveSessionId` from
// `ctx.session.id`; the apply goes over HTTP to the console (no child_process),
// which holds the GitHub token.

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
    "Close ONE existing open GitHub issue AS A DUPLICATE of a canonical issue " +
    "during backlog grooming: it posts a comment linking the canonical " +
    "('Duplicate of #<canonicalIssue>', plus any note) and then closes the " +
    "duplicate as not_planned. Always human-approved before it runs: the member " +
    "sees the exact duplicate, the canonical, and the note and must approve " +
    "before anything is written. Use only for a pair the member confirmed is a " +
    "duplicate — the read tool's likelyDuplicateGroups only SUGGESTS candidates; " +
    "never dedupe on your own. issueNumber (the duplicate being closed) must " +
    "differ from canonicalIssue (the one kept open).",
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    repo: z.string().min(1).describe("The repo of the duplicate issue, as owner/name."),
    issueNumber: z.number().int().positive().describe("The DUPLICATE issue to close."),
    canonicalIssue: z
      .number()
      .int()
      .positive()
      .describe("The canonical issue kept open, linked in the comment."),
    comment: z
      .string()
      .default("")
      .describe("Optional extra note appended after the 'Duplicate of #N' line."),
  }),
  async execute(input, ctx) {
    return runBacklogMutation({
      eveSessionId: ctx.session.id,
      action: "dedupe",
      repo: input.repo,
      issueNumber: input.issueNumber,
      canonicalIssue: input.canonicalIssue,
      comment: input.comment,
      env: process.env,
      transport: realTransport,
    });
  },
});
