import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeCheck } from "./check-execution.js";
import { workflowRequest } from "./workflow-client.js";

const phase = z.enum(["planning", "implementing", "testing", "reviewing", "blocked", "needs_review"]);
const event = { taskId: z.string().uuid(), eventKey: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative() };
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, idempotentHint: true, openWorldHint: false } as const;
async function result(action: () => Promise<Record<string, unknown>>) {
  try {
    const data = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Workflow unavailable" }], isError: true };
  }
}

export function registerWorkflowTools(server: McpServer, childEnv: () => NodeJS.ProcessEnv) {
  server.registerTool("workflow_repositories", { description: "List this credential's connected repositories. Repository identities are workspace-bound.", inputSchema: {}, annotations: READ }, () => result(() => workflowRequest("repositories")));
  server.registerTool("workflow_list", { description: "List the latest 100 AgentRail tasks shared with the Console. Agent names are reported labels, not authenticated client identities.", inputSchema: {}, annotations: READ }, () => result(() => workflowRequest("tasks")));
  server.registerTool("workflow_start", {
    description: "Start an AgentRail task for work the user requested. Reuse a stable taskKey for retries. This records workflow state; it does not launch another agent, confirm a Jace Contract, or grant merge/deploy authority.",
    inputSchema: { taskKey: z.string().min(1).max(128), title: z.string().min(1).max(300), agent: z.string().min(1).max(100).describe("Your coding-agent label; any MCP-compatible agent is supported."), repositoryId: z.string().uuid(), branch: z.string().min(1).max(256) }, annotations: WRITE,
  }, input => result(() => workflowRequest("tasks", input)));
  server.registerTool("workflow_get", { description: "Read task state, revision and latest 100 events. Read before resuming or resolving a write conflict.", inputSchema: { taskId: z.string().uuid() }, annotations: READ }, ({ taskId }) => result(() => workflowRequest(`tasks/${taskId}`)));
  server.registerTool("workflow_update", {
    description: "Record bounded progress, a blocker or a needs_review handoff for the current revision. Reports are agent-reported, not verified acceptance evidence. Only a human can close/reopen a task in the Console. Use a unique stable eventKey for each logical write.",
    inputSchema: { ...event, phase, summary: z.string().min(1).max(4000), prUrl: z.string().url().max(512).optional() }, annotations: WRITE,
  }, ({ taskId, ...input }) => result(() => workflowRequest(`tasks/${taskId}`, input)));
  server.registerTool("workflow_check", {
    description: "Run one operator-configured named check from .agentrail/config.json workflow.checks in AGENTRAIL_TARGET. The command is an argv array, never supplied by this tool. Reports exit code/output digest to the Console without uploading logs. Read the task first. A check report is not independent Jace proof. Reusing eventKey reads the stored result without executing again.",
    inputSchema: { ...event, check: z.string().min(1).max(100) }, annotations: { readOnlyHint: false, openWorldHint: false },
  }, ({ taskId, check, ...input }) => result(async () => {
    const current = await workflowRequest(`tasks/${taskId}`);
    const task = current.task as { revision: number; phase: string; repository_url: string; branch: string };
    const target = resolve(process.env.AGENTRAIL_TARGET || process.cwd());
    const localGit = async (args: string[]) => (await promisify(execFile)("git", ["-C", target, ...args], { env: childEnv(), timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const canonicalRepo = (value: string) => value.trim().replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
    const [remote, branch, commitSha, status] = await Promise.all([
      localGit(["remote", "get-url", "origin"]), localGit(["symbolic-ref", "--short", "HEAD"]), localGit(["rev-parse", "HEAD"]), localGit(["status", "--porcelain"]),
    ]);
    if (canonicalRepo(remote) !== canonicalRepo(task.repository_url) || branch !== task.branch) throw new Error("Configured checkout does not match this task's repository and branch");
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("Checkout has no canonical Git commit");
    const config = JSON.parse(await readFile(resolve(target, ".agentrail/config.json"), "utf8"));
    const command = config.workflow?.checks?.[check];
    if (!Array.isArray(command) || command.length === 0 || command.length > 64 || !command.every(arg => typeof arg === "string" && arg.length > 0 && arg.length <= 4096 && !arg.includes("\u0000"))) throw new Error("Check is not configured as an argv array in this project's .agentrail/config.json");
    // Reserve this exact logical check before any subprocess. A retry or
    // competing client never re-executes a possibly completed check.
    const reservation = await workflowRequest(`tasks/${taskId}`, {
      ...input, phase: "testing", summary: `Configured check ${check}: execution reserved; result not recorded yet.`, checkReservation: { name: check },
    });
    if (reservation.replayed) return { ...current, replayed: true, note: "Check was already reserved. Inspect history; do not automatically execute it again." };
    const reserved = reservation.task as { revision: number };
    const execution = await executeCheck(command, target, childEnv());
    let exitCode = execution.exitCode;
    const output = execution.output;
    let dirty = status.length > 0;
    try {
      const after = await Promise.all([localGit(["remote", "get-url", "origin"]), localGit(["symbolic-ref", "--short", "HEAD"]), localGit(["rev-parse", "HEAD"]), localGit(["status", "--porcelain"])]);
      dirty = dirty || after[3].length > 0;
      if (canonicalRepo(after[0]) !== canonicalRepo(task.repository_url) || after[1] !== task.branch || after[2] !== commitSha) exitCode = 1;
    } catch { exitCode = 1; dirty = true; }
    const receipt = { name: check, commitSha, dirty, passed: exitCode === 0, exitCode, outputSha256: createHash("sha256").update(output).digest("hex") };
    const updated = await workflowRequest(`tasks/${taskId}`, { eventKey: `check:${createHash("sha256").update(input.eventKey).digest("hex")}:finish`, expectedRevision: reserved.revision, phase: exitCode === 0 ? "testing" : "blocked", summary: `Configured check ${check}: exit ${exitCode}. Logs remain local.`, check: receipt });
    return { ...updated, check: receipt };
  }));
}
