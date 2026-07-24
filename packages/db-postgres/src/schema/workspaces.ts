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
  // Jace goal loop (#1289, PRD docs/prd/jace-goal-loop.md, locked 2026-07-10;
  // spec Goals #6 "Kill switch"). Rollout-safety flag, not a demo gate:
  // default false so the entire loop — goal intake, evaluate-on-outcome,
  // refill — is a strict no-op for every existing AND future workspace
  // until a human explicitly opts a workspace in. Read at the START of
  // every goal-loop entry point (apps/jace's run-outcome evaluate call and
  // the create_goal gated tool's console endpoint) before any goal-table
  // read/write happens, so flipping this off mid-flight halts new activity
  // immediately — no caching, mirrors mergePermission's own fresh-read
  // posture. No UI toggle yet — same "ship the column + enforcement first"
  // posture as hostedExecution/monthlyBudgetUsd above.
  jaceGoalLoop: boolean("jace_goal_loop").notNull().default(false),
  // Prepaid wallet billing (#1290, Wave 5 / epic #1257; design locked
  // 2026-07-22). Rollout-safety flag, not a demo gate: default false so the
  // whole prepaid-wallet engine — the admission balance check at claim time
  // and the completion charge at result time — is a strict no-op for every
  // existing AND future workspace until a human explicitly opts one in. Read
  // FRESH at the start of every wallet entry point (the runner claim +
  // result routes) before any wallet-table read/write happens, so flipping it
  // off mid-flight halts billing immediately — no caching, mirrors
  // jaceGoalLoop/mergePermission's own fresh-read posture. No UI toggle yet —
  // same "ship the column + enforcement first" posture as
  // jaceGoalLoop/hostedExecution/monthlyBudgetUsd above; PR ③ (Stripe
  // checkout + the public pricing page) is what actually funds a wallet and
  // is where a workspace first gets flipped on.
  billingEnabled: boolean("billing_enabled").notNull().default(false),
  // GitHub App installation (spec 2026-07-24-jace-github-app-identity §5).
  // The workspace's bound installation of the Jace GitHub App — the ONLY
  // GitHub credential source after the cutover (getInstallationToken mints
  // short-lived ghs_ tokens from it; the old accounts.access_token path is
  // deleted). Null = GitHub not connected; every GitHub-touching route
  // surfaces a clear "Connect GitHub" error in that case. Account login/type
  // are captured at install-callback time (GET /app/installations/{id}) so
  // create_repo can branch org-vs-personal without a live GitHub call.
  githubInstallationId: text("github_installation_id"),
  githubInstallationAccountLogin: text("github_installation_account_login"),
  githubInstallationAccountType: text("github_installation_account_type"),
  // Single-use install-flow state token (house connect-link pattern —
  // chat_identities.link_token): minted when the owner clicks "Connect
  // GitHub", carried through GitHub's install redirect as ?state=, consumed
  // atomically (UPDATE … RETURNING) at the callback. Deliberately NOT HMAC.
  githubInstallState: text("github_install_state"),
  githubInstallStateExpiresAt: timestamp("github_install_state_expires_at", {
    withTimezone: true,
  }),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
