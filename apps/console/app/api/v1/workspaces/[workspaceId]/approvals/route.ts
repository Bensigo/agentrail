/**
 * Human merge-approval surface API (M037, issue #781).
 *
 * GET  — list irreversible actions (pending + approved) for the workspace,
 *        projected from the Audit Event stream (`getWorkspaceAuditEvents` +
 *        `projectApprovals`).
 * POST — approve one irreversible action. Recording the approval emits an
 *        **Audit Event** (AC2) with discriminator `approval_granted`, stored
 *        via the same run-events path the AFK guardrail/approval gate uses —
 *        there is one audit mechanism, not two.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import {
  getWorkspaceAuditEvents,
  insertAfkRunEvents,
} from "@agentrail/db-clickhouse";
import {
  projectApprovals,
  type AuditEventInput,
} from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/approvals/components/approval-helpers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const events = await getWorkspaceAuditEvents(workspaceId);
    const inputs: AuditEventInput[] = events.map((e) => ({
      runId: e.run_id,
      type: e.type,
      actionKind: e.action_kind,
      target: e.target,
      reason: e.reason,
      approvedBy: e.approved_by,
      ts: e.ts,
    }));
    return NextResponse.json({ items: projectApprovals(inputs) });
  } catch (err) {
    console.error("[approvals] failed to project approvals:", err);
    return NextResponse.json(
      { error: "Failed to load pending approvals" },
      { status: 500 }
    );
  }
}

interface ApproveBody {
  runId?: string;
  kind?: string;
  target?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: ApproveBody;
  try {
    body = (await request.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const runId = body.runId?.trim();
  const kind = body.kind?.trim();
  const target = body.target?.trim();
  if (!runId || !kind || !target) {
    return NextResponse.json(
      { error: "runId, kind, and target are required" },
      { status: 400 }
    );
  }

  // The approver is the logged-in console user (Audit Event records WHO).
  const approvedBy = session.user.email ?? session.user.id;
  const seq = Date.now();
  const ts = new Date(seq).toISOString();

  // Same envelope as agentrail/run/approval_gate.build_approval_audit_event —
  // one audit mechanism. event_type is derived from action.type downstream.
  const action = {
    type: "approval_granted",
    action_kind: kind,
    target,
    approved_by: approvedBy,
  };

  try {
    await insertAfkRunEvents([
      {
        workspace_id: workspaceId,
        repository_id: "",
        session_id: runId,
        seq,
        ts,
        kind: "audit",
        action,
        digest: `approval_granted:${kind}:${target}`.slice(0, 64),
      },
    ]);
  } catch (err) {
    console.error("[approvals] failed to record approval audit event:", err);
    return NextResponse.json(
      { error: "Failed to record approval" },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { approved: true, approvedBy, runId, kind, target },
    { status: 201 }
  );
}
