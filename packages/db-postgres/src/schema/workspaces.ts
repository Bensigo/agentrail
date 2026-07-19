import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
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
  // Monthly spend ceiling (#1269 PR ②a). NULL = uncapped, the default until
  // billing (#1290) sets real values — the per-issue leash + $3 default
  // check-in already guard runaway single-run spend; this is a coarser,
  // workspace-level backstop enforced at claim time (see
  // queries/workspace_budget.ts + apps/console's runner/claim route). No UI
  // to set this yet — a direct row edit only.
  monthlyBudgetUsd: numeric("monthly_budget_usd", {
    precision: 10,
    scale: 2,
    mode: "number",
  }),
  // Set to the "YYYY-MM" period key the moment the ceiling-exhausted chat
  // notice is sent for that period — the atomic compare-and-set dedup gate
  // (markBudgetExhaustedNotified) flips this exactly once per period so two
  // concurrent blocked claims can never both send. NULL = never notified (or
  // only for an earlier period — this column tracks the latest notified
  // period only, not a history).
  budgetExhaustedNotifiedPeriod: text("budget_exhausted_notified_period"),
  // Grantable merge permission (#1278): the trust ceiling between "green gate
  // -> PR opened, Jace waits for you" (default) and "green gate -> merges
  // itself". Default false so every existing AND future workspace starts
  // PR-only — the inverse polarity of hostedExecution above (that one
  // defaults true; this one must default false, since merging is the one
  // action this product never takes without an explicit grant). Read fresh
  // at result-time (apps/console/app/api/v1/runner/result/route.ts) so a
  // revoke is truly immediate — no caching, no WorkItem threading. Every
  // flip is paired with a workspace_grant_events row in the SAME transaction
  // (queries/workspace_grants.ts) so "who granted/when" always has a durable
  // answer, not just this boolean.
  mergePermission: boolean("merge_permission").notNull().default(false),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
