import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  RELEASE_CHECK_NAME,
  releaseUrlValid,
  reworkDelivery,
  startDelivery,
  type DeliveryCheckpoint,
  type DeliveryStart,
  type DeliveryState,
} from "./workflow-delivery.js";

export type WorkflowPhase =
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "blocked"
  | "needs_review";
export interface WorkflowStart {
  taskKey: string;
  title: string;
  agent: string;
  repositoryId: string;
  branch: string;
  delivery?: DeliveryStart;
}
export interface WorkflowUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface WorkflowContext {
  summary: string;
  sources: string[];
  tokens: number | null;
  windowTokens: number | null;
}
export interface WorkflowUpdate {
  usage?: WorkflowUsage;
  context?: WorkflowContext;
  eventKey: string;
  expectedRevision: number;
  phase: WorkflowPhase;
  summary: string;
  checkpoint?: DeliveryCheckpoint;
  checkReservation?: { name: string };
  prUrl?: string;
  check?: {
    name: string;
    passed: boolean;
    exitCode: number;
    outputSha256: string;
    commitSha: string;
    dirty: boolean;
    releaseUrl?: string;
  };
}
export class WorkflowConflict extends Error {}

function requireRepositoryLink(
  url: string,
  repository: string,
  kind: "pull" | "issues",
) {
  const base = repository
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/[1-9][0-9]*$/.exec(
      url,
    );
  if (
    !match ||
    match[2] !== kind ||
    base !== `https://github.com/${match[1]}`.toLowerCase()
  )
    throw new WorkflowConflict(
      `${kind === "pull" ? "PR" : "Issue"} must belong to this task's connected GitHub repository`,
    );
}

function advanceDelivery(
  state: DeliveryState,
  checkpoint: DeliveryCheckpoint,
  prUrl: unknown,
): { state: DeliveryState; phase: WorkflowPhase } {
  switch (checkpoint.step) {
    case "ready":
      if (state.stage !== "shaping" && state.stage !== "building")
        throw new WorkflowConflict(
          "Return to implementation before changing the plan",
        );
      if (
        state.kind === "feature" &&
        (!checkpoint.planPath || !checkpoint.issueUrl)
      )
        throw new WorkflowConflict(
          "Link a repository plan and GitHub issue before building a feature",
        );
      return {
        state: {
          ...state,
          stage: "building",
          criteria: checkpoint.criteria,
          planPath: checkpoint.planPath ?? state.planPath,
          issueUrl: checkpoint.issueUrl ?? state.issueUrl,
        },
        phase: "implementing",
      };
    case "review":
      if ((state.stage !== "building" && state.stage !== "review") || !prUrl)
        throw new WorkflowConflict(
          "A pull request and implementation are required for review",
        );
      return {
        state: { ...state, stage: "review", reviewHead: checkpoint.headSha },
        phase: state.endpoint === "review" ? "needs_review" : "reviewing",
      };
    case "release":
      if (
        state.endpoint !== "release" ||
        state.stage !== "review" ||
        !state.reviewHead ||
        !prUrl
      )
        throw new WorkflowConflict(
          "Record the reviewed PR head before preparing a release",
        );
      return {
        state: {
          ...state,
          stage: "releasing",
          release: {
            commitSha: checkpoint.commitSha,
            targetUrl: new URL(checkpoint.targetUrl).href,
          },
        },
        phase: "reviewing",
      };
    case "ship":
      if (state.endpoint !== "review")
        throw new WorkflowConflict("This task already targets release");
      return {
        state: { ...state, endpoint: "release" },
        phase:
          state.stage === "review"
            ? "reviewing"
            : state.stage === "shaping"
              ? "planning"
              : "implementing",
      };
    case "follow_up":
      if (state.stage !== "verified")
        throw new WorkflowConflict(
          "Verify the release before recording post-release follow-up",
        );
      return {
        state: {
          ...state,
          followUpIssueUrl: checkpoint.issueUrl ?? state.followUpIssueUrl,
        },
        phase: "needs_review",
      };
    case "rework":
      if (state.stage === "verified")
        throw new WorkflowConflict(
          "Close and reopen the task to start another release",
        );
      return { state: reworkDelivery(state), phase: "implementing" };
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const hash = (input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");

export async function listWorkflowTasks(workspaceId: string) {
  return db.execute(sql`SELECT t.*, r.name AS repository_name, r.url AS repository_url FROM workflow_tasks t
    JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
    WHERE t.workspace_id = ${workspaceId} ORDER BY t.updated_at DESC, t.id LIMIT 100`);
}

export async function readWorkflowTask(workspaceId: string, taskId: string) {
  return db.transaction(async (tx) => {
    // A single transaction snapshot keeps revision and event history consistent.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const tasks =
      await tx.execute(sql`SELECT t.*, r.name AS repository_name, r.url AS repository_url FROM workflow_tasks t
      JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
      WHERE t.workspace_id = ${workspaceId} AND t.id = ${taskId}`);
    if (!tasks[0]) return null;
    const events =
      await tx.execute(sql`SELECT revision, event_key, kind, payload, created_at FROM workflow_events
      WHERE workspace_id = ${workspaceId} AND task_id = ${taskId} ORDER BY revision DESC LIMIT 100`);
    return { task: tasks[0], events, historyBound: 100 };
  });
}

export async function startWorkflowTask(
  workspaceId: string,
  input: WorkflowStart,
  actorId: string,
) {
  const digest = hash(input);
  return db.transaction(async (tx) => {
    const repos = await tx.execute(
      sql`SELECT id, url FROM repositories WHERE id = ${input.repositoryId} AND workspace_id = ${workspaceId}`,
    );
    if (!repos[0])
      throw new WorkflowConflict(
        "Repository is not connected to this workspace",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":workflow:" + input.taskKey}, 0))`,
    );
    const existing = await tx.execute(
      sql`SELECT * FROM workflow_tasks WHERE workspace_id = ${workspaceId} AND task_key = ${input.taskKey}`,
    );
    if (existing[0]) {
      if (existing[0].request_hash !== digest)
        throw new WorkflowConflict(
          "taskKey was already used for different work",
        );
      return existing[0];
    }
    const delivery = input.delivery ? startDelivery(input.delivery) : null;
    const prUrl = input.delivery?.prUrl ?? null;
    if (prUrl) requireRepositoryLink(prUrl, String(repos[0].url), "pull");
    const phase =
      delivery?.stage === "building"
        ? "implementing"
        : delivery?.stage === "review"
          ? "reviewing"
          : "planning";
    const id = randomUUID();
    const tasks = await tx.execute(sql`INSERT INTO workflow_tasks
      (id, workspace_id, repository_id, task_key, title, agent, branch, request_hash, phase, pr_url, delivery)
      VALUES (${id}, ${workspaceId}, ${input.repositoryId}, ${input.taskKey}, ${input.title}, ${input.agent}, ${input.branch}, ${digest}, ${phase}, ${prUrl}, ${delivery ? JSON.stringify(delivery) : null}::jsonb) RETURNING *`);
    await tx.execute(sql`INSERT INTO workflow_events (workspace_id, task_id, revision, event_key, kind, request_hash, payload)
      VALUES (${workspaceId}, ${id}, 0, 'start', 'agent_report', ${digest}, ${JSON.stringify({ ...input, ...(delivery ? { phase } : {}), actorId })}::jsonb)`);
    return tasks[0];
  });
}

export async function updateWorkflowTask(
  workspaceId: string,
  taskId: string,
  input:
    | WorkflowUpdate
    | {
        eventKey: string;
        expectedRevision: number;
        decision: "complete" | "reopen" | "release_check";
      },
  human = false,
  actorId = "",
  releaseVerifier = false,
) {
  const releaseCheckEvent =
    !("decision" in input) &&
    (input.checkReservation?.name === RELEASE_CHECK_NAME ||
      input.check?.name === RELEASE_CHECK_NAME);
  if (releaseCheckEvent !== releaseVerifier)
    throw new WorkflowConflict(
      "Release checks require the dedicated verifier credential",
    );
  const digest = hash({ input, human, actorId });
  return db.transaction(async (tx) => {
    const tasks = await tx.execute(
      sql`SELECT * FROM workflow_tasks WHERE workspace_id = ${workspaceId} AND id = ${taskId} FOR UPDATE`,
    );
    const task = tasks[0];
    if (!task) return null;
    const previous = await tx.execute(
      sql`SELECT request_hash FROM workflow_events WHERE workspace_id = ${workspaceId} AND task_id = ${taskId} AND event_key = ${input.eventKey}`,
    );
    if (previous[0]) {
      if (previous[0].request_hash !== digest)
        throw new WorkflowConflict(
          "eventKey was already used for a different event",
        );
      return { task, replayed: true };
    }
    if (task.revision !== input.expectedRevision)
      throw new WorkflowConflict(
        "Task changed; read the current revision before updating",
      );
    const activeCheck = task.active_check_key as string | null;
    const releaseCheck =
      human && "decision" in input && input.decision === "release_check";
    const finishingCheck =
      !("decision" in input) &&
      input.check &&
      activeCheck &&
      input.eventKey ===
        `check:${createHash("sha256").update(activeCheck).digest("hex")}:finish` &&
      input.check.name === task.active_check_name &&
      task.active_check_actor === actorId;
    if (activeCheck && !finishingCheck && !releaseCheck)
      throw new WorkflowConflict(
        "A configured check is still running or held; inspect its result before advancing",
      );
    if (!("decision" in input) && input.check && !finishingCheck)
      throw new WorkflowConflict(
        "Check result has no matching active reservation",
      );
    if (
      releaseCheck &&
      (!activeCheck ||
        new Date(String(task.active_check_deadline)).getTime() > Date.now())
    )
      throw new WorkflowConflict("Check execution budget has not expired");
    let phase: string;
    let delivery = task.delivery as DeliveryState | null;
    const prUrl = "prUrl" in input && input.prUrl ? input.prUrl : task.pr_url;
    if ("decision" in input) {
      if (!human)
        throw new WorkflowConflict("A human Console decision is required");
      if (input.decision === "complete" && task.phase !== "needs_review")
        throw new WorkflowConflict("Task is not waiting for human review");
      if (
        input.decision === "complete" &&
        delivery &&
        (delivery.endpoint === "release"
          ? delivery.stage !== "verified"
          : delivery.stage !== "review" || !delivery.reviewHead)
      )
        throw new WorkflowConflict(
          "Complete the requested delivery endpoint before closing",
        );
      if (input.decision === "reopen" && task.phase !== "closed")
        throw new WorkflowConflict("Only a closed task can be reopened");
      phase =
        input.decision === "complete"
          ? "closed"
          : input.decision === "release_check"
            ? "blocked"
            : "planning";
      if (input.decision === "reopen" && delivery)
        delivery = reworkDelivery(delivery);
    } else {
      if (task.phase === "closed")
        throw new WorkflowConflict("A human must reopen this task");
      phase = input.phase;
      if (
        delivery?.stage === "verified" &&
        input.checkpoint?.step !== "follow_up"
      )
        throw new WorkflowConflict(
          "Release is verified; close the task in the Console",
        );
      const issueUrl =
        input.checkpoint?.step === "ready" ||
        input.checkpoint?.step === "follow_up"
          ? input.checkpoint.issueUrl
          : undefined;
      if (input.prUrl || issueUrl) {
        const repos = await tx.execute(
          sql`SELECT url FROM repositories WHERE id = ${task.repository_id} AND workspace_id = ${workspaceId}`,
        );
        const repo = String(repos[0]?.url ?? "");
        if (input.prUrl) {
          requireRepositoryLink(input.prUrl, repo, "pull");
          if (delivery?.reviewHead && task.pr_url !== input.prUrl)
            throw new WorkflowConflict(
              "Return to implementation before replacing a reviewed PR",
            );
        }
        if (issueUrl) requireRepositoryLink(issueUrl, repo, "issues");
      }
      if (input.checkpoint) {
        if (!delivery || input.check || input.checkReservation)
          throw new WorkflowConflict(
            "Delivery checkpoints require a delivery task and a separate event",
          );
        const advanced = advanceDelivery(delivery, input.checkpoint, prUrl);
        delivery = advanced.state;
        phase = advanced.phase;
      }
      if (
        input.checkReservation?.name === RELEASE_CHECK_NAME &&
        delivery?.stage !== "releasing"
      )
        throw new WorkflowConflict(
          "Prepare a release before running its verification",
        );
      if (input.check?.name === RELEASE_CHECK_NAME) {
        const check = input.check;
        if (
          delivery?.stage !== "releasing" ||
          check.commitSha !== delivery.release?.commitSha
        )
          throw new WorkflowConflict(
            "Release check must match the prepared release commit",
          );
        if (check.passed) {
          if (
            check.dirty ||
            !releaseUrlValid(check.releaseUrl) ||
            new URL(check.releaseUrl).href !== delivery.release.targetUrl
          )
            throw new WorkflowConflict(
              "Release verification requires a clean commit and the prepared target URL",
            );
          delivery = {
            ...delivery,
            stage: "verified",
            release: {
              commitSha: check.commitSha,
              targetUrl: delivery.release.targetUrl,
              url: check.releaseUrl,
              verifiedAt: new Date().toISOString(),
            },
          };
          phase = "needs_review";
        } else {
          phase = "blocked";
        }
      } else if (input.check?.releaseUrl) {
        throw new WorkflowConflict(
          "Use the configured release verifier to record a release URL",
        );
      }
    }
    const reservation = !("decision" in input)
      ? input.checkReservation
      : undefined;
    if (
      reservation &&
      ("decision" in input ||
        input.phase !== "testing" ||
        activeCheck ||
        input.check)
    )
      throw new WorkflowConflict("Invalid check reservation");
    const nextCheckKey = reservation
      ? input.eventKey
      : finishingCheck || releaseCheck
        ? null
        : activeCheck;
    const nextCheckActor = reservation
      ? actorId
      : finishingCheck || releaseCheck
        ? null
        : task.active_check_actor;
    const nextCheckName = reservation
      ? reservation.name
      : finishingCheck || releaseCheck
        ? null
        : task.active_check_name;
    const nextDeadline = reservation
      ? new Date(Date.now() + 160000).toISOString()
      : finishingCheck || releaseCheck
        ? null
        : task.active_check_deadline;
    const revision = Number(task.revision) + 1;
    await tx.execute(sql`INSERT INTO workflow_events (workspace_id, task_id, revision, event_key, kind, request_hash, payload)
      VALUES (${workspaceId}, ${taskId}, ${revision}, ${input.eventKey}, ${human ? "human_decision" : releaseVerifier ? "release_verifier" : "agent_report"}, ${digest}, ${JSON.stringify({ ...input, ...(!human && delivery ? { phase } : {}), actorId })}::jsonb)`);
    const summary =
      "summary" in input ? input.summary : `Human decision: ${input.decision}`;
    const updated =
      await tx.execute(sql`UPDATE workflow_tasks SET phase = ${phase}, revision = ${revision}, summary = ${summary}, pr_url = ${prUrl}, delivery = ${delivery ? JSON.stringify(delivery) : null}::jsonb, active_check_key = ${nextCheckKey}, active_check_name = ${nextCheckName}, active_check_actor = ${nextCheckActor}, active_check_deadline = ${nextDeadline}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${taskId} RETURNING *`);
    return { task: updated[0], replayed: false };
  });
}

/** Bounded Office cohort; resolve each telemetry snapshot across full task history. */
export async function readWorkflowOffice(workspaceId: string) {
  const rows = await db.execute(sql`WITH recent AS (
    SELECT t.*, r.name AS repository_name FROM workflow_tasks t
    JOIN repositories r ON r.id=t.repository_id AND r.workspace_id=t.workspace_id
    WHERE t.workspace_id=${workspaceId} ORDER BY (t.phase='closed'),t.updated_at DESC,t.id LIMIT 100
  ) SELECT t.id,t.agent,t.title,t.branch,t.phase,t.summary,t.revision,t.repository_name,
      t.updated_at::text AS updated_at,a.created_at::text AS reported_at,a.reported_phase,
      c.payload->'context' AS context,c.created_at::text AS context_at,
      u.payload->'usage' AS usage,u.created_at::text AS usage_at
    FROM recent t
    LEFT JOIN LATERAL (SELECT e.created_at,coalesce(e.payload->>'phase','planning') AS reported_phase FROM workflow_events e
      WHERE e.workspace_id=${workspaceId} AND e.task_id=t.id AND e.kind='agent_report'
        AND NOT (e.payload ? 'check') AND NOT (e.payload ? 'checkReservation')
      ORDER BY e.revision DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT e.payload,e.created_at FROM workflow_events e
      WHERE e.workspace_id=${workspaceId} AND e.task_id=t.id AND e.payload ? 'context'
      ORDER BY e.revision DESC LIMIT 1) c ON true
    LEFT JOIN LATERAL (SELECT e.payload,e.created_at FROM workflow_events e
      WHERE e.workspace_id=${workspaceId} AND e.task_id=t.id AND e.payload ? 'usage'
      ORDER BY e.revision DESC LIMIT 1) u ON true
    ORDER BY (t.phase='closed'),t.updated_at DESC,t.id`);
  const stamp = (value: unknown) =>
    value ? new Date(String(value)).toISOString() : null;
  return {
    tasks: Array.from(rows).map((row) => ({
      ...row,
      updated_at: stamp(row.updated_at),
      reported_at: stamp(row.reported_at),
      context_at: stamp(row.context_at),
      usage_at: stamp(row.usage_at),
    })),
    observedAt: new Date().toISOString(),
    limit: 100,
  };
}
