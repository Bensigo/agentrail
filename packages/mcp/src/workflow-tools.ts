import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RELEASE_CHECK_NAME, runWorkflowCheck } from "./workflow-check.js";
import { workflowRequest } from "./workflow-client.js";

const phase = z.enum([
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "blocked",
  "needs_review",
]);
const event = {
  taskId: z.string().uuid(),
  eventKey: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
};
const worktree = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    "Path to a registered Git worktree of AGENTRAIL_TARGET. Omit for the configured checkout.",
  );
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const prUrl = z.string().url().max(512);
const checkpoint = z.discriminatedUnion("step", [
  z
    .object({
      step: z.literal("ready"),
      criteria: z.array(z.string().min(1).max(400)).min(1).max(8),
      planPath: z.string().min(1).max(256).optional(),
      issueUrl: z.string().url().max(512).optional(),
    })
    .strict(),
  z.object({ step: z.literal("review"), headSha: commit }).strict(),
  z.object({ step: z.literal("rework") }).strict(),
  z.object({ step: z.literal("ship") }).strict(),
  z
    .object({
      step: z.literal("follow_up"),
      issueUrl: z.string().url().max(512).optional(),
    })
    .strict(),
  z
    .object({
      step: z.literal("release"),
      commitSha: commit,
      targetUrl: z.string().url().max(512),
    })
    .strict(),
]);

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
async function result(action: () => Promise<Record<string, unknown>>) {
  try {
    const data = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Workflow unavailable",
        },
      ],
      isError: true,
    };
  }
}

export function registerWorkflowTools(
  server: McpServer,
  childEnv: () => NodeJS.ProcessEnv,
) {
  server.registerPrompt(
    "agentrail_work",
    {
      description:
        "Carry an idea, fix, issue, or pull request to the user's requested outcome.",
      argsSchema: { request: z.string().min(1).max(3000) },
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use AgentRail for this request:

${request}

Read the repository instructions and use workflow_list or workflow_get to resume existing work before starting a new task. For a new task use workflow_repositories, then workflow_start with delivery.kind and the requested endpoint. Choose review by default and release only when the user asks to ship. Use the intended work branch for the task.

For a feature, clarify decisions that materially change the outcome, write the repository plan and vertical slices, and link the selected GitHub issue and its testable criteria in a ready checkpoint. For a clear fix, start implementation directly. For an existing PR, start with its URL and continue from review.

Use repo-native context, commands, and tests. Use the existing AgentRail runner for queued work when requested. Keep the same workflow task through handoffs. Review actual behavior and record the current PR head. If the head changes, resolve feedback and review that head. Run named checks through workflow_check when configured.

If the user adds release to a task started for review, use the ship checkpoint on the same task. Check that the project has a configured release verifier, then follow the repository's authorized merge and deploy path. Once GitHub reports the reviewed PR merged, record its merge commit and intended deployment URL as the release checkpoint. Run workflow_verify_release from a clean worktree at that commit. If a prerequisite is missing or a product decision blocks progress, record the specific blocker. Use a follow_up checkpoint for release observations and a linked follow-up issue when applicable. Keep the user informed when they need to act or the requested endpoint is reached.`,
          },
        },
      ],
    }),
  );
  server.registerTool(
    "workflow_repositories",
    {
      description:
        "List this credential's connected repositories. Repository identities are workspace-bound.",
      inputSchema: {},
      annotations: READ,
    },
    () => result(() => workflowRequest("repositories")),
  );
  server.registerTool(
    "workflow_list",
    {
      description:
        "List the latest 100 AgentRail tasks shared with the Console. Agent names are reported labels, not authenticated client identities.",
      inputSchema: {},
      annotations: READ,
    },
    () => result(() => workflowRequest("tasks")),
  );
  server.registerTool(
    "workflow_start",
    {
      description:
        "Start an AgentRail task. For a daily workflow, set delivery and choose feature (shape an idea), fix (implement a clear change), or pr (resume an existing PR). Record the user’s requested endpoint. Reuse a stable taskKey for retries. This grants no merge/deploy authority.",
      inputSchema: {
        taskKey: z.string().min(1).max(128),
        title: z.string().min(1).max(300),
        agent: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Your coding-agent label; any MCP-compatible agent is supported.",
          ),
        repositoryId: z.string().uuid(),
        branch: z.string().min(1).max(256),
        delivery: z
          .object({
            kind: z.enum(["feature", "fix", "pr"]),
            endpoint: z.enum(["review", "release"]),
            brief: z.string().min(1).max(3000),
            prUrl: prUrl
              .optional()
              .describe("Required only when picking up an existing PR."),
          })
          .strict()
          .optional(),
      },
      annotations: WRITE,
    },
    (input) => result(() => workflowRequest("tasks", input)),
  );
  server.registerTool(
    "workflow_get",
    {
      description:
        "Read task state, durable delivery checkpoint, revision and latest 100 events. Read before resuming or resolving a write conflict.",
      inputSchema: { taskId: z.string().uuid() },
      annotations: READ,
    },
    ({ taskId }) => result(() => workflowRequest(`tasks/${taskId}`)),
  );
  server.registerTool(
    "workflow_update",
    {
      description:
        "Record progress, a blocker, or a delivery checkpoint. ready links planning and testable criteria, review records the reviewed PR head, rework invalidates review, and release records the observed GitHub merge commit. ship extends a review task to release when the user requests it. Use workflow_verify_release for the live check, then follow_up to link post-release work. Use a stable eventKey per logical write.",
      inputSchema: {
        ...event,
        phase,
        summary: z.string().min(1).max(4000),
        prUrl: prUrl.optional(),
        checkpoint: checkpoint.optional(),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().max(1e12).nullable(),
            outputTokens: z.number().int().nonnegative().max(1e12).nullable(),
            costUsd: z.number().nonnegative().max(1e9).nullable(),
          })
          .strict()
          .optional()
          .describe(
            "Complete cumulative usage snapshot for this task, never an increment. Use null for unknown; never estimate a bill. Omit the entire object to preserve the previous snapshot.",
          ),
        context: z
          .object({
            summary: z.string().min(1).max(1600),
            sources: z.array(z.string().min(1).max(256)).max(12),
            tokens: z.number().int().nonnegative().max(1e12).nullable(),
            windowTokens: z.number().int().positive().max(1e12).nullable(),
          })
          .strict()
          .optional()
          .describe(
            "Complete reported context snapshot: bounded summary and source paths, optional measured token/window counts as null when unknown. Do not share private system prompts or secrets. Omit the entire object to preserve the previous snapshot.",
          ),
      },
      annotations: WRITE,
    },
    ({ taskId, ...input }) =>
      result(() => workflowRequest(`tasks/${taskId}`, input)),
  );
  server.registerTool(
    "workflow_check",
    {
      description:
        "Run one operator-configured named check from .agentrail/config.json workflow.checks in AGENTRAIL_TARGET. The command is an argv array, never supplied by this tool. Reports exit code/output digest to the Console without uploading logs. Read the task first. A check report is not independent Jace proof. Reusing eventKey reads the stored result without executing again.",
      inputSchema: { ...event, check: z.string().min(1).max(100), worktree },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    ({ check, ...input }) =>
      result(() => {
        if (check === RELEASE_CHECK_NAME)
          throw new Error(
            "Use workflow_verify_release for release verification",
          );
        return runWorkflowCheck(input, check, childEnv());
      }),
  );
  server.registerTool(
    "workflow_verify_release",
    {
      description:
        "Verify the requested release. Checks that GitHub merged the reviewed PR at the prepared release commit, then runs the repository's configured workflow.release.verify argv on a clean worktree at that commit. The command must exercise the deployed app and report its observed commit and URL. Use a stable eventKey per attempt.",
      inputSchema: { ...event, worktree },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (input) =>
      result(() => runWorkflowCheck(input, RELEASE_CHECK_NAME, childEnv())),
  );
}
