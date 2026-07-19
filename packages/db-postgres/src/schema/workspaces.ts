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
  // Alignment gate (#1274, spec §4.4; owner rule 2026-07-18: "confirming the
  // brief = sanctioning the ceiling"). Default ON per spec: true means every
  // 'issue'-kind queue entry admitted for this workspace holds `parked`
  // ("awaiting alignment") until a human confirms Jace's alignment brief —
  // see `github_intake.ts::enqueueGithubIssue`'s hold. false restores today's
  // byte-identical admit-straight-to-queued behavior (regression-pinned).
  // Never applies to kind='onboard' rows (`enqueueOnboard` never checks this
  // column). No UI toggle yet — same "ship the column + enforcement" posture
  // as `hostedExecution`/`monthlyBudgetUsd` above.
  requireAlignment: boolean("require_alignment").notNull().default(true),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
