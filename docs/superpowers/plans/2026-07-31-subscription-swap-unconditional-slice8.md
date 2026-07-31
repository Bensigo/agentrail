# Subscription Slice 8 — Display Swap Goes Unconditional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner ruling 2026-07-31 (post-slice-7 feedback): "we still have cost and budget in the console which is redundant based on the subscription flow we are using now; home dashboard showing cost is redundant." The subscription DISPLAY becomes the unconditional default — sidebar demotion, digest plan card, scope-not-dollars chat copy — while the ENFORCEMENT gates (seat/capacity/invite/routing) stay behind `BILLING_SUBSCRIPTIONS_ENFORCED` for the ops flip. This supersedes spec §9's rider 3 clause that the console swap "follows behind the live flag."

**Architecture:** One PR on `feat/sub-s8-swap-unconditional` (base main). Display surfaces lose their flag conditioning; the dollar fallbacks are REMOVED, not preserved — when plan data is unavailable the digest shows a dollar-free empty state, never the legacy cost card (this retires slice 6's documented fail-open-to-cost-card asymmetry). The claim-route budget-exhausted $ notice KEEPS its flag gating (suppressing it before the capacity gate is live would silently block a budget-ceilinged workspace with no message at all — that flip stays coupled to enforcement).

**Tech Stack:** Next server/client components, vitest. No db changes, no migrations.

## Global Constraints

- Customer-facing display shows no dollars, no "budget", no "Cost this week", no model names — now unconditionally. Internal pages (Costs/Budget/Wallet, URL-reachable, spec §8) keep their copy.
- Enforcement unchanged: `subscriptionsEnforced()` still gates the chat seat gate, capacity gate, invite gate, routing entitlement, and the budget-notice suppression. Nothing in this slice touches those call sites.
- The `subscriptionsEnforced()` helper itself stays (enforcement consumers). Display call sites simply stop reading it.
- Fallback rule: missing/degraded plan data ⇒ dollar-free empty state, never the cost card.
- House conventions: full suites + `tsc --noEmit` before each commit; explicit-path commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Console UI swap unconditional (sidebar + digest)

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/layout.tsx` — stop computing/passing `billingSwapEnabled` (the prop dies).
- Modify: `apps/console/app/components/sidebar.tsx` — `filterEngineRoomItems` applies ALWAYS; remove the `billingSwapEnabled` prop from `SidebarProps`; update the filter's doc-comment (unconditional since 2026-07-31 owner ruling; pages stay URL-reachable).
- Modify: `apps/console/lib/plan-card-data.ts` — DELETE the `subscriptionsEnforced()` early return (and its import if now unused); degraded/null-account/error still ⇒ `undefined`; update the doc-comment (the asymmetry note becomes: undefined ⇒ dollar-free empty card, cost card retired).
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel.tsx` — the 4th grid slot: `planCard` present ⇒ `PlanCardBlock` (unchanged); absent ⇒ NEW `PlanCardEmpty` (DigestCard shell, title `Plan`, one muted `text-xs text-[var(--gray-09)]` line: `Plan details are unavailable right now.`) — the `Cost this week` card, `CostBlock`, and its `EmptyState` usage are DELETED from this file. Shipped strip + HealthRatesPanel gating on `planCard` presence stay as-is (they render whenever data exists).
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel-helpers.ts` — remove now-unused cost formatters ONLY if nothing else imports them (grep `formatCostUsd`/`formatTrendPct` first; other importers ⇒ leave).
- Tests: `sidebar.test.tsx` (filter always applied; prop gone), `layout.test.ts` (prop assertions removed/updated), `digest-panel.test.ts` + helpers tests (cost-card tests → empty-state tests; `Cost this week` becomes an absent-pin across BOTH planCard states), `plan-card-data.test.ts` (flag-off case deleted; degraded/error/null cases unchanged), `page.test.ts` (unchanged semantics — health panel still keys on planCard).

- [ ] TDD: update pins first → RED → implement → GREEN. Sweep: `Cost this week` appears NOWHERE in digest-panel.tsx; no `$` in either digest state's output.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): subscription display swap goes unconditional — sidebar + digest`.

### Task 2: Chat copy scope-first unconditional (approval + outcome + approvals page)

**Files:**
- Modify: `apps/console/lib/approval-message.ts` — `renderAlignmentBrief`: the dollar branch DIES; non-null estimate ⇒ `scopeSentence(estimateUsd)` always; remove the `subscriptionsEnforced` import if unused. Update the doc-comment.
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/approvals/page.tsx` — `hideDollars` computed value becomes literal `true` (or drop the prop and make the helpers' hide-dollars path the default — CHOOSE the smaller diff: keep the `opts` param in `approvals-helpers.ts` untouched, pass `hideDollars: true` from the page; one-line comment: unconditional since 2026-07-31).
- Modify: `apps/console/app/api/v1/runner/result/notify.ts` — `buildOutcomeMessage(params, { hideCost: true })` unconditionally; remove the flag import if unused there.
- NOT touched: `outcome-format.ts` (param stays — demo + tests use both shapes), `approvals-helpers.ts` (opts machinery stays), claim-route budget-notice suppression (stays flag-gated — see Architecture), all enforcement gates.
- Tests: `approval-message.test.ts` — the flag-off dollar-line pins are DELETED (the branch no longer exists); scope-sentence + null-estimate pins remain/extend; sweep: no `$` in any rendered brief. Approvals page test — `hideDollars: true` threading. `notify` tests — hideCost always true (flag-off case deleted). Demo tests untouched.

- [ ] TDD → RED → GREEN → full console suite + `tsc --noEmit` → commit `feat(console): approval and outcome copy speak scope unconditionally`.

### Task 3: Docs truth-up (one commit, small)

- Modify: `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §9 rollout block — one appended line: `Owner ruling 2026-07-31: the display swap (slice 6 surfaces + scope copy) ships unconditionally ahead of the flag; BILLING_SUBSCRIPTIONS_ENFORCED continues to gate enforcement only (seats/capacity/invite/routing + budget-notice suppression).`
- [ ] Commit `docs: display swap decoupled from enforcement flag (owner ruling 2026-07-31)`.

---

## Verification & ship
- Full console + db suites, `tsc --noEmit`, `next build`.
- Whole-branch review (single reviewer, all 3 tasks): no-dollars sweep of the digest both states + approval briefs + outcome messages; enforcement call sites untouched (`git diff` shows zero changes in channel-dispatch gate, claim-route gates, invites gate, alignment-brief); sidebar/layout prop fully dead (grep `billingSwapEnabled` = 0 hits).
- Live verify (dev server, NO flag set): home dashboard shows plan card (dev trial data) + strip + health panel, NO cost card; sidebar lacks Costs/Budget/Wallet; /costs still 200 by URL.
- PR `feat(console): subscription display is the default — cost UI retired from customer surfaces`, base main; body records the owner ruling + what stays flagged.
