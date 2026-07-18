import {
  pgTable,
  uuid,
  text,
  timestamp,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

// 'self_hosted' — an operator's own runner token, minted via the device flow
// (the only kind that existed before #1267 — every pre-migration row is one of
// these). 'fleet' — minted by the hosted fleet's sync endpoint (POST
// /api/v1/fleet/workspace-tokens/sync) for a `workspaces.hosted_execution =
// true` workspace with no live fleet key yet.
export type ApiKeyKind = "self_hosted" | "fleet";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id"),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    // #1267 PR ①. Every row predating this column is a genuine self-hosted
    // runner token, so the DEFAULT backfills them correctly in place.
    kind: text("kind").notNull().default("self_hosted").$type<ApiKeyKind>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    kindCheck: check(
      "api_keys_kind_check",
      sql`${t.kind} IN ('self_hosted', 'fleet')`
    ),
    // One active (non-revoked) fleet key per workspace (#1267 PR ①) — makes
    // the sync endpoint's mint race-safe: a concurrent second sync's mint for
    // the same workspace hits this constraint instead of creating a second
    // live fleet key for it.
    oneActiveFleetKeyPerWorkspace: uniqueIndex(
      "api_keys_one_active_fleet_key_idx"
    )
      .on(t.workspaceId)
      .where(sql`${t.kind} = 'fleet' AND ${t.revokedAt} IS NULL`),
  })
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
