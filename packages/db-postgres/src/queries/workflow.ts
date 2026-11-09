import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export type WorkflowPhase = "planning" | "implementing" | "testing" | "reviewing" | "blocked" | "needs_review";
export interface WorkflowStart {
  taskKey: string; title: string; agent: string; repositoryId: string; branch: string;
}
export interface WorkflowUpdate {
  eventKey: string; expectedRevision: number; phase: WorkflowPhase; summary: string;
  checkReservation?: { name: string };
  prUrl?: string; check?: { name: string; passed: boolean; exitCode: number; outputSha256: string; commitSha: string; dirty: boolean };
}
export class WorkflowConflict extends Error {}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");

export async function listWorkflowTasks(workspaceId: string) {
  return db.execute(sql`SELECT t.*, r.name AS repository_name, r.url AS repository_url FROM workflow_tasks t
    JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
    WHERE t.workspace_id = ${workspaceId} ORDER BY t.updated_at DESC, t.id LIMIT 100`);
}

export async function readWorkflowTask(workspaceId: string, taskId: string) {
  return db.transaction(async tx => {
    // A single transaction snapshot keeps revision and event history consistent.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const tasks = await tx.execute(sql`SELECT t.*, r.name AS repository_name, r.url AS repository_url FROM workflow_tasks t
      JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
      WHERE t.workspace_id = ${workspaceId} AND t.id = ${taskId}`);
    if (!tasks[0]) return null;
    const events = await tx.execute(sql`SELECT revision, event_key, kind, payload, created_at FROM workflow_events
      WHERE workspace_id = ${workspaceId} AND task_id = ${taskId} ORDER BY revision DESC LIMIT 100`);
    return { task: tasks[0], events, historyBound: 100 };
  });
}

export async function startWorkflowTask(workspaceId: string, input: WorkflowStart, actorId: string) {
  const digest = hash(input);
  return db.transaction(async tx => {
    const repos = await tx.execute(sql`SELECT id FROM repositories WHERE id = ${input.repositoryId} AND workspace_id = ${workspaceId}`);
    if (!repos[0]) throw new WorkflowConflict("Repository is not connected to this workspace");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":workflow:" + input.taskKey}, 0))`);
    const existing = await tx.execute(sql`SELECT * FROM workflow_tasks WHERE workspace_id = ${workspaceId} AND task_key = ${input.taskKey}`);
    if (existing[0]) {
      if (existing[0].request_hash !== digest) throw new WorkflowConflict("taskKey was already used for different work");
      return existing[0];
    }
    const id = randomUUID();
    const tasks = await tx.execute(sql`INSERT INTO workflow_tasks
      (id, workspace_id, repository_id, task_key, title, agent, branch, request_hash)
      VALUES (${id}, ${workspaceId}, ${input.repositoryId}, ${input.taskKey}, ${input.title}, ${input.agent}, ${input.branch}, ${digest}) RETURNING *`);
    await tx.execute(sql`INSERT INTO workflow_events (workspace_id, task_id, revision, event_key, kind, request_hash, payload)
      VALUES (${workspaceId}, ${id}, 0, 'start', 'agent_report', ${digest}, ${JSON.stringify({ ...input, actorId })}::jsonb)`);
    return tasks[0];
  });
}

export async function updateWorkflowTask(workspaceId: string, taskId: string, input: WorkflowUpdate | { eventKey: string; expectedRevision: number; decision: "complete" | "reopen" | "release_check" }, human = false, actorId = "") {
  const digest = hash({ input, human, actorId });
  return db.transaction(async tx => {
    const tasks = await tx.execute(sql`SELECT * FROM workflow_tasks WHERE workspace_id = ${workspaceId} AND id = ${taskId} FOR UPDATE`);
    const task = tasks[0];
    if (!task) return null;
    const previous = await tx.execute(sql`SELECT request_hash FROM workflow_events WHERE workspace_id = ${workspaceId} AND task_id = ${taskId} AND event_key = ${input.eventKey}`);
    if (previous[0]) {
      if (previous[0].request_hash !== digest) throw new WorkflowConflict("eventKey was already used for a different event");
      return { task, replayed: true };
    }
    if (task.revision !== input.expectedRevision) throw new WorkflowConflict("Task changed; read the current revision before updating");
    const activeCheck = task.active_check_key as string | null;
    const releaseCheck = human && "decision" in input && input.decision === "release_check";
    const finishingCheck = !("decision" in input) && input.check && activeCheck &&
      input.eventKey === `check:${createHash("sha256").update(activeCheck).digest("hex")}:finish` &&
      input.check.name === task.active_check_name && task.active_check_actor === actorId;
    if (activeCheck && !finishingCheck && !releaseCheck) throw new WorkflowConflict("A configured check is still running or held; inspect its result before advancing");
    if (!("decision" in input) && input.check && !finishingCheck) throw new WorkflowConflict("Check result has no matching active reservation");
    if (releaseCheck && (!activeCheck || new Date(String(task.active_check_deadline)).getTime() > Date.now())) throw new WorkflowConflict("Check execution budget has not expired");
    let phase: string;
    if ("decision" in input) {
      if (!human) throw new WorkflowConflict("A human Console decision is required");
      if (input.decision === "complete" && task.phase !== "needs_review") throw new WorkflowConflict("Task is not waiting for human review");
      if (input.decision === "reopen" && task.phase !== "closed") throw new WorkflowConflict("Only a closed task can be reopened");
      phase = input.decision === "complete" ? "closed" : input.decision === "release_check" ? "blocked" : "planning";
    } else {
      if (task.phase === "closed") throw new WorkflowConflict("A human must reopen this task");
      phase = input.phase;
      if (input.prUrl) {
        const repos = await tx.execute(sql`SELECT url FROM repositories WHERE id = ${task.repository_id} AND workspace_id = ${workspaceId}`);
        const repo = String(repos[0]?.url ?? "").replace(/\.git$/, "").replace(/\/$/, "");
        const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*$/.exec(input.prUrl);
        if (!match || repo.toLowerCase() !== `https://github.com/${match[1]}`.toLowerCase()) throw new WorkflowConflict("PR must belong to this task's connected GitHub repository");
      }
    }
    const reservation = !("decision" in input) ? input.checkReservation : undefined;
    if (reservation && ("decision" in input || input.phase !== "testing" || activeCheck || input.check)) throw new WorkflowConflict("Invalid check reservation");
    const nextCheckKey = reservation ? input.eventKey : finishingCheck || releaseCheck ? null : activeCheck;
    const nextCheckActor = reservation ? actorId : finishingCheck || releaseCheck ? null : task.active_check_actor;
    const nextCheckName = reservation ? reservation.name : finishingCheck || releaseCheck ? null : task.active_check_name;
    const nextDeadline = reservation ? new Date(Date.now() + 130000).toISOString() : finishingCheck || releaseCheck ? null : task.active_check_deadline;
    const revision = Number(task.revision) + 1;
    await tx.execute(sql`INSERT INTO workflow_events (workspace_id, task_id, revision, event_key, kind, request_hash, payload)
      VALUES (${workspaceId}, ${taskId}, ${revision}, ${input.eventKey}, ${human ? "human_decision" : "agent_report"}, ${digest}, ${JSON.stringify({ ...input, actorId })}::jsonb)`);
    const prUrl = "prUrl" in input && input.prUrl ? input.prUrl : task.pr_url;
    const summary = "summary" in input ? input.summary : `Human decision: ${input.decision}`;
    const updated = await tx.execute(sql`UPDATE workflow_tasks SET phase = ${phase}, revision = ${revision}, summary = ${summary}, pr_url = ${prUrl}, active_check_key = ${nextCheckKey}, active_check_name = ${nextCheckName}, active_check_actor = ${nextCheckActor}, active_check_deadline = ${nextDeadline}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${taskId} RETURNING *`);
    return { task: updated[0], replayed: false };
  });
}
