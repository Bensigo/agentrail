// create_issue — the ONLY path Jace has into the AgentRail factory.
//
// This is Jace's single write action on the outside world: it creates ONE real
// GitHub issue in the AgentRail "house format" by shelling out to the existing
// `agentrail issue create` CLI (connector mode → direct GitHub create). The
// factory then picks the issue up by polling GitHub for the server-applied
// `ready-for-agent` trigger label, with zero Jace-side plumbing.
//
// It is human-gated: `approval: always()` means every invocation pauses for a
// human approve/reject before the CLI runs. There is deliberately no second
// write path.

import { defineTool } from "eve/tools";
import { z } from "zod";
// NOTE (verified against installed eve@0.19.0 type defs):
//  - the tool-authoring helper is `defineTool` from "eve/tools" (there is no
//    top-level `tool` export), and the tool is the file's DEFAULT export — its
//    runtime name is the filename slug (`create_issue`), so no `name` field.
//  - the approval gate key is `approval` (not `needsApproval`); `always()` comes
//    from "eve/tools/approval". #1038's AC3 prose says "needsApproval"; that key
//    does not exist in this Eve version, `approval: always()` is the equivalent.
import { always } from "eve/tools/approval";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCreateIssue } from "../lib/create_issue.core.mjs";

const execFileAsync = promisify(execFile);

export default defineTool({
  description:
    "Create ONE AgentRail issue in the house format. This is the only way " +
    "Jace acts on the outside world; it is always human-approved before it " +
    "runs. The AgentRail factory picks the issue up automatically via the " +
    "server-applied ready-for-agent label.",
  // Always require a human approve/reject before this tool executes.
  approval: always(),
  inputSchema: z.object({
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
      .describe("Target owner/repo; falls back to JACE_TARGET_REPO."),
  }),
  async execute(input) {
    // The trigger label is applied server-side by the CLI; we never pass labels.
    return runCreateIssue({
      execFileFn: execFileAsync,
      env: process.env,
      repo: input.repo,
      title: input.title,
      parent: input.parent,
      requiredContext: input.requiredContext,
      whatToBuild: input.whatToBuild,
      acceptanceCriteria: input.acceptanceCriteria,
      verification: input.verification,
    });
  },
});
