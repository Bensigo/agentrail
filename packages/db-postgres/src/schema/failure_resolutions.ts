import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

// User-controlled resolution state for a failure (or a recurring class of
// failures). The failure events themselves live in ClickHouse, which is
// append-only analytics storage — a poor fit for mutable "is this fixed yet?"
// state a person toggles. So resolution lives here, in Postgres, keyed by a
// stable `failure_key`: the failure's fingerprint when present (so marking one
// occurrence fixed resolves the whole recurring class), falling back to the
// event_id for one-off failures with no fingerprint.
export const failureResolutions = pgTable(
  "failure_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** fingerprint || event_id — see module comment. */
    failureKey: text("failure_key").notNull(),
    /** "open" | "fixed" */
    status: text("status").notNull().default("open"),
    /** Optional note the user attached when resolving. */
    note: text("note"),
    resolvedByUserId: text("resolved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceKeyUnique: unique("failure_resolutions_workspace_key_unique").on(
      t.workspaceId,
      t.failureKey
    ),
  })
);

export type FailureResolution = typeof failureResolutions.$inferSelect;
export type NewFailureResolution = typeof failureResolutions.$inferInsert;
