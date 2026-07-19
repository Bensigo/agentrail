import { eq, and, desc } from "drizzle-orm";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { workspaceGrantEvents } from "../schema/workspace_grant_events.js";
import { users } from "../schema/auth.js";

/**
 * Grantable workspace-trust-setting queries (issue #1278). Today's only
 * setting is `merge_permission` — see `schema/workspace_grant_events.ts`'s
 * doc-comment for the audit table's own rationale.
 *
 * `getMergePermission` is the READ `apps/console/app/api/v1/runner/result/
 * route.ts` calls FRESH at result-time (never cached, never threaded through
 * a WorkItem) so a revoke takes effect on the very next result the console
 * records — no in-flight run can merge on a permission it no longer holds.
 *
 * `setMergePermission` is the console toggle's write path: the column flip
 * and its audit row land in ONE transaction (`db.transaction`), so a failure
 * on either write rolls back both — the audit row is never optional.
 */

export const MERGE_PERMISSION_SETTING = "merge_permission";

/**
 * The workspace's current merge-permission bit. `false` (the column's own
 * default) when the workspace row doesn't resolve — practically unreachable
 * once the caller's own auth has already validated the workspace exists.
 */
export async function getMergePermission(
  workspaceId: string
): Promise<boolean> {
  const [row] = await db
    .select({ mergePermission: workspaces.mergePermission })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.mergePermission ?? false;
}

export interface SetMergePermissionResult {
  mergePermission: boolean;
  grantEventId: string;
}

/**
 * Flip `workspaces.merge_permission` and record who/when in ONE transaction
 * (issue #1278 AC: "audit row records the grant" — not optional). Both
 * writes are inlined against `tx` rather than calling a top-level-`db`
 * helper — matches `createWorkspaceOwnerElect`'s own rationale: an exported
 * helper writing through the top-level `db` handle would silently commit
 * outside this transaction.
 *
 * `grantedByUserId` MUST be server-derived from the caller's own session
 * (never client input) — the caller (the console server action) is the
 * trust boundary here, same contract as every other actor-attributed write
 * in this package.
 */
export async function setMergePermission(input: {
  workspaceId: string;
  granted: boolean;
  grantedByUserId: string;
}): Promise<SetMergePermissionResult> {
  return db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ mergePermission: input.granted, updatedAt: new Date() })
      .where(eq(workspaces.id, input.workspaceId));

    const [event] = await tx
      .insert(workspaceGrantEvents)
      .values({
        workspaceId: input.workspaceId,
        setting: MERGE_PERMISSION_SETTING,
        granted: input.granted,
        grantedByUserId: input.grantedByUserId,
      })
      .returning({ id: workspaceGrantEvents.id });

    return { mergePermission: input.granted, grantEventId: event!.id };
  });
}

export interface LatestGrantEventRow {
  granted: boolean;
  createdAt: Date;
  grantedByName: string | null;
  grantedByEmail: string | null;
}

/**
 * The most recent grant/revoke event for `setting` (default
 * `merge_permission`), joined to the granting user's display name/email —
 * never a raw id (house UI rule: names over ids). `null` when the setting
 * has never been touched (a workspace still sitting on the column default).
 */
export async function latestGrantEvent(
  workspaceId: string,
  setting: string = MERGE_PERMISSION_SETTING
): Promise<LatestGrantEventRow | null> {
  const [row] = await db
    .select({
      granted: workspaceGrantEvents.granted,
      createdAt: workspaceGrantEvents.createdAt,
      grantedByName: users.name,
      grantedByEmail: users.email,
    })
    .from(workspaceGrantEvents)
    .innerJoin(users, eq(users.id, workspaceGrantEvents.grantedByUserId))
    .where(
      and(
        eq(workspaceGrantEvents.workspaceId, workspaceId),
        eq(workspaceGrantEvents.setting, setting)
      )
    )
    .orderBy(desc(workspaceGrantEvents.createdAt))
    .limit(1);
  return row ?? null;
}
