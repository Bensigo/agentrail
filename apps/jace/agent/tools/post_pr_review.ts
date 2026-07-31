// post_pr_review — posts an ADVISORY GitHub PR review (a summary plus
// optional inline line comments) via the console
// (apps/console/app/api/v1/runner/pr-review, POST).
//
// UNGATED, and the ONE mutating tool here that is (see
// apps/jace/test/no-second-write-path.test.mjs, which enumerates both the
// gated set and this deliberate exception). Handing Jace a PR to review IS
// the instruction to comment on it; a second in-chat approval bought nothing
// and cost everything, because the console only delivers approval prompts on
// Telegram — on Discord and every other channel the request was recorded,
// never shown, and this tool polled until its 30-minute TTL expired.
// (Prod, 2026-07-28: two pending `post_pr_review` approvals on a discord
// session; the review never landed.) See post_pr_review.core.mjs's header for
// the full argument and for what holds the safety line instead.
//
// ADVISORY ONLY, BY CONSTRUCTION: the console endpoint this calls hardcodes
// the GitHub review `event` to "COMMENT" server-side — nothing this tool (or
// the model) sends can make it APPROVE or REQUEST_CHANGES a PR. That is
// enforced at the console, not merely a convention this tool follows. The
// console likewise resolves the workspace from the session and rejects a repo
// that workspace hasn't connected, so an ungated `repo` argument cannot reach
// a repo this conversation doesn't already own.
//
// SEVERITY IS LOAD-BEARING, not decorative: the core posts `blocker` and
// `major` comments and drops `minor`/`nit`, and a comment whose severity is
// missing or unrecognized is dropped too. That filter is what replaced the
// human gate, so it lives in code — never in a prompt.
//
// Root resolves `eveSessionId` from `ctx.session.id` directly — this is a
// ROOT tool, so `ctx.session.id` already IS the top-level session the
// console's jace_sessions ledger anchors (same as create_repo.ts /
// create_goal.ts). Contrast the reviewer subagent's `fetch_pr_diff.ts`,
// which runs inside a declared subagent's own CHILD session and must read
// `ctx.session.parent.rootSessionId` instead — see that file's doc-comment.

import { defineTool } from "eve/tools";
import { z } from "zod";
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
    "here. Call this yourself as soon as the `reviewer` subagent returns " +
    "findings for a PR the owner asked you to review — being handed a PR to " +
    "review IS the go-ahead to comment on it, so do not ask first. Pass " +
    "EVERY finding with its severity: only `blocker` and `major` are " +
    "actually posted, and `minor`/`nit` are dropped for you, so you never " +
    "have to filter them yourself. The response's `droppedComments` says " +
    "how many were withheld — tell the owner that number rather than " +
    "implying the whole review landed. If GitHub can't attach a comment to " +
    "the exact line given (the line isn't part of the diff), the console " +
    "folds it into the summary instead so the review still lands — check " +
    "`foldedComments` before assuming every comment landed inline. Pass the " +
    "reviewer's acCoverage verbatim too — it is rendered into the posted " +
    "summary as a per-AC checklist.",
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
          severity: z
            .enum(["blocker", "major", "minor", "nit"])
            .describe(
              "The reviewer finding's own severity, passed through verbatim. " +
                "Only blocker and major are posted; minor and nit are dropped " +
                "here, so pass every finding rather than pre-filtering.",
            ),
          body: z.string().min(1).describe("The comment text."),
        }),
      )
      .default([])
      .describe(
        "Every inline finding, with its severity. May be empty only when " +
          "summary is non-empty.",
      ),
    acCoverage: z
      .array(
        z.object({
          issueNumber: z
            .number()
            .int()
            .positive()
            .nullable()
            .describe(
              "The linked issue the criterion came from; null when it came " +
                "from the PR description (the reviewer's fallback source).",
            ),
          criterion: z.string().min(1).describe("The AC text, relayed verbatim from the reviewer."),
          status: z
            .enum(["addressed", "not_in_diff", "unclear"])
            .describe("The reviewer's coverage status, relayed verbatim — never re-judged here."),
          evidence: z.string().default("").describe("The reviewer's one-line evidence."),
        }),
      )
      .nullable()
      .default(null)
      .describe(
        "The reviewer's acCoverage, passed through verbatim. Rendered into " +
          "the posted summary as a per-AC checklist (folded to a count line " +
          "if it would overflow the summary cap). Null when the reviewer " +
          "found no usable ACs.",
      ),
  }),
  async execute(input, ctx) {
    return runPostPrReview({
      eveSessionId: ctx.session.id,
      repo: input.repo,
      prNumber: input.prNumber,
      summary: input.summary,
      comments: input.comments,
      acCoverage: input.acCoverage,
      env: process.env,
      transport: realTransport,
    });
  },
});
