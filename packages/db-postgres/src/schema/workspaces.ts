import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  baselineWindowDays: integer("baseline_window_days").notNull().default(30),
  // Discord notify connector (M038): the channel webhook a workspace's run
  // completion / escalation notifications post to. Null = Discord not connected.
  discordWebhookUrl: text("discord_webhook_url"),
  // Hosted-fleet eligibility (#1267 PR ①, spec §2 reversal: hosted execution
  // is the product default, self-hosted is the advanced path). true = a
  // candidate for POST /api/v1/fleet/workspace-tokens/sync to mint/keep a
  // `kind: 'fleet'` api_key for; false = self-hosted only — sync revokes any
  // existing fleet key it finds for the workspace. No UI toggle yet; today
  // only a direct row edit (or a future admin surface) flips it to false.
  // Defaults true so every existing AND future workspace is hosted-eligible
  // from day one.
  hostedExecution: boolean("hosted_execution").notNull().default(true),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
