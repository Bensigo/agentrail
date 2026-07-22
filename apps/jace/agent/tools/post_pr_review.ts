// post_pr_review — Jace's SIXTH gated write action on the outside world,
// alongside create_issue, create_workspace, create_repo, update_issue, and
// create_goal (see apps/jace/test/no-second-write-path.test.mjs for the
// enumerated set this invariant is checked against). Posts an ADVISORY
// GitHub PR review — a summary plus optional inline line comments — via the
// console (apps/console/app/api/v1/runner/pr-review, POST).
//
// Human-gated via consoleGatedApproval — the SAME gate class as every other
// mutating tool: every invocation records an approval request with the
// console, which renders the input in-chat with an Approve/Deny keyboard,
// and this only runs once that request comes back approved. The owner sees
// the exact summary + comments before anything lands on GitHub.
//
// ADVISORY ONLY, BY CONSTRUCTION: the console endpoint this calls hardcodes
// the GitHub review `event` to "COMMENT" server-side — nothing this tool (or
// the model) sends can make it APPROVE or REQUEST_CHANGES a PR. That is
// enforced at the console, not merely a convention this tool follows.
//
// Root resolves `eveSessionId` from `ctx.session.id` directly — this is a
// ROOT tool, so `ctx.session.id` already IS the top-level session the
// console's jace_sessions ledger anchors (same as create_repo.ts /
// create_goal.ts). Contrast the reviewer subagent's `fetch_pr_diff.ts`,
// which runs inside a declared subagent's own CHILD session and must read
// `ctx.session.parent.rootSessionId` instead — see that file's doc-comment.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { consoleGatedApproval } from "../lib/console_gated_approval.core.mjs";
import { runPostPrReview } from "../lib/post_pr_review.core.mjs";

// Stdlib `fetch` with a timeout — mirrors create_repo.ts's own realTransport
// idiom (an AbortController aborts the in-flight request after TIMEOUT_MS),
// so a hung console can never hang this tool call, and therefore the
// conversation turn, indefinitely.
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
    "Post an ADVISORY code review to an existing GitHub pull request: a " +
    "summary plus optional inline line comments. This can NEVER approve or " +
    "request changes on a PR — the console hardcodes the GitHub review " +
    "event to a plain comment, server-side, regardless of what is passed " +
    "here. Always human-approved before it runs: the owner sees the exact " +
    "summary and comments and must approve before anything is posted. Use " +
    "this only after the `reviewer` subagent has returned findings and the " +
    "owner has explicitly said to go ahead — never post a review the owner " +
    "did not ask for. If GitHub can't attach a comment to the exact line " +
    "given (the line isn't part of the diff), the console folds it into " +
    "the summary instead so the review still lands — check the response's " +
    "foldedComments before assuming every comment landed inline.",
  // Always require a human approve/reject before this tool executes.
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    repo: z.string().min(1).describe("The reviewed repo, as owner/name."),
    prNumber: z.number().int().positive().describe("The pull request number."),
    summary: z
      .string()
      .default("")
      .describe(
        "The review's overall summary comment. May be empty only when at " +
          "least one inline comment is given.",
      ),
    comments: z
      .array(
        z.object({
          path: z.string().min(1).describe("File path the comment attaches to."),
          line: z.number().int().positive().describe("Line number in the new (RIGHT) side of the diff."),
          body: z.string().min(1).describe("The comment text."),
        }),
      )
      .default([])
      .describe("Inline line comments. May be empty only when summary is non-empty."),
  }),
  async execute(input, ctx) {
    return runPostPrReview({
      eveSessionId: ctx.session.id,
      repo: input.repo,
      prNumber: input.prNumber,
      summary: input.summary,
      comments: input.comments,
      env: process.env,
      transport: realTransport,
    });
  },
});
