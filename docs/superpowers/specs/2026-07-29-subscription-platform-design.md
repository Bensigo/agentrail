# Subscription platform — billing accounts, seats, and the AI policy layer

- **Date:** 2026-07-29
- **Status:** Draft for review
- **Supersedes:** the prepaid wallet as the *commercial* model (the machinery stays, internal-only), and every "No seats, no subscription" claim on the marketing surface
- **Related:** `docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md` (the dispatch seam this reuses), model-selection learning loop (#1338), `docs/design/landing-content-architecture.md` (to be updated by the marketing slice)

## 1. Decision

AgentRail/Jace moves from usage billing (prepaid wallet, per-task charging at token cost + $0.50 + $1.00, per-workspace budget ceilings) to **company subscriptions**. This is a platform change, not a pricing-page change:

1. **Billing moves above workspaces.** A new `billing_accounts` entity owns the plan, the Stripe subscription, and the seats. Multiple workspaces share one subscription.
2. **Access control becomes per-person.** Seats are the first per-person gate on the chat path. Today anyone who speaks in a pinned group chat gets full workspace tool access (`resolveConversationWorkspace` doc, `packages/db-postgres/src/queries/jace_sessions.ts:315-320`); seats close that hole as a side effect.
3. **Plans define an AI policy, never model names.** The router receives a policy (allowed quality profiles, budgets, capacity) — it never sees "Starter" or "Growth", and the pricing page never names an OpenRouter model.
4. **Cost becomes internal.** Customers see delivered value and plan usage. The wallet, budget, and cost_events infrastructure remains as ops telemetry: model spend, margins, routing efficiency.

### Principles

**Subscription plans define customer entitlements, never implementation details.** Plans never know about OpenRouter, model names, or routing algorithms; they define only what a customer is entitled to receive. Billing disappears after policy resolution — everything downstream receives an `AiPolicy` and is completely unaware of Starter, Growth, or Enterprise.

**Every layer knows only its neighbors**, communicating through policies and capabilities rather than implementation details:

```
Company → Billing Account → Subscription Plan → AI Policy
  → Task Planner → Routing Context (AI budget · capacity · task complexity)
  → Quality Profile → Candidate Pool → Ranking Engine (#1338) → OpenRouter
  → Best Available Model → Engineering Outcome
```

Billing never leaks into routing; model providers never leak into marketing; the router never knows plan names; the pricing page never knows model names. This is what lets billing, routing, enterprise customization, and model providers evolve independently without another redesign.

Timing: the wallet flow is still behind `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` (default OFF — "Preview: not charging real payments yet", `apps/console/app/(marketing)/_pricing-gate.ts:27`). No customer money has flowed. Reversing the commercial model is cheap exactly once, and it is now.

## 2. Commercial packaging

The product is an AI software engineer for engineering teams — not for individual developers. Plans reflect company size:

| Plan | Price | Seats | Included monthly capacity | Reasoning |
|---|---|---|---|---|
| **Starter** | $80/mo | up to 4 | ≈350 engineering tasks (launch prior) | Standard |
| **Growth** | $200/mo | up to 10 | ≈1,000 engineering tasks (launch prior) | Premium available |
| **Enterprise** | Contact us | custom | custom | Custom policies |

"Growth" names the customer journey: Starter → Growth → Enterprise.

- Enterprise has **no public pricing and no checkout flow — it is a conversation.** It adds: custom seat count, SSO, self-hosting, SLA, custom AI policies (model allow-lists, routing), dedicated support. v1 provisioning is manual (see §9); the pricing page ships a contact path only.
- The seat limit is the primary commercial differentiator; reasoning level is the secondary one.
- **An "engineering task"** = one run admitted through the runner claim seam (`apps/console/app/api/v1/runner/claim/route.ts`) — exactly the unit the wallet used to charge. Conversation with Jace is not metered and is presented as unlimited.
- **Capacity is the internal primitive; tasks are the presentation.** Plans grant *monthly capacity units*; v1 spends exactly one unit per admitted task, so the pricing page can honestly say "≈350 engineering tasks". Weighted tasks, AI credits, or compute units later change only the unit-cost function at the admission seam — not the schema, the gates, or the pricing page.
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
- `plan` enum: `trial | starter | growth | enterprise`
- `stripe_customer_id`, `stripe_subscription_id`, `subscription_status` (Stripe-mirrored), `current_period_end`
- `trial_ends_at` (14 days from creation)
- `policy_overrides jsonb` — enterprise-only deltas merged over the plan's code-defined policy; empty for self-serve plans

**`workspaces.billing_account_id`** — FK, not null after backfill. Backfill migration creates one account per existing workspace (`plan = 'trial'`), named after the workspace.

**`seats`**
- `id`, `billing_account_id`, `claimed_at`, `claimed_via` (`console | telegram | discord | slack`), `released_at` nullable
- `user_id` nullable, `chat_identity_id` nullable, CHECK: exactly one of the two is set
- Partial unique indexes: one active (unreleased) seat per `(billing_account_id, user_id)` and per `(billing_account_id, chat_identity_id)`
- Seat count = active rows. No mutable counter — same append-and-derive philosophy as `wallet_transactions` (`packages/db-postgres/src/schema/wallet_transactions.ts:14-38`).

**Capacity counting** is also derived, not stored: sum capacity units (v1: one per admitted run) per account per calendar month at admission time, via the `workspaces.billing_account_id` join. Needs the indexes listed in §9 slice 0.

### The AI policy object — the contract between billing and routing

The policy is the central abstraction, not a bag of billing limits. Plans map to policies in code (one constants module, the same pattern as flag columns: fresh read at entry points, no caching — `packages/db-postgres/src/schema/workspaces.ts:82-84`):

```ts
type AiPolicy = {
  seatLimit: number;
  monthlyCapacity: number;             // capacity units; v1: 1 unit = 1 engineering task

  qualityProfiles: {
    economy: boolean;
    standard: boolean;
    premium: boolean;
  };

  routing: {
    defaultProfile: "economy" | "standard" | "premium";
    allowEscalation: boolean;          // classifier may raise above default when it materially helps
    allowDowngrade: boolean;           // ranking may drop within entitlement to protect margin
  };

  economics: {
    monthlyAiBudgetUsd: number;        // internal AI spend target for this plan — never customer-facing
    currentSpendUsd: number;           // hydrated by the resolver from cost telemetry, this period
    remainingBudgetUsd: number;        // max(0, budget − spend)
    maxTaskCostUsd: number;            // hard per-task cap — feeds the existing budget_leash
  };
};
```

**The customer-facing unit is capacity/tasks; the internal operating unit is AI spend. They are separate by design** — capacity answers "how much work did the customer receive?", the AI budget answers "how much did that work cost us?". The budget exists for margin protection, routing decisions, cost monitoring, and capacity calibration; customers never see it.

`resolvePolicyForWorkspace(workspaceId)` → account → plan constants, with `policy_overrides` merged **inside the resolver** for enterprise — overrides are resolver *input*, and the resolved `AiPolicy` is flat and final. `monthlyAiBudgetUsd` and `maxTaskCostUsd` are plan constants; `currentSpendUsd`/`remainingBudgetUsd` are **hydrated by the resolver on every call** from the period's cost telemetry (the §8 aggregation) — the same fresh-read-no-caching posture as the flag columns, so downstream still receives exactly one object. If the spend query is unavailable, the resolver hydrates a full remaining budget and flags it: routing degrades to budget-unaware, and nothing customer-facing ever blocks on telemetry (§6's fail-open rule). Billing disappears at this line: every gate in §6 and the whole routing stack receive an `AiPolicy` and nothing else — no plan names, no merge logic, no Stripe state.

## 4. Task-level, policy-aware routing

Jace is not a chatbot; it is an AI software engineer. One task involves planning, repository search, reading dozens of files, multiple model calls, tool execution, and validation — so **routing happens once, when the task is admitted, not independently per prompt.** (Conversation is separate: Jace's chat model is process-bound today and out of scope here.) The routing objective is explicit: **maximize the engineering outcome while protecting margin — never "pick the strongest available model."** The strongest model is selected only when it materially increases the probability of completing the task.

Three completely independent stages, each answering one question:

| Stage | Question it answers |
|---|---|
| **Task classification** (planner) | What level of reasoning would produce the best engineering outcome? |
| **Policy entitlement** | Is the company entitled to that level? |
| **Model selection** (ranking engine) | Which available model best satisfies that profile? |

```
Task → Planner → Execution profile → AI Policy (entitlement)
     → Quality Profile → Candidate Pool → Ranking Engine (#1338) → OpenRouter
```

The **planner** builds an execution profile at admission from signals the alignment estimator already computes: task type, expected complexity, repository size, expected context size, task importance, historical success on similar work. Selection receives it as a routing context — the router's *only* window into commercial terms is the policy, and the policy's `economics` block is how the company's budget state reaches ranking:

```ts
type RoutingContext = {
  taskType: string;
  taskComplexity: "low" | "medium" | "high";
  taskImportance: "routine" | "important";   // planner-set, from brief/goal context
  repositorySize: number;
  estimatedContextTokens: number;
  historicalPerformance: ModelOutcomeStats;  // per (task_type, model), already collected for #1338
  aiPolicy: AiPolicy;                        // never a plan name; economics carries live budget state
};
```

**Quality profiles are the permanent abstraction** — stable while OpenRouter models churn underneath:

| Profile | Used for | Availability |
|---|---|---|
| **Economy** | formatting, summaries, documentation, lightweight edits | all plans |
| **Standard** | PR reviews, bug fixes, everyday engineering | all plans |
| **Premium** | architecture, distributed systems, large refactors, difficult debugging | Growth, Enterprise |

Each profile maps to a **candidate pool** — every currently eligible model for that band. The **existing #1338 loop remains the single ranking engine** over the pool, weighing success probability, expected cost, remaining company AI budget, task importance, and historical performance (plus latency and context window). The ranking objective, stated once:

```
Best model = highest probability of successful completion
             while staying within the company's AI budget
```

— never "most powerful model available". Design constraints, so this lands as an extension rather than a rewrite:

1. **#1338 is the ranking engine.** Profiles partition `candidates.ts` into pools, not a second selection mechanism; the learning loop (PR③ widen+observe, flag OFF) runs unchanged inside each pool. The existing cheap/strong routing `tier` evolves into the three profiles rather than coexisting with them. Pool membership stays governed by the candidates registry and its standing rules: pools stay diverse (GLM, Kimi, etc.), Claude is a baseline not a default, and planning-tier models stay out of execute pools.
2. **Budget-aware inside the pool.** When a cheaper entitled candidate delivers nearly the same success probability as the most expensive one — say 92% at $0.80 against 96% at $4.00 — the cheaper one wins on a Starter-sized budget; a Growth-sized budget may accept the expensive candidate early in the period (`routing.allowDowngrade` doing its job for margin). Escalation above `routing.defaultProfile` happens only when classification says premium reasoning materially improves the outcome (`routing.allowEscalation`) — no plan gets the most expensive model per request.
3. **The budget is dynamic and the pressure is automatic.** `economics.remainingBudgetUsd` shifts ranking over the month: early period, premium candidates are affordable; late period, ranking prefers cheaper candidates unless premium materially improves success probability. Natural margin protection, no manual intervention. If remaining budget reaches zero, routing clamps to the cheapest entitled candidates and pages us — **budget exhaustion is never a customer-facing block** (capacity in §6 is the only customer boundary; `economics.maxTaskCostUsd` bounds the worst case per task in the meantime).
4. **Premium-classified task on Starter** runs at Standard (best entitled model) and is tagged `profile_downgraded` internally. We measure the outcome delta before deciding whether Starter ever gets a premium-burst allowance — measurement first, knob later.
5. **Attempt escalation stays within entitlement.** The existing retry-escalation ladder keeps working, but climbs only through profiles the policy allows.
6. **Model churn on OpenRouter changes pool membership only.** Marketing copy, plan definitions, and policies never change with it.

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
2. **Capacity gate** — at the runner claim route, exactly where wallet admission sits today (`apps/console/app/api/v1/runner/claim/route.ts:151-165`). At 80% of monthly capacity: one soft notice. At 100%: new tasks pause with the upgrade prompt; running work finishes. The customer never sees dollars — capacity is presented as ≈ engineering tasks.
3. **Invite gate** — the console invites route refuses invites beyond `seatLimit` with the upgrade CTA.
4. **Routing gate** — the profile entitlement filter of §4, inside model selection.

The internal AI budget is deliberately **not** a fifth gate: hitting it changes routing behavior (§4 constraint 3) and pages us, never the customer. Capacity and budget are independent boundaries — 350 cheap tasks exhaust capacity first; 150 very expensive tasks exhaust budget first — and both signals feed §8's calibration.

**Prompt cooldown:** upgrade prompts fire at most once per `(billing_account, conversation)` per day, via the CAS pattern of `markBudgetExhaustedNotified` (`packages/db-postgres/src/queries/workspace_budget.ts:103-118`) on a small `upgrade_prompt_events` table — which doubles as the audit trail of who hit which wall when (calibration input for §8).

**Known delivery traps to fix in the same slice** (an unseen prompt is a silent block):
- Discord system messages can vanish in private channels — the seat prompt must use the interaction-followup credential when present (`buildDoorInitiatorAuth`, `channel-dispatch.ts:479-533`), the `.superpowers/sdd/discord-followup/` bug class.
- `sendSystemTelegramMessage` discards `messageThreadId` (`apps/console/lib/telegram-system-message.ts:38`) — prompts must land in the topic that triggered them.

## 7. Customer experience

**Upgrade messaging is product guidance, not a billing error.** One voice at every entry point (Slack, Discord, Telegram, console):

- Seat limit: *"You've reached your team's seat limit. Upgrade your plan or remove an inactive member."* (+ the `/connect` linking hint when the account has unlinked identities)
- Capacity: *"You've used your included monthly engineering capacity. Upgrade to Growth for additional capacity and premium reasoning."*

**Dashboard says value, plan, and never dollars:**

- The digest's fourth card — "Cost this week" (`apps/console/components/digest-panel.tsx:137-151`) — becomes the **plan card**: seats used X/Y, monthly capacity used (as a fraction, not dollars), renewal date, upgrade CTA. The other three cards (Shipped, In progress, Needs you) already tell the value story.
- Add a cumulative **"shipped all-time"** strip per workspace (per-workspace variant of `countRunOutcomes`, `packages/db-postgres/src/queries/run_outcomes.ts:98-119` — today it's global and feeds only the landing page). Candidate for the same slice: finally render the built-but-unmounted `HealthRatesPanel` (`apps/console/components/health-rates-panel.tsx:25`, zero call sites) as the reviews/accept-rate value surface.
- **Costs, Budget, and Wallet leave the customer sidebar** (`apps/console/app/components/sidebar-nav.ts:95-105`). A "Plan & billing" item in the Settings zone replaces them: current plan, seats list with release, capacity meter, Stripe customer-portal link.
- **The approval message drops its dollar line.** "Approving sets this run's budget: ~$X.XX" (`apps/console/lib/approval-message.ts:270`, console mirror `approvals-helpers.ts:110,170-172`, landing demo `_conversation-demo.tsx:133`) reads like a charge under a subscription. The dollar leash survives internally (`budget_leash`, seeded from `policy.economics.maxTaskCostUsd`); the customer-facing line becomes scope ("a small task", "a large task").
- **Trial:** 14 days, no card, Growth-level policy — sell the best experience, then let the plan choice be a downgrade decision. `trial_ends_at` on the account; expiry gates new tasks (not chat) onto the plan-picker.

## 8. Internal ops — cost becomes telemetry

Nothing about cost measurement is deleted; it changes audience. Cost tracking moves from customer billing into an **internal intelligence signal for routing** — which is why the wallet/budget infrastructure fits this design instead of fighting it:

- **AI budget per plan:** `economics.monthlyAiBudgetUsd` — launch priors **$70 Starter, $150 Growth**, custom for Enterprise. The per-account monthly spend (`aggregateWorkspaceCosts` summed over the account's workspaces) hydrates `currentSpendUsd`/`remainingBudgetUsd` at every policy resolution, drives the §4 budget-aware ranking, and pages us as spend approaches the target — never the customer. `economics.maxTaskCostUsd` seeds the existing per-task `budget_leash`, so worst-case per-task burn stays bounded even inside the capacity grant.
- **Calibration loop:** monthly, from the margin meter + `upgrade_prompt_events`: adjust capacity grants, profile pools, and leash defaults. This is where 350/1,000 stop being priors.
- **Routing efficiency:** the #1338 observe loop, unchanged, now also read as "are premium tasks worth premium cost" via the `profile_downgraded` tag.
- The Costs/Budget/Wallet pages and the wallet charge machinery stay code-live but internal-only (reachable by us; slated as the seed of a staff console — out of scope here). The wallet is also the natural **overage mechanism** if fair use ever needs teeth; keeping it dormant preserves that option.

## 9. Migration and rollout

PR-sized slices, in order; each lands behind the kill-switch and none flips customer behavior until the marketing slice:

- **Slice 0 — counting prerequisites.** Back-stamp the resolved workspace onto `channel_inbox` rows in `processRow` (today `workspace_id` is null for exactly the strangers we must count, and nothing ever updates it). Add indexes: `chat_identities(user_id)`, `channel_inbox(workspace_id, created_at)`. Hoist group-vs-DM to a first-class field at the seam (Telegram's `chatType` is written by the door at `telegram/webhook/route.ts:544` but never read by `extractPayload`, `channel-dispatch.ts:278-333`).
- **Slice 1 — schema.** `billing_accounts`, `workspaces.billing_account_id`, `seats`, `upgrade_prompt_events`, backfill (one trial account per workspace). Pre-assign the migration journal slot at plan time (stacked-PR house rule; migrations absent from `_journal.json` are silently skipped).
- **Slice 2 — policy layer.** `PLAN_POLICIES` constants, `resolvePolicyForWorkspace`, task classification → execution profile, entitlement filter into the `candidates.ts` pools.
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

Sell engineering capabilities; never name models:

- **Starter** — an AI software engineer for teams up to 4 people. PR reviews, bug fixing, documentation, everyday engineering work.
- **Growth** — everything in Starter, plus better performance on complex engineering work: architecture assistance, large refactors, higher monthly engineering capacity, teams up to 10 people.
- **Enterprise** — contact us. Custom seat counts, custom AI policies, SSO, self-hosting, SLA, dedicated support.

Underlying OpenRouter models change freely without touching this page.

## 11. Out of scope (v1)

SSO and self-hosting productization; overage billing (wallet stays dormant); per-seat or annual pricing; a Starter premium-burst allowance (measure `profile_downgraded` first); automatic cross-platform identity matching beyond `/connect`; a staff admin console (internal pages + row edits remain the ops surface).

## 12. Open questions

1. **Launch economics** — capacity ≈350/≈1,000 tasks and AI budget targets $70/$150 are priors; confirm or adjust before slice 7 locks the pricing page. (Note the $70 target leaves ~$10/mo gross margin on Starter before infrastructure — the calibration loop owns tightening this.) Default: ship as written, calibrate monthly.
2. **Trial policy level** — spec says Growth-level for 14 days. Default: as written.
