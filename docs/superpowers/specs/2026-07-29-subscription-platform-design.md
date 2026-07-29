# Subscription platform — billing accounts, seats, and the AI policy layer

- **Date:** 2026-07-29
- **Status:** Draft for review
- **Supersedes:** the prepaid wallet as the *commercial* model (the machinery stays, internal-only), and every "No seats, no subscription" claim on the marketing surface
- **Related:** `docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md` (the dispatch seam this reuses), model-selection learning loop (#1338), `docs/design/landing-content-architecture.md` (to be updated by the marketing slice)

## 1. Decision

AgentRail/Jace moves from usage billing (prepaid wallet, per-task charging at token cost + $0.50 + $1.00, per-workspace budget ceilings) to **company subscriptions**. This is a platform change, not a pricing-page change:

1. **Billing moves above workspaces.** A new `billing_accounts` entity owns the plan, the Stripe subscription, and the seats. Multiple workspaces share one subscription.
2. **Access control becomes per-person.** Seats are the first per-person gate on the chat path. Today anyone who speaks in a pinned group chat gets full workspace tool access (`resolveConversationWorkspace` doc, `packages/db-postgres/src/queries/jace_sessions.ts:315-320`); seats close that hole as a side effect.
3. **Plans define an AI policy, never model names.** The router receives a policy (allowed quality profiles, budgets, allowances) — it never sees "Starter" or "Team", and the pricing page never names an OpenRouter model.
4. **Cost becomes internal.** Customers see delivered value and plan usage. The wallet, budget, and cost_events infrastructure remains as ops telemetry: model spend, margins, routing efficiency.

Timing: the wallet flow is still behind `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` (default OFF — "Preview: not charging real payments yet", `apps/console/app/(marketing)/_pricing-gate.ts:27`). No customer money has flowed. Reversing the commercial model is cheap exactly once, and it is now.

## 2. Commercial packaging

The product is an AI software engineer for engineering teams — not for individual developers. Plans reflect company size:

| Plan | Price | Seats | Included monthly capacity | Reasoning |
|---|---|---|---|---|
| **Starter** | $80/mo | up to 4 | 350 engineering tasks (launch prior) | Standard |
| **Team** | $200/mo | up to 10 | 1,000 engineering tasks (launch prior) | Premium available |
| **Enterprise** | Contact | custom | custom | Custom policies |

- Enterprise adds: custom seat count, SSO, self-hosting, SLA, custom AI policies (model allow-lists, routing), dedicated support. v1 provisioning is manual (see §9); the pricing page ships a contact path only.
- The seat limit is the primary commercial differentiator; reasoning level is the secondary one.
- **An "engineering task"** = one run admitted through the runner claim seam (`apps/console/app/api/v1/runner/claim/route.ts`) — exactly the unit the wallet used to charge. Conversation with Jace is not metered and is presented as unlimited.
- Capacity numbers are **launch priors, not commitments to ourselves**: production cost data is near-zero today (prod Langfuse shows ~$0.22 total model spend over the trailing 30 days), so §8's margin meter calibrates them monthly.
- Marketing sells outcomes, not models (§10). The anchor line: one shipped PR pays for the month.

## 3. Platform architecture

```
Company
  └─ Billing Account        (plan, Stripe subscription, seats, trial)
       └─ Workspaces        (existing; gain billing_account_id)
            └─ Members      (existing workspace_memberships)
                 └─ Channel identities   (existing chat_identities; /connect merges)
```

### New tables

**`billing_accounts`**
- `id`, `name`, `created_at`, `updated_at`
- `plan` enum: `trial | starter | team | enterprise`
- `stripe_customer_id`, `stripe_subscription_id`, `subscription_status` (Stripe-mirrored), `current_period_end`
- `trial_ends_at` (14 days from creation)
- `policy_overrides jsonb` — enterprise-only deltas merged over the plan's code-defined policy; empty for self-serve plans

**`workspaces.billing_account_id`** — FK, not null after backfill. Backfill migration creates one account per existing workspace (`plan = 'trial'`), named after the workspace.

**`seats`**
- `id`, `billing_account_id`, `claimed_at`, `claimed_via` (`console | telegram | discord | slack`), `released_at` nullable
- `user_id` nullable, `chat_identity_id` nullable, CHECK: exactly one of the two is set
- Partial unique indexes: one active (unreleased) seat per `(billing_account_id, user_id)` and per `(billing_account_id, chat_identity_id)`
- Seat count = active rows. No mutable counter — same append-and-derive philosophy as `wallet_transactions` (`packages/db-postgres/src/schema/wallet_transactions.ts:14-38`).

**Capacity counting** is also derived, not stored: count runs per account per calendar month at admission time, via `workspaces.billing_account_id` join. Needs the indexes listed in §9 slice 0.

### The AI policy object

Plans map to policies in code (one constants module, the same pattern as flag columns: fresh read at entry points, no caching — `packages/db-postgres/src/schema/workspaces.ts:82-84`):

```ts
type AiPolicy = {
  seatLimit: number;
  monthlyTaskAllowance: number;
  profiles: Array<"economy" | "standard" | "premium">;
  perTaskLeashDefaultUsd: number;      // feeds the existing budget_leash
  internalCogsAlertUsd: number;        // founder alert line, never customer-facing
};
```

`resolvePolicyForWorkspace(workspaceId)` → account → plan → policy (+ `policy_overrides` merge for enterprise). One resolver, used by every gate in §6. The router and the gates receive an `AiPolicy`; **nothing downstream of the resolver knows plan names.**

## 4. Quality profiles and policy-aware routing

The router's question changes from "what is the best model?" to "what is the best model **this company is entitled to use** for this task?".

**Quality profiles** sit between the policy and model selection:

| Profile | Used for | Plan availability |
|---|---|---|
| **Economy** | formatting, summaries, documentation, lightweight edits | all plans |
| **Standard** | PR reviews, bug fixes, everyday engineering | all plans |
| **Premium** | architecture, large refactors, difficult debugging, deep reasoning | Team, Enterprise |

Flow per task: classify task → profile (from `task_type` plus the scope signals the alignment estimator already computes) → intersect with `policy.profiles` → the **existing #1338 selection loop** picks the best model *within the entitled profile's candidate pool* from learned per-`(task_type, model)` success/cost stats.

Design constraints, so this lands as an extension rather than a rewrite:

1. **#1338 is the router.** Profiles are a candidate-pool partition layered onto `candidates.ts`, not a second selection mechanism. The learning loop (PR③ widen+observe, flag OFF) keeps running unchanged inside each pool. The existing cheap/strong routing `tier` evolves into the three profiles rather than coexisting with them.
2. **Candidate pools stay diverse** (GLM, Kimi, etc. — Claude is a baseline, not a default), per the standing rule on #1338. "Premium" means *best reasoning currently available on OpenRouter for that task type*, whatever that is this month.
3. **Premium is spent where it pays.** Team does not get the most expensive model per request; the profile classifier decides when premium reasoning materially improves the outcome, and the policy only bounds what is *allowed*.
4. **Premium-classified task on a Starter plan** runs at Standard (best entitled model) and is tagged `profile_downgraded` internally. We measure the outcome delta before deciding whether Starter ever gets a premium-burst allowance — measurement first, knob later.
5. Model churn on OpenRouter changes pool membership only. Marketing copy, plan definitions, and policies never change with it.

## 5. Seats and identity

**A seat is one unique human attached to a billing account** — not a Slack user, a Discord user, or a Telegram user.

Rules:

1. **Claim moments.** A seat is claimed automatically the first time a person (a) accepts a console invite into any workspace of the account, or (b) is *served* a chat turn in a conversation pinned to one of the account's workspaces. Messages Jace was never going to answer (the thread-engagement gate already filters these, `apps/console/lib/channel-dispatch.ts:1284-1337`) claim nothing.
2. **Cross-workspace dedup.** The same human in three of the account's workspaces holds one seat. Seats key on the person (`user_id` when known), never on `chat_identities.workspace_id` (single-valued, can't represent multi-workspace membership).
3. **`/connect` is the identity-merge mechanism.** Unlinked platform identities are separate seats by construction — an unlinked Slack id and Telegram id are two seats until the person runs `/connect`, at which point `chat_identities.user_id` binds (`apps/console/app/(auth)/connect/[token]/page.tsx:133`) and their identity-seats collapse into one user-seat, freeing capacity. The seat-limit prompt says so explicitly ("already have a seat? `/connect` to link your account"), which turns over-counting into a linking nudge. There is no other merge signal (no email/phone matching), and v1 builds none.
4. **Owner and admins are never seat-blocked.** They occupy seats, but the gate never locks them out of their own account — same spirit as the S14-never-blocks guardrail rule.
5. **Release.** Removing a member (console members page) or unbinding an identity releases the seat immediately; capacity frees for the next person. User deletion (`chat_identities.user_id` is `ON DELETE SET NULL`) must release that user's seats in the same transaction — otherwise deletion would *raise* the count by orphaning identities back into separate seats.

## 6. Enforcement seams

Four gates, one resolver (§3), all behind a single kill-switch (`BILLING_SUBSCRIPTIONS_ENFORCED`, default OFF until launch). **Billing-infra errors fail open** — serve the user, log loudly. Blocking a paying team because Stripe or Postgres hiccuped is worse than a free turn.

1. **Chat seat gate** — a sibling gate in `processRow`, placed after workspace resolution and the engagement gate, immediately before `applyInputGuardrails` (`apps/console/lib/channel-dispatch.ts:1343`), mirrored in `processConsoleRow` (`:855`). The thread-engagement block is the structural precedent: decide → reply via `sendSystemChannelMessage` (`:151-161`) / `appendJaceMessage` (`:869-875`) → `completeChannelMessage`, never `failChannelMessage` (failing requeues and would replay the prompt). Existing seat-holders are never affected; only a *new* unique person beyond the cap is gated.
2. **Capacity gate** — at the runner claim route, exactly where wallet admission sits today (`apps/console/app/api/v1/runner/claim/route.ts:151-165`). At 80% of allowance: one soft notice. At 100%: new tasks pause with the upgrade prompt; running work finishes. The customer never sees dollars — capacity is expressed in tasks.
3. **Invite gate** — the console invites route refuses invites beyond `seatLimit` with the upgrade CTA.
4. **Routing gate** — the profile entitlement filter of §4, inside model selection.

**Prompt cooldown:** upgrade prompts fire at most once per `(billing_account, conversation)` per day, via the CAS pattern of `markBudgetExhaustedNotified` (`packages/db-postgres/src/queries/workspace_budget.ts:103-118`) on a small `upgrade_prompt_events` table — which doubles as the audit trail of who hit which wall when (calibration input for §8).

**Known delivery traps to fix in the same slice** (an unseen prompt is a silent block):
- Discord system messages can vanish in private channels — the seat prompt must use the interaction-followup credential when present (`buildDoorInitiatorAuth`, `channel-dispatch.ts:479-533`), the `.superpowers/sdd/discord-followup/` bug class.
- `sendSystemTelegramMessage` discards `messageThreadId` (`apps/console/lib/telegram-system-message.ts:38`) — prompts must land in the topic that triggered them.

## 7. Customer experience

**Upgrade messaging is product guidance, not a billing error.** One voice at every entry point (Slack, Discord, Telegram, console):

- Seat limit: *"You've reached your team's seat limit. Upgrade your plan or remove an inactive member."* (+ the `/connect` linking hint when the account has unlinked identities)
- Capacity: *"You've used your included monthly engineering capacity. Upgrade to Team for additional capacity and premium reasoning."*

**Dashboard says value, plan, and never dollars:**

- The digest's fourth card — "Cost this week" (`apps/console/components/digest-panel.tsx:137-151`) — becomes the **plan card**: seats used X/Y, monthly capacity used (as a fraction, not dollars), renewal date, upgrade CTA. The other three cards (Shipped, In progress, Needs you) already tell the value story.
- Add a cumulative **"shipped all-time"** strip per workspace (per-workspace variant of `countRunOutcomes`, `packages/db-postgres/src/queries/run_outcomes.ts:98-119` — today it's global and feeds only the landing page). Candidate for the same slice: finally render the built-but-unmounted `HealthRatesPanel` (`apps/console/components/health-rates-panel.tsx:25`, zero call sites) as the reviews/accept-rate value surface.
- **Costs, Budget, and Wallet leave the customer sidebar** (`apps/console/app/components/sidebar-nav.ts:95-105`). A "Plan & billing" item in the Settings zone replaces them: current plan, seats list with release, capacity meter, Stripe customer-portal link.
- **The approval message drops its dollar line.** "Approving sets this run's budget: ~$X.XX" (`apps/console/lib/approval-message.ts:270`, console mirror `approvals-helpers.ts:110,170-172`, landing demo `_conversation-demo.tsx:133`) reads like a charge under a subscription. The dollar leash survives internally (`budget_leash`, seeded from `policy.perTaskLeashDefaultUsd`); the customer-facing line becomes scope ("a small task", "a large task").
- **Trial:** 14 days, no card, Team-level policy — sell the best experience, then let the plan choice be a downgrade decision. `trial_ends_at` on the account; expiry gates new tasks (not chat) onto the plan-picker.

## 8. Internal ops — cost becomes telemetry

Nothing about cost measurement is deleted; it changes audience:

- **Margin meter:** per-account monthly model spend (`aggregateWorkspaceCosts` summed over the account's workspaces) vs. plan price. `policy.internalCogsAlertUsd` (launch priors: $60 Starter, $150 Team — 75% of MRR) pages us, never the customer. The per-task `budget_leash` remains the hard per-run cap, so worst-case per-task burn is bounded even inside the allowance.
- **Calibration loop:** monthly, from the margin meter + `upgrade_prompt_events`: adjust task allowances, profile pools, and leash defaults. This is where 350/1,000 stop being priors.
- **Routing efficiency:** the #1338 observe loop, unchanged, now also read as "are premium tasks worth premium cost" via the `profile_downgraded` tag.
- The Costs/Budget/Wallet pages and the wallet charge machinery stay code-live but internal-only (reachable by us; slated as the seed of a staff console — out of scope here). The wallet is also the natural **overage mechanism** if fair use ever needs teeth; keeping it dormant preserves that option.

## 9. Migration and rollout

PR-sized slices, in order; each lands behind the kill-switch and none flips customer behavior until the marketing slice:

- **Slice 0 — counting prerequisites.** Back-stamp the resolved workspace onto `channel_inbox` rows in `processRow` (today `workspace_id` is null for exactly the strangers we must count, and nothing ever updates it). Add indexes: `chat_identities(user_id)`, `channel_inbox(workspace_id, created_at)`. Hoist group-vs-DM to a first-class field at the seam (Telegram's `chatType` is written by the door at `telegram/webhook/route.ts:544` but never read by `extractPayload`, `channel-dispatch.ts:278-333`).
- **Slice 1 — schema.** `billing_accounts`, `workspaces.billing_account_id`, `seats`, `upgrade_prompt_events`, backfill (one trial account per workspace). Pre-assign the migration journal slot at plan time (stacked-PR house rule; migrations absent from `_journal.json` are silently skipped).
- **Slice 2 — policy layer.** `PLAN_POLICIES` constants, `resolvePolicyForWorkspace`, profile classification, entitlement filter into `candidates.ts`.
- **Slice 3 — Stripe subscriptions.** Real Product/Price objects (today prices are inline `price_data`), checkout `mode: "subscription"`, webhook grows `customer.subscription.*` + `invoice.payment_failed` (the `stripe_events` dedup ledger already exists), customer portal, "Plan & billing" settings page.
- **Slice 4 — seats.** Claim/merge/release logic, `/connect` seat-collapse, members surface with release.
- **Slice 5 — gates.** All four §6 gates + prompts + cooldown + the two delivery-trap fixes.
- **Slice 6 — console swap.** Plan card, all-time strip, sidebar demotion, approval-copy change.
- **Slice 7 — marketing.** Pricing page rewrite (outcome-led tiers, nav link, enterprise contact path), landing §6b rewrite, retire the copy below, update `docs/design/landing-content-architecture.md`, flip the live gate.

**Copy that must be retired** (all currently promise the opposite of this spec):
- `apps/console/app/(marketing)/pricing/page.tsx:74` — "No seats, no subscription." — and `:124-126` — "no per-seat charge, no monthly minimum."
- `apps/console/app/(marketing)/page.tsx:336-337` — "No seats. No subscription. Every run shows its cost next to its PR."
- `apps/console/lib/approval-message.ts:270` and mirrors — the "~$X.XX" budget line.
- `apps/console/app/api/v1/runner/claim/notify.ts:36-37` + `budget-helpers.ts:96` — spend-vs-ceiling customer copy (superseded by capacity language).
- `wallet-helpers.ts:26` — "The next task won't start until you top up."

**Enterprise v1 provisioning:** manual — an account row with `plan = 'enterprise'`, `policy_overrides`, Stripe manual invoicing. The contact path is a mailto/short form; no SSO or self-host build in this arc.

**Existing accounts:** every current workspace becomes a trial account at slice 1; founders convert them by hand at launch. No live paying customers exist to migrate.

## 10. Marketing direction (for the slice-7 rewrite)

Sell outcomes; never name models:

- **Starter** — an AI software engineer for teams up to 4. Fast everyday engineering: PR reviews, bug fixes, documentation. Standard reasoning.
- **Team** — everything in Starter, plus premium reasoning for complex engineering work, better architecture support, larger monthly capacity, teams up to 10.
- **Enterprise** — custom AI policies, custom seats, SSO, self-hosting, dedicated support.

Underlying OpenRouter models change freely without touching this page.

## 11. Out of scope (v1)

SSO and self-hosting productization; overage billing (wallet stays dormant); per-seat or annual pricing; a Starter premium-burst allowance (measure `profile_downgraded` first); automatic cross-platform identity matching beyond `/connect`; a staff admin console (internal pages + row edits remain the ops surface).

## 12. Open questions

1. **Launch capacity numbers** — 350/1,000 are priors; confirm or adjust before slice 7 locks the pricing page. Default: ship as written, calibrate monthly.
2. **Trial policy level** — spec says Team-level for 14 days. Default: as written.
3. **Enterprise floor** — whether the contact lane quotes a starting price. Default: no public floor at launch.
