import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./auth.js";

/**
 * Audit trail for grantable workspace-level trust settings (#1278). The
 * first — and today only — setting is `merge_permission`: the toggle that
 * lets a green-gated run merge itself instead of stopping at PR-only. One
 * row per grant/revoke action, append-only (never updated), so "who granted
 * this / when" always has a durable answer beyond the current boolean on
 * `workspaces`. `setting` is a free string rather than an enum so a future
 * grantable permission reuses this same table without a migration; every
 * row written today carries `setting = 'merge_permission'`. Always written
 * in the SAME transaction as the `workspaces` column flip it records
 * (`queries/workspace_grants.ts::setMergePermission`) — the audit row is not
 * optional, so a failure on either write rolls back both.
 */
export const workspaceGrantEvents = pgTable(
  "workspace_grant_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    setting: text("setting").notNull(),
    granted: boolean("granted").notNull(),
    // #1343 minor (a): RESTRICT, not CASCADE — this is an audit trail, so a
    // deleted user must not silently take their grant/revoke history down
    // with them (migration 0039_grant_events_restrict_user_delete). RESTRICT
    // over SET NULL: it preserves full attribution ("who granted this"), not
    // merely the row's existence, and this codebase has no user-deletion
    // flow today (verified: nothing issues a DELETE against `users`) — this
    // FK forecloses a FUTURE deletion feature from silently eating audit
    // history rather than restricting anything in practice right now. A
    // user-deletion feature added later must make an explicit choice for a
    // user with grant history (e.g. reassign/anonymize first) instead of
    // this table quietly losing rows underneath it.
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index(
      "workspace_grant_events_workspace_id_created_at_idx"
    ).on(t.workspaceId, t.createdAt),
  })
);

export type WorkspaceGrantEventRow = typeof workspaceGrantEvents.$inferSelect;
