# Subscription Slice 6 — Console Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console sells value, plan, and never dollars — behind `BILLING_SUBSCRIPTIONS_ENFORCED`, the digest's cost card becomes the plan card (seats X/Y, capacity as tasks, renewal, upgrade CTA) plus an all-time-shipped strip and the mounted HealthRatesPanel; Costs/Budget/Wallet leave the customer sidebar; the approval message's dollar line becomes a scope line — per spec §7 (`docs/superpowers/specs/2026-07-29-subscription-platform-design.md:207-215`).

**Architecture:** One PR on `feat/sub-s6-console` (base main, slices 0-5 merged). Flag-conditional UI follows the repo's ONE precedent (`layout.tsx:70-83` → `Sidebar` props → splice): **the server computes a boolean/data prop; client components never import the flag module**; an absent prop renders exactly today's UI (flag-off byte-identical, "never flashes in then disappears" — `sidebar.tsx:21-29`). Internal pages (Costs/Budget/Wallet) stay code-live and URL-reachable (spec §8: margin telemetry, staff-console seed) — only their nav entries hide. The landing demo changes unconditionally (marketing mirrors the flag-on product; slice-3 precedent: marketing truth-ups land unconditional).

**Tech Stack:** Next server components + client props, Drizzle/Postgres (`packages/db-postgres`), vitest.

## Global Constraints

- **Customer never sees dollars, model names, or the word "budget"** on any surface this slice touches when the flag is ON. Capacity is presented as tasks, never dollars.
- **Pinned copy (byte-exact):**
  - Plan card title: `Plan` — headline value: the plan label from `planLabel(plan)` (billing-helpers.ts:56).
  - Seats row: `Seats` + `seatsLabel(used, limit)` (existing helper → `3 of 4`).
  - Capacity row: `Capacity` + `` `${used} of ${capacity} tasks this month` ``.
  - Renewal row: plan `trial` → `` `Trial ends ${formatUtcDate(trialEndsAt)}` ``; else `renewalLabel(currentPeriodEnd)` (existing helper → `Renews <date>` / `No active subscription`).
  - CTA: `Upgrade plan` → link `/dashboard/${workspaceId}/billing` (NeedsYouBlock's Link + ArrowUpRight pattern, digest-panel.tsx:109-135).
  - Shipped strip: `` `${n} tasks shipped all-time` `` (n = per-workspace `success` outcomes; NO DOGFOOD_BASELINE — that's landing-only history).
  - Approval scope line: `` `Approving starts ${scope}.` `` where scope ∈ `a small task` | `a medium task` | `a large task`. Console mirror field: `{ label: "Scope", value: "Small task" | "Medium task" | "Large task" }` (replaces `Estimate ~$X.XX`); tolerant brief summary suffix: `` `${title} — small task` `` (lowercase, replaces `— ~$X.XX`).
  - Scope thresholds (single-sourced, one helper): `estimateUsd < 2` → small, `< 6` → medium, else large; `null` estimate → no scope line (mirrors today's null-dollar omission).
- **Flag mechanics:** `subscriptionsEnforced()` (feature-flags.ts:49, env literal `"1"`) is read ONLY in server files (layout.tsx / page.tsx / lib builders that run server-side). Client components receive booleans/data via props with `= false`/`undefined` defaults. Flag-off must be byte-identical everywhere EXCEPT the landing demo (deliberately unconditional, documented above).
- **Fail-open for data:** plan-card/strip data loading wraps in try/catch — any billing read error ⇒ prop `undefined` ⇒ today's cost card renders. Degraded or null billing account ⇒ same. Never let billing reads break the dashboard.
- No migrations. No new API routes (server components read queries directly — billing/page.tsx:32-34 precedent). House conventions: full suites + `tsc --noEmit` before each commit; explicit-path commits with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; db dist rebuild after query changes.

---

### Task 1: Per-workspace all-time outcome counts (db-postgres)

**Files:**
- Modify: `packages/db-postgres/src/queries/run_outcomes.ts` (add `countRunOutcomesForWorkspace`)
- Modify: `packages/db-postgres/src/queries/index.ts` (barrel export next to `countRunOutcomes`, `:2675`)
- Test: extend `packages/db-postgres/src/__tests__/run-outcomes-queries.test.ts` (or the file that tests `countRunOutcomes` — find it; create a describe block if the function is untested)

**Interfaces (produces):**
```ts
export async function countRunOutcomesForWorkspace(workspaceId: string): Promise<RunOutcomeCounts>;
```
Same `RunOutcomeCounts {success, humanReview, failed}` shape as the global `countRunOutcomes` (:98-115); same module-level `db` convention (this module does NOT take a db param — match `getModelOutcomeStats:150`, the in-file filtered template). Implementation: the global query + `.where(eq(runOutcomes.workspaceId, workspaceId))`, all-time (no createdAt predicate) — index-backed by `run_outcomes_workspace_id_idx` (schema :78). Doc-comment: consumed by the digest plan-card strip; all-time by design.

- [ ] TDD (mock db per the module's existing test conventions: filtered WHERE present with bound workspaceId; outcome rows map to the counts shape; zero rows → all-zero counts) → RED → implement → GREEN → full db suite + `pnpm --filter @agentrail/db-postgres build` → commit `feat(db): per-workspace all-time run outcome counts`.

### Task 2: Shared billing period + plan-card data loader

**Files:**
- Create: `apps/console/lib/billing-period.ts` (extract `currentBudgetWindow` from the claim route)
- Modify: `apps/console/app/api/v1/runner/claim/route.ts` (:37-48 — delete the local copy, import from the new lib; behavior identical)
- Create: `apps/console/lib/plan-card-data.ts` (server-side loader)
- Test: `apps/console/lib/plan-card-data.test.ts` (new) + the claim route's existing tests must stay green untouched

**Interfaces (produces):**
```ts
// billing-period.ts — verbatim move of the route's currentBudgetWindow (UTC calendar month, half-open, {period, periodStartIso, periodEndIso}); keep its doc-comment.
export function currentBudgetWindow(now?: Date): { period: string; periodStartIso: string; periodEndIso: string };

// plan-card-data.ts
export type PlanCardData = {
  planLabel: string;          // planLabel(plan) from billing-helpers
  seatsUsed: number;
  seatLimit: number;          // resolved.policy.seatLimit (overrides-aware — NOT seatLimitForPlan)
  capacityUsed: number;       // countAccountRunsStartedInWindow over currentBudgetWindow
  capacityTotal: number;      // resolved.policy.monthlyCapacity
  renewalText: string;        // trial → `Trial ends <date>`; else renewalLabel(currentPeriodEnd)
  shippedAllTime: number;     // countRunOutcomesForWorkspace(workspaceId).success
};
export async function loadPlanCardData(workspaceId: string): Promise<PlanCardData | undefined>;
```
`loadPlanCardData` semantics: `if (!subscriptionsEnforced()) return undefined;` FIRST. Whole body try/catch → `undefined` on any error (log `[plan-card]`). `resolvePolicyForWorkspace(workspaceId, { fetchMonthSpendUsd: async () => 0 })` (zero-spend stub, same doc-comment convention as the three gates); `degraded || !billingAccountId` → `undefined`. Then in parallel (`Promise.all`): `countActiveSeats(db, accountId)`, `countAccountRunsStartedInWindow(db, {billingAccountId, fromIso: periodStartIso, toIso: periodEndIso})`, `countRunOutcomesForWorkspace(workspaceId)`, `getBillingAccountForWorkspace(db, workspaceId)` (for plan/currentPeriodEnd/trialEndsAt). Compose the pinned strings per Global Constraints (import `planLabel`, `renewalLabel`, `formatUtcDate` from billing-helpers — they are pure).

- [ ] TDD plan-card-data (flag off ⇒ undefined, resolver never called; degraded ⇒ undefined; throw ⇒ undefined + log; happy trial ⇒ `Trial ends …`; happy growth ⇒ renewalLabel path; counts wired to the right args) → RED → implement → GREEN.
- [ ] Extract `currentBudgetWindow` (pure move — claim route imports it; run the claim route suite to prove zero drift) → console suite for touched files + `tsc --noEmit` → commit `feat(console): shared billing period + plan-card data loader`.

### Task 3: Digest plan card + shipped strip

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/page.tsx` (server: `const planCard = await loadPlanCardData(workspaceId);` pass as prop — APPEND after existing children; page.test.ts walks `children[0]` so do not insert before PageHeader)
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel.tsx` (accept `planCard?: PlanCardData`; when present render `PlanCardBlock` in the 4th grid slot INSTEAD of the cost card, and the shipped strip; when absent, byte-identical today)
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel-helpers.ts` (+ `capacityText(used, total)` → the pinned capacity string; type re-export)
- Test: extend `digest-panel` tests + `digest-panel-helpers` tests + `page.test.ts`

**Interfaces:**
- Consumes: Task 2's `PlanCardData`/`loadPlanCardData` (type imported into the client file is fine — types are erased; the client file must NOT import `loadPlanCardData` or the flag).
- Produces: `PlanCardBlock({ data }: { data: PlanCardData })` — internal to digest-panel.tsx, built from `DigestCard` (:25-48) with the NeedsYouBlock CTA pattern (:109-135): title `Plan`, headline `data.planLabel` (`font-mono text-3xl font-bold`), rows `Seats — seatsLabel`, `Capacity — capacityText`, `renewalText` (`text-xs text-[var(--gray-09)]`), CTA `Upgrade plan` + ArrowUpRight → `/dashboard/${workspaceId}/billing`. Shipped strip: one muted line under the grid (`{shippedAllTime} tasks shipped all-time`), rendered only with `planCard`.

- [ ] TDD: planCard absent ⇒ cost card renders exactly as today (existing tests keep passing untouched — that IS the assertion); planCard present ⇒ no `Cost this week` title, no `$` anywhere in output, pinned strings present, CTA href correct; helpers pinned. RED → GREEN.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): digest plan card + all-time shipped strip`.

### Task 4: Sidebar demotion (Costs/Budget/Wallet leave the customer sidebar)

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/layout.tsx` (compute `billingSwapEnabled = subscriptionsEnforced()` next to goals/chat flags :70-83; pass to both `Sidebar` render sites :94-95/:104-105)
- Modify: `apps/console/app/components/sidebar.tsx` (new prop `billingSwapEnabled?: boolean = false`; when true, filter ENGINE_ROOM items whose `href` ∈ {`costs`,`budget`,`wallet`} before rendering — follow the CHAT_NAV_ITEM splice comment style :21-46; when false/undefined, untouched)
- Test: extend `apps/console/app/components/sidebar-nav.test.ts` sibling test for sidebar.tsx (or its existing test file — find where sidebar.tsx is tested; create `sidebar.test.tsx` if untested, matching neighboring component-test conventions)

**Constraints:** `sidebar-nav.ts` (the config module) stays UNTOUCHED — its tests pin exact arrays (:56-70, :103-111) and must keep passing as-is. The filter lives in the consumer. `Plan & billing` already sits in SETTINGS_ZONE (:178) — nothing to add. Costs/Budget/Wallet PAGES stay live and URL-reachable (spec §8 — internal telemetry; doc-comment the filter with this). Breadcrumbs (`breadcrumb-label.ts`) keep resolving the hidden routes — verify, don't change.

- [ ] TDD: prop true ⇒ rendered nav lacks costs/budget/wallet links, keeps runs/model-selection/etc.; prop false/absent ⇒ all present (today's snapshot); config arrays untouched (existing sidebar-nav tests green). RED → GREEN.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): costs/budget/wallet leave the customer sidebar behind the flag`.

### Task 5: Approval scope line (three sites)

**Files:**
- Create: `apps/console/lib/approval-scope.ts` (`scopeLabelForEstimate`)
- Modify: `apps/console/lib/approval-message.ts` (:269-270 — flag-gated swap inside `renderAlignmentBrief`)
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/approvals/approvals-helpers.ts` (:101-113 `tolerantBriefSummary`, :142-177 `summarizeAlignmentBrief` — both gain an options param `{ hideDollars?: boolean }`)
- Modify: the approvals page server component (trace `pending-approvals-list.tsx:104`'s parent page.tsx) — compute `hideDollars = subscriptionsEnforced()` server-side, thread as prop into `PendingApprovalsList` → helpers.
- Modify: `apps/console/app/(marketing)/_conversation-demo.tsx` (:133 — unconditional switch to the scope line; keep the drift doc-comment :13-42 accurate by updating it)
- Test: extend `approval-message.test.ts`, `approvals-helpers.test.ts`, `_conversation-demo-data.test.ts` (+ a demo render test if one exists)

**Interfaces (produces):**
```ts
// approval-scope.ts — single source of the thresholds
export type TaskScope = "small" | "medium" | "large";
export function scopeForEstimate(estimateUsd: number): TaskScope; // <2 small, <6 medium, else large
export function scopeSentence(estimateUsd: number): string;       // `Approving starts a ${scope} task.`
export function scopeFieldValue(estimateUsd: number): string;     // `Small task` etc.
```
Behavior:
- `renderAlignmentBrief` (server lib — may read the flag directly, like channel-dispatch): when `subscriptionsEnforced()` and `estimateUsd !== null` → push `scopeSentence(estimateUsd)` instead of the dollar line; flag off → EXACT current dollar line (tests :112/:260 keep passing untouched); null estimate → nothing (both modes).
- `approvals-helpers`: `tolerantBriefSummary(input, opts?)` — `opts.hideDollars` ⇒ `` `${title} — ${scope} task` `` (lowercase) instead of `— ~$X.XX`; `summarizeAlignmentBrief(input, opts?)` — `opts.hideDollars` ⇒ `{ label: "Scope", value: scopeFieldValue(...) }` instead of `{ label: "Estimate", ... }`. No opts ⇒ byte-identical today (existing pins :83-92/:151 pass untouched). Thread `hideDollars` from the server page through `PendingApprovalsList` props (client components never import the flag).
- Landing demo: line becomes `Approving starts {scopeSentence-derived text}` using the SAME helper (import it — it's pure) so the demo mirrors the flag-on product; update the mirror doc-comment; `_conversation-demo-data.test.ts`'s `estimateUsd > 0` pin unaffected.

- [ ] TDD helper (threshold boundaries 1.99/2/5.99/6 pinned) + all three sites (flag/opts on ⇒ scope strings byte-exact, NO `$` in output; off ⇒ current dollar strings byte-exact) → RED → GREEN.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): approval message speaks scope, not dollars, behind the flag`.

### Task 6: Mount HealthRatesPanel

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/page.tsx` (render `<HealthRatesPanel workspaceId={workspaceId} />` as a sibling AFTER `<DigestPanel …>` inside the `gap-6` stack :40-43, gated on the same `planCard !== undefined` server value — the "dashboard says value" swap arrives as one coherent flag-on change)
- Modify: `apps/console/app/(dashboard)/components/data-table.tsx:130` + `error-state.tsx:10` (fix the two stale comments that claim the panel is already mounted)
- Test: extend `page.test.ts` (planCard undefined ⇒ no HealthRatesPanel; present ⇒ mounted after DigestPanel)

- [ ] TDD → RED → implement → GREEN → full console suite + `tsc --noEmit` → commit `feat(console): mount health-rates panel with the plan-card swap`.

---

## Verification & ship

- Full console + db suites, both typechecks, db dist rebuilt.
- Whole-slice adversarial review (fresh reviewer): flag-off byte-identity sweep (every surface except the landing demo), no-dollars audit of all flag-on output, prop-threading (no client file imports the flag), copy pins vs this plan's Global Constraints.
- Browser verify (worktree dev server `console-subimpl-3005` with `BILLING_SUBSCRIPTIONS_ENFORCED=1`, minted session, exact-id fixtures/cleanup): dashboard shows plan card (no cost card), shipped strip, health panel; sidebar lacks Costs/Budget/Wallet; `/costs` still loads by URL. Flag off: cost card + full sidebar restored. Screenshot proof both states.
- PR `feat(console): subscription slice 6 — console swap`, base main: card table (before/after), the sidebar rule (pages stay live), scope-line mapping, demo-unconditional rationale, what slice 7 finishes.
- NOT here: pricing/landing rewrite (slice 7); wallet machinery removal (stays as margin telemetry); digest API route changes.
