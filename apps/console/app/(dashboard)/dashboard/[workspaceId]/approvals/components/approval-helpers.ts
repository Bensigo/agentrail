/**
 * Pure projection for the **human merge-approval** surface (M037, issue #781).
 *
 * Irreversible actions (merge / deploy / protected-push) are recorded as
 * **Audit Event**s in the run-events stream (CONTEXT.md Audit Event:
 * "a source-linked event that records ... a sensitive action, policy
 * decision"). Two audit discriminators matter here:
 *
 * - `security_block` with reason `protected_target` — the #773 guardrail
 *   blocked a push to a protected/production target. That is exactly an
 *   irreversible action a human can review and approve.
 * - `approval_granted` — a human approved an irreversible action (emitted by
 *   the approval gate, ``agentrail/run/approval_gate.build_approval_audit_event``).
 *
 * This module projects those events into a list of irreversible actions, each
 * marked pending or approved. The decision logic is pure and unit-testable; the
 * ClickHouse read and the approval write live at the edges (the API routes).
 */

/** One audit event as the projection needs it (subset of run_events). */
export interface AuditEventInput {
  /** The run/session the action belongs to. */
  runId: string;
  /** Audit discriminator: "security_block" | "approval_granted". */
  type: string;
  /** Action kind for approvals; for blocks, derived from the reason. */
  actionKind?: string;
  /** What the action acts on ("main", "prod", "PR #42"). */
  target: string;
  /** Block reason ("protected_target" | "secret_detected"), when present. */
  reason?: string;
  /** Who approved (approval_granted only). */
  approvedBy?: string;
  /** ISO timestamp of the event. */
  ts: string;
}

/** A pending or resolved irreversible action for the approval surface. */
export interface ApprovalItem {
  /** Stable id: runId + ":" + kind + ":" + target. */
  key: string;
  runId: string;
  /** "protected_push" | "merge" | "deploy". */
  kind: string;
  target: string;
  status: "pending" | "approved";
  /** Who approved (approved only). */
  approvedBy?: string;
  /** When the action was first observed (block) or approved. */
  updatedAt: string;
}

/** Map a guardrail block to the irreversible-action kind it represents. */
function blockKind(reason: string | undefined): string {
  // A protected/production target block is a protected-push the approval gate
  // governs; a secret block is not human-approvable (it must be removed), so it
  // is not surfaced as an approvable action.
  return reason === "protected_target" ? "protected_push" : "";
}

function itemKey(runId: string, kind: string, target: string): string {
  return `${runId}:${kind}:${target}`;
}

/**
 * Project audit events into the irreversible-action approval list (pure).
 *
 * An `approval_granted` event resolves the matching pending action (same run,
 * kind, target). Blocks that are not human-approvable (e.g. secret_detected)
 * are excluded. Most-recently-updated first (time is the primary axis,
 * TASTE.md).
 */
export function projectApprovals(events: AuditEventInput[]): ApprovalItem[] {
  const items = new Map<string, ApprovalItem>();

  // First pass: pending actions from guardrail blocks.
  for (const ev of events) {
    if (ev.type !== "security_block") continue;
    const kind = blockKind(ev.reason);
    if (!kind) continue; // not human-approvable (e.g. secret_detected)
    const key = itemKey(ev.runId, kind, ev.target);
    const existing = items.get(key);
    if (!existing || ev.ts > existing.updatedAt) {
      items.set(key, {
        key,
        runId: ev.runId,
        kind,
        target: ev.target,
        status: "pending",
        updatedAt: ev.ts,
      });
    }
  }

  // Second pass: an approval resolves the matching pending action. The approval
  // timestamp is the meaningful "updated" moment, so it always wins.
  for (const ev of events) {
    if (ev.type !== "approval_granted") continue;
    const kind = ev.actionKind ?? "";
    const key = itemKey(ev.runId, kind, ev.target);
    items.set(key, {
      key,
      runId: ev.runId,
      kind,
      target: ev.target,
      status: "approved",
      approvedBy: ev.approvedBy,
      updatedAt: ev.ts,
    });
  }

  return [...items.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1
  );
}

/** Count of still-pending irreversible actions (for the surface header). */
export function pendingCount(items: ApprovalItem[]): number {
  return items.filter((i) => i.status === "pending").length;
}

/** Human-readable label for an action kind, using CONTEXT.md wording. */
export function approvalKindLabel(kind: string): string {
  switch (kind) {
    case "protected_push":
      return "Protected-target push";
    case "merge":
      return "Merge";
    case "deploy":
      return "Deploy";
    default:
      return kind || "Action";
  }
}
