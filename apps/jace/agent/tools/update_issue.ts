// update_issue — Jace's SECOND write path into the AgentRail factory
// (issue #1345). Edits an EXISTING GitHub issue's title/body in the house
// format by shelling out to the existing `agentrail issue update` CLI
// (connector mode → direct GitHub PATCH). House-format body edits ONLY: no
// label changes, no open/close, no comments — the same narrow scope
// create_issue itself has, just for an edit instead of a create.
//
// It is human-gated via consoleGatedApproval — THE EXACT SAME seam
// create_issue goes through (issue #1273's console-owned approval channel):
// every invocation records an approval request with the console, which
// renders the input in-chat with an Approve/Deny keyboard, and the CLI only
// runs once that request comes back approved. There is deliberately no
// second write path, mirroring create_issue's own doc-comment.
//
// WHY THIS EXISTS: today, denying an alignment brief parks a queue entry
// with a denial reason PERMANENTLY — Jace has create_issue but no way to
// reshape scope and try again. This tool is that missing mechanized path: a
// user says "make it cheaper" in chat, Jace reshapes the AC/whatToBuild and
// calls this tool with the FULL new body (not a diff), a human approves the
// edit, and — best-effort, after the edit lands — the console composes+
// posts a FRESH alignment brief for the queue entry this issue maps to (see
// agent/lib/update_issue.core.mjs::triggerReviseAlignmentBrief). That
// re-brief is its own separate approval; approving THIS tool call only
// approves editing the GitHub issue body, never anything about the queue.

import { defineTool } from "eve/tools";
import { z } from "zod";
// Same gate, same import, as create_issue.ts — see that file's own note on
// why this is `consoleGatedApproval` rather than Eve's stock `always()`.
import { consoleGatedApproval } from "../lib/console_gated_approval.core.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runUpdateIssue } from "../lib/update_issue.core.mjs";

const execFileAsync = promisify(execFile);

export default defineTool({
  description:
    "Edit ONE EXISTING AgentRail issue's title/body in the house format. " +
    "This is Jace's ONLY way to reshape an issue's scope after it was " +
    "created (e.g. a user asks to make a denied alignment brief cheaper or " +
    "narrower) — it is always human-approved before it runs, exactly like " +
    "create_issue. Pass the FULL new parent/requiredContext/whatToBuild/" +
    "acceptanceCriteria/verification, not a diff — this REPLACES the " +
    "issue's body, it does not patch it. Never changes labels, open/closed " +
    "state, or posts a comment. The target repo and GitHub credentials are " +
    "resolved automatically from the workspace's connected GitHub repo, " +
    "same as create_issue. If the workspace hasn't connected a repo yet, " +
    "this returns { connected: false, message } with guidance to relay to " +
    "the user instead of failing.",
  // Always require a human approve/reject before this tool executes.
  approval: (ctx) => consoleGatedApproval(ctx),
  inputSchema: z.object({
    issueNumber: z
      .number()
      .int()
      .positive()
      .describe("The existing issue number to edit."),
    title: z.string().min(1).describe("Concise issue title."),
    parent: z
      .string()
      .default("")
      .describe("Parent epic/milestone this issue belongs to."),
    requiredContext: z
      .string()
      .default("")
      .describe("CONTEXT.md / TASTE.md constraints and prior decisions."),
    whatToBuild: z
      .string()
      .default("")
      .describe("End-to-end vertical slice to build (no file paths)."),
    acceptanceCriteria: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Observable/testable criteria; rendered as numbered `- [ ] ACn:` checkboxes.",
      ),
    verification: z
      .string()
      .default("")
      .describe("How completion is verified (evidence expected)."),
    repo: z
      .string()
      .optional()
      .describe(
        "Target owner/repo. Almost always omit this — it is auto-resolved " +
          "from the workspace's connected GitHub repo. Only set it to " +
          "override that for a workspace with multiple connected repos.",
      ),
  }),
  async execute(input, ctx) {
    return runUpdateIssue({
      execFileFn: execFileAsync,
      env: process.env,
      repo: input.repo,
      issueNumber: input.issueNumber,
      title: input.title,
      parent: input.parent,
      requiredContext: input.requiredContext,
      whatToBuild: input.whatToBuild,
      acceptanceCriteria: input.acceptanceCriteria,
      verification: input.verification,
      // #1345: session context for the best-effort post-edit revise-brief
      // trigger (agent/lib/update_issue.core.mjs::triggerReviseAlignmentBrief).
      // Defensive optional chaining, same posture as create_issue.ts: this
      // must never THROW past execute() on an unexpected ctx shape.
      eveSessionId: ctx?.session?.id,
      turnId: ctx?.session?.turn?.id,
      toolInput: input,
    });
  },
});
