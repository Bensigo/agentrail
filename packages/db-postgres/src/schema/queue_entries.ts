import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Where a queue entry was sourced from. Mirrors the Python store's `source`
 * field ('cli' | 'github' | 'linear').
 */
export const queueSourceEnum = pgEnum("queue_source", [
  "cli",
  "github",
  "linear",
]);

/**
 * Durable Issue Queue.
 *
 * Today the console "queue" is just `runs` grouped by branch; there is no
 * durable queue, so close-laptop-and-resume cannot work. This table is the real
 * backbone: every admitted issue (one that passed the input-contract gate) is
 * persisted here carrying the pure state-machine's tier / remaining_budget /
 * state, so it survives a process restart. The Python persistence edge is
 * `agentrail/afk/queue_store.py`; the pure decisions live in
 * `agentrail/afk/queue_state.py`.
 */
export const queueEntries = pgTable("queue_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  source: queueSourceEnum("source").notNull(),
  // GH issue number/url, Linear id, or a cli-local id.
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // queue_state.Tier (0 = CHEAP, 1 = STRONG).
  tier: integer("tier").notNull().default(0),
  remainingBudget: integer("remaining_budget").notNull().default(2),
  // QueueState ('queued'|'parked'|'running') or Terminal
  // ('green'|'escalated-to-human'|'blocked').
  state: text("state").notNull().default("queued"),
  // Issue numbers this entry is blocked by (parked while any is unmet).
  blockedBy: jsonb("blocked_by").$type<number[]>().notNull().default([]),
  // Number of consecutive execution errors. Incremented on each `error` result;
  // reset is not needed — once `escalated-to-human` the entry is terminal.
  // Hard cap of 5: at 5 errors the entry moves to `escalated-to-human`.
  errorAttempts: integer("error_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
