import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { apiKeys } from "./api_keys.js";

/**
 * Audit trail + cooldown source for the hosted fleet's SELF-HEAL key rotation
 * (fix: the fleet silently stops claiming for a workspace whenever its
 * container restarts — every Railway redeploy, or a bare restart, wipes the
 * on-disk `fleet-credentials.json` store, but the console still reports an
 * active `kind: 'fleet'` key, so the ordinary sync route refuses to mint a
 * replacement — see `fleet_sync.py`'s drift-warning message this feature
 * finally acts on instead of only logging).
 *
 * One row per rotation: `POST /api/v1/fleet/workspace-tokens/self-heal`
 * atomically revokes the workspace's old fleet key (if any) and mints a
 * fresh one whenever a fleet instance reports it holds NO token for a
 * workspace the console believes has one. This table records WHICH fleet
 * process asked (`fleetInstanceId` — a `<hostname>-<uuid12>` identity minted
 * once per process, the SAME shape `fleet_leases.holder` uses) and WHEN, so:
 *
 *  - the route's cooldown guard can refuse a SECOND rotation for the same
 *    workspace inside `FLEET_SELF_HEAL_COOLDOWN_SECONDS` (env-tunable,
 *    default 60s) regardless of which instance asks — this is what stops
 *    two overlapping deploy instances (Railway runs old+new side by side on
 *    every deploy) from ping-ponging revoke/mint against each other;
 *  - an operator can see "who rotated this and when," the same way
 *    `workspace_grant_events` answers "who granted this and when" for
 *    `merge_permission`.
 *
 * `newKeyId` is NOT NULL — a rotation that failed to mint never gets a row
 * (the query only inserts once the fresh key exists, in the same
 * transaction as the revoke). `oldKeyId` is nullable: a workspace with no
 * active fleet key yet (nothing to revoke — e.g. its very first mint routed
 * through self-heal because the ordinary sync hadn't run yet) still gets a
 * fresh key through this same path, and there is nothing to record there.
 * Both key references use RESTRICT (never CASCADE): `api_keys` rows are
 * never deleted in this codebase (only revoked), but an audit trail should
 * not silently lose rows even if that ever changes — same reasoning
 * `workspace_grant_events.grantedByUserId`'s own doc-comment gives.
 */
export const fleetKeyRotations = pgTable(
  "fleet_key_rotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fleetInstanceId: text("fleet_instance_id").notNull(),
    oldKeyId: uuid("old_key_id").references(() => apiKeys.id, {
      onDelete: "restrict",
    }),
    newKeyId: uuid("new_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The cooldown guard's own read: "the most recent rotation for this
    // workspace" — an ORDER BY created_at DESC LIMIT 1 scoped to workspaceId,
    // so this index serves it directly.
    workspaceCreatedIdx: index(
      "fleet_key_rotations_workspace_id_created_at_idx"
    ).on(t.workspaceId, t.createdAt),
  })
);

export type FleetKeyRotationRow = typeof fleetKeyRotations.$inferSelect;
