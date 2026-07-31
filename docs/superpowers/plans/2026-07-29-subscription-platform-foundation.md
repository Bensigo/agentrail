# Subscription Platform Foundation (Slices 0–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the platform foundation of the subscription pivot — counting prerequisites, the `billing_accounts`/`seats` schema, and the AI policy layer wired into model selection — per `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` (§9 slices 0–2).

**Architecture:** Three stacked PRs. Slice 0 makes per-person counting possible at the channel-dispatch seam (back-stamp `channel_inbox.workspace_id`, indexes, group-vs-DM hoist). Slice 1 puts `billing_accounts` above workspaces with a trial-account backfill. Slice 2 builds `AiPolicy` resolution (plan constants + resolver-hydrated economics) and threads a profile-entitlement filter into the existing #1338 selector — inert while the kill-switch is off.

**Tech Stack:** Next.js console (`apps/console`, vitest, colocated `lib/*.test.ts`), Drizzle + Postgres (`packages/db-postgres`, vitest in `src/__tests__/`, hand-authored idempotent SQL migrations), ClickHouse cost telemetry (read-only here).

## Global Constraints

- **Kill-switch:** every behavioral change is inert unless `BILLING_SUBSCRIPTIONS_ENFORCED=1` (default OFF). Selection, dispatch, and claim behavior must be byte-identical to today when the flag is off.
- **Migration slots are pre-assigned: slice 0 = `0061`, slice 1 = `0062`.** `origin/main` tail is `0058`; open PR #1503 owns `0059`/`0060`. If a conflicting slot appears on main before merge, renumber file + `meta/_journal.json` entry together (migrations absent from the journal are silently skipped — house rule).
- **Branch stack:** `feat/sub-s0-counting-prereqs` (base `origin/main`) → `feat/sub-s1-billing-schema` (base s0) → `feat/sub-s2-policy-layer` (base s1). PR base = the branch below. Never `--delete-branch` mid-stack.
- **Nothing downstream of `resolvePolicyForWorkspace` may mention plan names** — consumers see `AiPolicy` only (spec §1 Principles).
- **Fail open:** billing/telemetry errors must never block or change customer-visible behavior; log loudly instead.
- **Launch priors (spec §2/§8, calibrated monthly, do not re-derive):** Starter seats 4 / capacity 350 / AI budget $70 / max task $5. Growth seats 10 / capacity 1,000 / AI budget $150 / max task $8. Trial = Growth values. Enterprise base = Growth values + premium + overrides.
- **House test conventions:** db-postgres query specs mock `db` (never live Postgres); console tests are colocated `apps/console/lib/*.test.ts`; run `pnpm --filter @agentrail/db-postgres test` / `pnpm --filter console test -- <file>`; `pnpm --filter <pkg> typecheck` before every commit.
- **Commit messages:** house format (`feat(db): …`, `feat(console): …`) + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Match neighboring file style literally** — schema files copy the idiom of `packages/db-postgres/src/schema/chat_identities.ts` (doc-comment header, snake_case columns, named constraint objects); migrations copy the provenance-note style of `drizzle/migrations/0043_wallet_engine.sql`.

---

## SLICE 0 — counting prerequisites (branch `feat/sub-s0-counting-prereqs`, PR base `main`)

### Task 1: Migration 0061 — counting indexes

**Files:**
- Modify: `packages/db-postgres/src/schema/chat_identities.ts` (add index on `user_id`)
- Modify: `packages/db-postgres/src/schema/channel_inbox.ts` (add index on `(workspace_id, created_at)`)
- Create: `packages/db-postgres/drizzle/migrations/0061_counting_indexes.sql`
- Modify: `packages/db-postgres/drizzle/migrations/meta/_journal.json` (append idx 61 entry, `tag: "0061_counting_indexes"`)
- Test: `packages/db-postgres/src/__tests__/counting-indexes-schema.test.ts`

**Interfaces:**
- Consumes: existing `chatIdentities`, `channelInbox` table objects.
- Produces: indexes `chat_identities_user_id_idx`, `channel_inbox_workspace_created_idx` (names are load-bearing — Task 2's test and future seat queries assume them).

- [ ] **Step 1: Write the failing schema test**

```ts
// packages/db-postgres/src/__tests__/counting-indexes-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(__dirname, "../../drizzle/migrations/0061_counting_indexes.sql");

describe("0061 counting indexes", () => {
  it("creates both counting indexes idempotently", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS chat_identities_user_id_idx");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS channel_inbox_workspace_created_idx");
  });
  it("is registered in the journal (unjournaled migrations are silently skipped)", () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8")
    );
    expect(journal.entries.some((e: { tag: string }) => e.tag === "0061_counting_indexes")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agentrail/db-postgres test -- counting-indexes` → FAIL (ENOENT on the migration file).

- [ ] **Step 3: Write migration + drizzle index declarations**

```sql
-- 0061_counting_indexes.sql
-- Provenance: hand-authored (subscription platform slice 0 — spec 2026-07-29-subscription-platform-design.md §9).
-- Seat/capacity counting reads. Idempotent by IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS chat_identities_user_id_idx ON chat_identities (user_id);
CREATE INDEX IF NOT EXISTS channel_inbox_workspace_created_idx ON channel_inbox (workspace_id, created_at);
```

In each schema file, add the matching `index("…").on(…)` entry to the table's constraint callback (copy the exact callback style already present in that file), and append the journal entry `{ "idx": 61, "version": "7", "when": <epoch-ms>, "tag": "0061_counting_indexes", "breakpoints": true }` (copy `when`-style from entry 60's neighbors).

- [ ] **Step 4: Run to verify pass** — same command → PASS. Also `pnpm --filter @agentrail/db-postgres typecheck`.

- [ ] **Step 5: Commit** — `feat(db): counting indexes for seat/capacity reads (0061)`

### Task 2: Back-stamp resolved workspace onto `channel_inbox`

**Files:**
- Modify: `packages/db-postgres/src/queries/channel_inbox.ts` (new export)
- Modify: `apps/console/lib/channel-dispatch.ts` (call site in `processRow`, immediately after the effective `workspaceId` is assigned at ~`:1251`)
- Test: `packages/db-postgres/src/__tests__/stamp-channel-inbox-workspace.test.ts`

**Interfaces:**
- Produces: `stampChannelInboxWorkspace(db: Db, rowId: string, workspaceId: string): Promise<void>` — UPDATE that only fills NULLs, exported from `queries/channel_inbox.ts`.

- [ ] **Step 1: Failing test** (mock `db` exactly like the existing specs in `src/__tests__/` mock it — read `runner-transition.test.ts` first and copy its mocking approach):

```ts
import { describe, expect, it, vi } from "vitest";
import { stampChannelInboxWorkspace } from "../queries/channel_inbox";

describe("stampChannelInboxWorkspace", () => {
  it("updates workspace_id only where currently NULL (never overwrites a stamp)", async () => {
    const calls: unknown[] = [];
    const db = mockDbCapturing(calls); // copy helper shape from runner-transition.test.ts
    await stampChannelInboxWorkspace(db, "row-1", "ws-1");
    expect(renderedSql(calls)).toMatch(/set\s+"workspace_id"/i);
    expect(renderedSql(calls)).toMatch(/workspace_id.*is null/is); // WHERE guard
  });
});
```

- [ ] **Step 2: Run → FAIL** (export missing).
- [ ] **Step 3: Implement** — drizzle `update(channelInbox).set({ workspaceId }).where(and(eq(channelInbox.id, rowId), isNull(channelInbox.workspaceId)))`, with a doc comment stating: the enqueue anchor is the identity's own binding and is NULL for exactly the strangers seat counting must see (spec §9 slice 0); the stamp is deliberately fill-only. In `processRow`, call it fire-and-forget with `.catch(log)` right after the effective `workspaceId` is known (only when non-null) — a stamp failure must never fail the turn.
- [ ] **Step 4: Run → PASS**; `pnpm --filter @agentrail/db-postgres typecheck && pnpm --filter console typecheck`.
- [ ] **Step 5: Commit** — `feat(console): back-stamp resolved workspace onto channel_inbox rows`

### Task 3: Hoist group-vs-DM to a first-class field at the dispatch seam

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts` — `extractPayload` (~`:278-333`) gains `chatType`; `processRow` computes `isGroupConversation` before the gate block
- Test: `apps/console/lib/channel-dispatch-conversation-kind.test.ts` (new; pure-function test — export a helper)

**Interfaces:**
- Produces: `conversationKind(channel, payload): "dm" | "group"` exported from `channel-dispatch.ts` (pure; no I/O). Telegram: `payload.chatType` ∈ `group|supergroup|channel` → `"group"`, `private` or missing → `"dm"`. Slack: `payload.threadTs !== undefined` → `"group"` (mirrors `buildThreadInbound`'s existing `isDM`). Discord: `payload.threadId != null || payload.mentionsBot` → follow `buildThreadInbound`'s existing `isDM` logic *verbatim* — read `:364-391` first and mirror it, do not invent a new rule. Console: always `"dm"`.

- [ ] **Step 1: Failing test** with a case per channel (telegram private/supergroup, slack with/without `threadTs`, discord mirroring `buildThreadInbound`, console) — table-driven `it.each`.
- [ ] **Step 2: Run → FAIL.** `pnpm --filter console test -- conversation-kind`
- [ ] **Step 3: Implement** — one line in `extractPayload` (`chatType: raw.chatType` for telegram; the Telegram door already writes it, `telegram/webhook/route.ts:544`), the exported pure `conversationKind`, and a `const conversationKindForRow = conversationKind(row.channel, payload)` in `processRow` placed just before the engagement block so later slices can read it. Nothing consumes it yet — that is deliberate (slice 5 does).
- [ ] **Step 4: Run → PASS**; console typecheck.
- [ ] **Step 5: Commit** — `feat(console): hoist group-vs-DM to a first-class dispatch field`
- [ ] **Step 6: Push branch, open PR** — title `feat(console): subscription slice 0 — counting prerequisites`, base `main`, body links spec §9 slice 0.

---

## SLICE 1 — billing schema (branch `feat/sub-s1-billing-schema`, PR base `feat/sub-s0-counting-prereqs`)

### Task 4: Schema files — `billing_accounts`, `seats`, `upgrade_prompt_events`, `workspaces.billing_account_id`

**Files:**
- Create: `packages/db-postgres/src/schema/billing_accounts.ts`
- Create: `packages/db-postgres/src/schema/seats.ts`
- Create: `packages/db-postgres/src/schema/upgrade_prompt_events.ts`
- Modify: `packages/db-postgres/src/schema/workspaces.ts` (add nullable `billing_account_id` FK column — nullable in drizzle even though the migration backfills, so old rows in flight never violate)
- Modify: the schema barrel (find the file that re-exports `chat_identities` et al. and add the three new modules)
- Test: `packages/db-postgres/src/__tests__/billing-schema.test.ts`

**Interfaces (produces — later slices import these exact names):**

```ts
export const billingPlanEnum = pgEnum("billing_plan", ["trial", "starter", "growth", "enterprise"]);
export const billingAccounts = pgTable("billing_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: billingPlanEnum("plan").notNull().default("trial"),
  stripeCustomerId: text("stripe_customer_id"),          // null until slice 3
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
  policyOverrides: jsonb("policy_overrides").notNull().default({}),
  createdAt: /* copy timestamp style from chat_identities.ts */,
  updatedAt: /* ditto */,
});

export const seats = pgTable("seats", {
  id: uuid("id").primaryKey().defaultRandom(),
  billingAccountId: uuid("billing_account_id").notNull().references(() => billingAccounts.id, { onDelete: "cascade" }),
  userId: text("user_id"),               // match users.id column type — READ workspaces.ts/chat_identities.ts to confirm text vs uuid and copy it
  chatIdentityId: uuid("chat_identity_id").references(() => chatIdentities.id, { onDelete: "cascade" }),
  claimedVia: text("claimed_via").notNull(),   // 'console' | 'telegram' | 'discord' | 'slack'
  claimedAt: …notNull… ,
  releasedAt: timestamp("released_at", { withTimezone: true }),
}, (t) => [
  check("seats_exactly_one_subject", sql`(user_id IS NOT NULL) <> (chat_identity_id IS NOT NULL)`),
  uniqueIndex("seats_active_user_idx").on(t.billingAccountId, t.userId).where(sql`released_at IS NULL AND user_id IS NOT NULL`),
  uniqueIndex("seats_active_identity_idx").on(t.billingAccountId, t.chatIdentityId).where(sql`released_at IS NULL AND chat_identity_id IS NOT NULL`),
]);

export const upgradePromptEvents = pgTable("upgrade_prompt_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  billingAccountId: uuid("billing_account_id").notNull().references(() => billingAccounts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                 // 'seat_limit' | 'capacity'
  conversationKey: text("conversation_key").notNull(),
  channel: text("channel").notNull(),
  periodKey: text("period_key").notNull(),      // 'YYYY-MM-DD' — the CAS cooldown key (one prompt/conversation/day)
  createdAt: …,
}, (t) => [uniqueIndex("upgrade_prompt_dedup_idx").on(t.billingAccountId, t.kind, t.conversationKey, t.periodKey)]);
```

Every doc-comment header must state the spec section it implements and the append-and-derive rule (seat count = active rows, no mutable counters — spec §3).

- [ ] **Step 1: Failing test** — assert `billingPlanEnum.enumValues` equals the four plans; assert `seats` config carries the CHECK and both partial uniques (introspect the drizzle table config the way `workspace-grant-events-schema.test.ts` does — read it first and copy its introspection style); assert `workspaces` has `billingAccountId`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the three schema files + workspaces column + barrel exports, matching `chat_identities.ts` idiom exactly.
- [ ] **Step 4: Run → PASS**; db typecheck (console typecheck too — workspaces row type widens).
- [ ] **Step 5: Commit** — `feat(db): billing_accounts, seats, upgrade_prompt_events schema`

### Task 5: Migration 0062 — tables + backfill

**Files:**
- Create: `packages/db-postgres/drizzle/migrations/0062_billing_accounts.sql`
- Modify: `packages/db-postgres/drizzle/migrations/meta/_journal.json` (idx 62)
- Test: extend `packages/db-postgres/src/__tests__/billing-schema.test.ts`

- [ ] **Step 1: Failing test additions** — the migration file exists, contains `CREATE TABLE IF NOT EXISTS billing_accounts`, the two partial unique indexes, the backfill `INSERT INTO billing_accounts … SELECT … FROM workspaces`, and the journal has idx 62.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write the migration**, idempotent and in this order (provenance note on top, `0043_wallet_engine.sql` style):

```sql
CREATE TYPE billing_plan AS ENUM ('trial','starter','growth','enterprise');          -- wrap in DO $$ … duplicate_object guard
CREATE TABLE IF NOT EXISTS billing_accounts ( … );                                    -- columns exactly as Task 4
CREATE TABLE IF NOT EXISTS seats ( … );  CREATE TABLE IF NOT EXISTS upgrade_prompt_events ( … );
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_account_id uuid REFERENCES billing_accounts(id);
-- Backfill: one trial account per workspace that has none; trial_ends_at = now() + interval '14 days'.
INSERT INTO billing_accounts (id, name, plan, trial_ends_at)
  SELECT gen_random_uuid(), w.name, 'trial', now() + interval '14 days'
  FROM workspaces w WHERE w.billing_account_id IS NULL;
```

…then stamp `workspaces.billing_account_id` by matching the freshly inserted account per workspace. **The subtle part:** a plain INSERT…SELECT cannot know which new account belongs to which workspace. Use the deterministic pairing pattern:

```sql
WITH created AS (
  INSERT INTO billing_accounts (name, plan, trial_ends_at)
  SELECT w.name, 'trial', now() + interval '14 days'
  FROM workspaces w WHERE w.billing_account_id IS NULL
  RETURNING id, name
)
-- do NOT pair by name (names collide). Instead: loop-free two-step —
```

pair by adding a temporary `seed_workspace_id uuid` column on `billing_accounts`: insert with `SELECT w.id …` into it, `UPDATE workspaces SET billing_account_id = ba.id FROM billing_accounts ba WHERE ba.seed_workspace_id = workspaces.id`, then `ALTER TABLE billing_accounts DROP COLUMN seed_workspace_id`. All steps idempotent (`IF NOT EXISTS` / `WHERE … IS NULL` guards). Do **not** add `SET NOT NULL` — new workspaces get accounts at creation time from slice 3 onward, and the resolver treats a NULL account as trial-policy in the meantime (Task 8).

- [ ] **Step 4: Run → PASS**; typecheck.
- [ ] **Step 5: Verify the migration actually runs** — if a local Postgres is available (`docker ps` will show the dev compose): run `pnpm --filter @agentrail/db-postgres migrate` against it twice (second run proves idempotency) and paste the output into the PR body. If no local Postgres, say so explicitly in the PR body — never claim it ran.
- [ ] **Step 6: Commit** — `feat(db): billing accounts migration + trial backfill (0062)`

### Task 6: Read queries — account for workspace

**Files:**
- Create: `packages/db-postgres/src/queries/billing_accounts.ts`
- Modify: the queries barrel (wherever `queries/chat_identities.ts` is re-exported)
- Test: `packages/db-postgres/src/__tests__/billing-accounts-queries.test.ts`

**Interfaces (produces):**

```ts
export type BillingAccountRow = typeof billingAccounts.$inferSelect;
export function getBillingAccountForWorkspace(db: Db, workspaceId: string): Promise<BillingAccountRow | null>;
export function listAccountWorkspaceIds(db: Db, billingAccountId: string): Promise<string[]>;
export function countActiveSeats(db: Db, billingAccountId: string): Promise<number>;
```

- [ ] **Step 1: Failing tests** (mock `db` per house convention): join through `workspaces.billing_account_id`; `countActiveSeats` filters `released_at IS NULL`; `getBillingAccountForWorkspace` returns null (not throw) for a workspace with no account.
- [ ] **Step 2: Run → FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: PASS + typecheck.**
- [ ] **Step 5: Commit** — `feat(db): billing account read queries`; push branch; open PR `feat(db): subscription slice 1 — billing accounts schema + backfill`, base `feat/sub-s0-counting-prereqs`.

---

## SLICE 2 — policy layer (branch `feat/sub-s2-policy-layer`, PR base `feat/sub-s1-billing-schema`)

### Task 7: `AiPolicy` type + `PLAN_POLICIES` constants

**Files:**
- Create: `apps/console/lib/alignment/quality-profile.ts` — a leaf module: `export type QualityProfile = "economy" | "standard" | "premium";` and nothing else. It lives under `lib/alignment/` so both the policy layer and the candidate registry can import it without the routing code ever importing from `lib/policy/` (import-direction rule, Task 9).
- Create: `apps/console/lib/policy/plan-policies.ts`
- Test: `apps/console/lib/policy/plan-policies.test.ts`

**Interfaces (produces — spec §3 verbatim; downstream tasks import from here):**

```ts
import type { QualityProfile } from "../alignment/quality-profile";
export type BillingPlan = "trial" | "starter" | "growth" | "enterprise";

export type AiPolicy = {
  seatLimit: number;
  monthlyCapacity: number;
  qualityProfiles: { economy: boolean; standard: boolean; premium: boolean };
  routing: {
    defaultProfile: QualityProfile;
    allowEscalation: boolean;
    allowDowngrade: boolean;
  };
  economics: {
    monthlyAiBudgetUsd: number;
    currentSpendUsd: number;      // hydrated by the resolver; 0 in constants
    remainingBudgetUsd: number;   // hydrated by the resolver; = budget in constants
    maxTaskCostUsd: number;
  };
};

export const PLAN_POLICIES: Record<BillingPlan, AiPolicy>;
```

Values (Global Constraints priors): starter `{4, 350, premium:false, defaultProfile:"standard", allowEscalation:false, allowDowngrade:true, budget 70, maxTask 5}`; growth `{10, 1000, premium:true, allowEscalation:true, allowDowngrade:true, budget 150, maxTask 8}`; trial = growth values with `seatLimit 10`; enterprise = growth values (overrides jsonb specializes it per account). Doc comment: *plans define entitlements, never implementation details; nothing below the resolver sees these names.*

- [ ] Steps: failing test (each plan's exact prior values; `premium` false only on starter; constants' `remainingBudgetUsd === monthlyAiBudgetUsd`) → FAIL → implement → PASS → commit `feat(console): AiPolicy type + plan policy constants`.

### Task 8: `resolvePolicyForWorkspace` with hydrated economics

**Files:**
- Create: `apps/console/lib/policy/resolve-policy.ts`
- Test: `apps/console/lib/policy/resolve-policy.test.ts`

**Interfaces:**
- Consumes: `getBillingAccountForWorkspace`, `listAccountWorkspaceIds` (Task 6), `PLAN_POLICIES` (Task 7), and the existing per-workspace cost aggregation used by the digest (`aggregateWorkspaceCosts` — read `apps/console/app/api/v1/workspaces/[workspaceId]/digest/route.ts:64-90` for its exact import path and call shape, and reuse that import).
- Produces:

```ts
export type ResolvedPolicy = { policy: AiPolicy; billingAccountId: string | null; degraded: boolean };
export function resolvePolicyForWorkspace(
  workspaceId: string,
  deps?: {  // injectable for tests, house style
    fetchAccount?: typeof getBillingAccountForWorkspace;
    fetchWorkspaceIds?: typeof listAccountWorkspaceIds;
    fetchMonthSpendUsd?: (workspaceIds: string[]) => Promise<number>;
  }
): Promise<ResolvedPolicy>;
```

Behavior (each its own test): (1) no account → trial policy, `billingAccountId: null`, not degraded; (2) plan constants selected by `account.plan`; (3) enterprise: `policy_overrides` deep-merged over constants **inside this function** — overrides are input, output is flat; (4) economics hydrated: `currentSpendUsd` = calendar-month spend summed across ALL the account's workspaces, `remainingBudgetUsd = max(0, budget − spend)`; (5) spend fetch throws → `degraded: true`, `currentSpendUsd 0`, full remaining, loud `console.error` — never throws (spec §3 fail-open).

- [ ] Steps: 5 failing tests → FAIL → implement → PASS → typecheck → commit `feat(console): resolvePolicyForWorkspace with hydrated economics`.

### Task 9: Profile tags on the candidate registry

**Files:**
- Modify: `apps/console/lib/alignment/candidates.ts` — `ModelSeat` gains `profile: QualityProfile`; every `MODEL_SEATS` entry gets tagged
- Test: extend the existing candidates test file (find `candidates.test.ts` — it already pins CANDIDATES↔MODEL_SEATS integrity; add to it)

**Interfaces:**
- Produces: `ModelSeat.profile`, and `export function slugsForProfiles(slugs: readonly string[], allowed: ReadonlySet<QualityProfile>): string[]` (pure filter, preserves input order).
- Tagging rule (do not invent taxonomy): a seat's existing routing `tier` decides — cheap-tier seats → `"economy"` or `"standard"`, strong-tier → `"standard"` or `"premium"`. Read each seat's cost-per-Mtok in `MODEL_SEATS` and split: cheapest cheap-tier seats = economy, remaining cheap-tier = standard, strong-tier = premium. Put the chosen mapping in the PR body as a table for review — the exact per-model assignment is a reviewable judgment call, the mechanism is not.
- **Import direction guard:** `candidates.ts` must NOT import from `lib/policy/` (routing must not know billing exists). Both sides import `QualityProfile` from the Task 7 leaf module `lib/alignment/quality-profile.ts`. Add a test asserting no file under `lib/alignment/` imports from `lib/policy/` (read each alignment source and assert on its import specifiers).

- [ ] Steps: failing test (every MODEL_SEATS entry has a profile; `slugsForProfiles` filters and preserves order; empty-allowed returns `[]`) → FAIL → implement → PASS → commit `feat(console): quality-profile tags on model seats`.

### Task 10: Task classification → profile

**Files:**
- Create: `apps/console/lib/policy/classify-task.ts`
- Test: `apps/console/lib/policy/classify-task.test.ts`

**Interfaces:**
- Consumes: `TaskType` (from `lib/alignment`), `QualityProfile` (from candidates).
- Produces: `export function classifyTaskProfile(taskType: TaskType): QualityProfile` — v1 static map; every `ALL_TASK_TYPES` member must be mapped (exhaustive `Record<TaskType, QualityProfile>` so a new TaskType is a compile error, not a runtime hole). Mapping: docs/formatting-ish types → economy; reviews/bugfix/everyday → standard; architecture/refactor/debug-hard types → premium. Read `eligibility.ts:71` (`ALL_TASK_TYPES`) for the real list and put the chosen mapping in the PR body table.

- [ ] Steps: failing test (total coverage of ALL_TASK_TYPES via the Record; spot-check the three bands) → FAIL → implement → PASS → commit `feat(console): task-type → quality-profile classification`.

### Task 11: Entitlement filter in `selectExecuteModel` + admission wiring, behind the kill-switch

**Files:**
- Modify: `apps/console/lib/alignment/eligibility.ts` — `eligibleModelsForTaskType(taskType, allowedProfiles?: ReadonlySet<QualityProfile>)`
- Modify: `apps/console/lib/alignment/selector.ts` — `SelectExecuteModelOptions` gains `allowedProfiles?: ReadonlySet<QualityProfile>`; `selectExecuteModel` passes it through at `:232`
- Modify: `apps/console/lib/alignment-brief.ts` — the admission call site: resolve policy, compute allowed profiles, pass them (flag-gated)
- Create: `apps/console/lib/policy/feature-flags.ts` — `subscriptionsEnforced(): boolean` reading `BILLING_SUBSCRIPTIONS_ENFORCED === "1"`
- Test: extend `selector`'s existing test file + `apps/console/lib/policy/entitlement-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10 exports.
- Produces: profile-filtered selection. Semantics (each a test):
  1. `allowedProfiles` undefined → behavior byte-identical to today (flag off ⇒ callers pass undefined).
  2. Filter applied → pool = `slugsForProfiles(eligible, allowed)`; selection/exploration run unchanged inside the filtered pool.
  3. **Fail-open:** if the filtered pool is empty, fall back to the unfiltered eligible list and `console.error` (an entitlement bug must never brick selection).
  4. Escalation shaping at the call site: allowed = profiles entitled by `policy.qualityProfiles`, intersected with `{≤ classifyTaskProfile(taskType)}` band logic: classified profile and below when `allowDowngrade`, plus above-default only when `allowEscalation`. Compute this in a pure exported helper `allowedProfilesFor(policy: AiPolicy, classified: QualityProfile): ReadonlySet<QualityProfile>` in `lib/policy/` so it is unit-testable (starter+premium-classified → `{economy, standard}`; growth+premium-classified → `{economy, standard, premium}`; growth+economy-classified+allowEscalation → no premium).
  5. `profile_downgraded` telemetry: when the classified profile is not in the entitled set, log a structured line (`console.warn` with `{ workspaceId, taskType, classified, served }`) — the spec's measurement tag; ClickHouse wiring comes with slice 5's gates, do not build it here.
- Call-site rule: only `alignment-brief.ts` (admission) passes `allowedProfiles`, and only when `subscriptionsEnforced()`; every other `selectExecuteModel` caller is untouched.

- [ ] Steps: failing tests (the 5 semantics above; reuse the selector test file's existing fetchStats mocking) → FAIL → implement → PASS → `pnpm --filter console test` (full suite — selector is load-bearing) → typecheck → commit `feat(console): profile entitlement filter in model selection (flag-gated)`; push; open PR `feat(console): subscription slice 2 — AI policy layer`, base `feat/sub-s1-billing-schema`.

---

## Roadmap after this plan (each gets its own plan doc, written once the foundation is merged)

- **Slice 3** — Stripe subscriptions (Products/Prices, `mode: "subscription"`, webhook events, portal, Plan & billing page).
- **Slice 4** — seat claim/merge/release + `/connect` collapse + members surface.
- **Slice 5** — the four enforcement gates + prompts + cooldown + Discord/Telegram delivery fixes.
- **Slice 6** — console swap (plan card, all-time strip, sidebar demotion, approval copy).
- **Slice 7** — marketing rewrite + copy retirement + live-gate flip.

## Coordinator execution notes (subagent-driven)

- One Sonnet subagent per task, fresh context each; the coordinator reviews the diff after every task, runs the verification commands independently, and rejects on: placeholder tests, style drift from neighboring files, scope creep beyond the task's Files list, or any behavior change while the flag is off.
- Subagents work in the shared implementation worktree; the coordinator owns branch creation, commits of record, pushes, and PRs.
- Migration-slot check before slice-1 push: re-run `git ls-tree origin/main --name-only packages/db-postgres/drizzle/migrations/ | tail` — if 0061/0062 are taken, renumber file + journal together.
