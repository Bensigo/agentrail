# Subscription Slice 5 — Enforcement Gates + Upgrade Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kill-switch becomes meaningful — behind `BILLING_SUBSCRIPTIONS_ENFORCED`, the chat seat gate, capacity gate, and invite gate enforce the plan's `seatLimit`/`monthlyCapacity` with one-voice upgrade prompts (cooldown via `upgrade_prompt_events`), the two delivery traps (Discord private-channel 50001, Telegram thread drop) are fixed, and the cold-start seed stops bypassing profile entitlement — per spec §6/§7 (`docs/superpowers/specs/2026-07-29-subscription-platform-design.md`).

**Architecture:** One PR on `feat/sub-s5-gates` (base `main`, slices 0-4 all merged). Every gate follows the same skeleton: `subscriptionsEnforced()` checked **before** `resolvePolicyForWorkspace` is ever called (flag-off = byte-identical behavior — the `alignment-brief.ts:184` pattern); `degraded: true` or a `null` `billingAccountId` ⇒ skip the gate entirely (hard contract, `resolve-policy.ts:49-53`); any thrown error ⇒ fail open, serve the user, log loudly. Gates block, cooldowns only limit prompt *spam* — a CAS loss still blocks, just silently. No migrations (schema shipped in slice 1).

**Tech Stack:** Drizzle/Postgres raw-SQL + fluent queries (`packages/db-postgres`), channel-dispatch seam (`apps/console/lib/channel-dispatch.ts`), Next API routes, vitest.

## Global Constraints

- **Prompt copy, verbatim from spec §7** (one voice at every entry point):
  - Seat limit: `You've reached your team's seat limit. Upgrade your plan or remove an inactive member.`
  - /connect hint (appended only when the account holds active identity-keyed seats): `Already have a seat? Use /connect to link your account.`
  - Capacity 100%: `You've used your included monthly engineering capacity. Upgrade to Growth for additional capacity and premium reasoning.`
  - Capacity 80% soft notice: `Heads up: your team has used 80% of its included monthly engineering capacity. Upgrade to Growth for additional capacity and premium reasoning.`
  - The customer never sees dollars, model names, or the word "budget".
- **Flag:** `subscriptionsEnforced()` (`apps/console/lib/policy/feature-flags.ts:49`) — env literal `"1"` only. Check it FIRST, before any billing read.
- **Degraded contract:** `resolvePolicyForWorkspace` returns `{ policy, billingAccountId, degraded }`; `degraded === true` ⇒ skip ALL enforcement. `billingAccountId === null` with `degraded: false` (fresh trial, unstamped workspace) ⇒ also skip (nothing to count against).
- **Fail open:** billing-infra errors never block a turn/claim/invite — catch, `console.error` with a namespaced prefix, proceed as if the gate passed.
- **Dispatch exits:** a gated chat turn is `completeChannelMessage` + `"completed"` — NEVER `failChannelMessage` (failing requeues and replays the refusal; see `channel_inbox.ts:267`).
- **CAS before send** (existing `markBudgetExhaustedNotified` precedent): win the `upgrade_prompt_events` insert first, then attempt delivery; a lost send after a won CAS is accepted (logged).
- **`upgrade_prompt_events` conventions:** unique on `(billing_account_id, kind, conversation_key, period_key)`. Kinds and period keys used in this slice: `seat_limit` daily (`YYYY-MM-DD`), `capacity` daily (`YYYY-MM-DD`), `capacity_warning` monthly (`YYYY-MM`). All UTC. Update the `kind` comment in `packages/db-postgres/src/schema/upgrade_prompt_events.ts:28` to list all three.
- **Billing period = UTC calendar month** (`billing_accounts` has NO `current_period_start`; calendar month is the established convention — `claim/route.ts:37-48`).
- **No `BILLING_SUBSCRIPTIONS_ENFORCED` writes to docs/marketing. No migrations.** (The missing `workspaces.billing_account_id` index is a known, accepted seq-scan — workspaces is small; do NOT add one here.)
- House conventions: raw-SQL idiom + rendered-SQL tests in `packages/db-postgres` (copy the style of `src/__tests__/seats-queries.test.ts`); `COUNT(*)::int` cast (postgres.js returns uncast counts as strings); window bounds passed as **ISO strings, never Date objects** into `db.execute(sql\`\`)`; rebuild the db package dist after query changes (`pnpm --filter @agentrail/db-postgres build`); full package suites + `tsc --noEmit` (console) before each commit; commits use explicit file paths and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Gate queries (db-postgres)

**Files:**
- Modify: `packages/db-postgres/src/queries/seats.ts` (add `hasActiveSeat`, `countActiveIdentitySeats`)
- Create: `packages/db-postgres/src/queries/upgrade_prompts.ts` (`recordUpgradePromptOnce`)
- Modify: `packages/db-postgres/src/queries/workspace_costs.ts` OR new `capacity.ts` (`countAccountRunsStartedInWindow`)
- Modify: `packages/db-postgres/src/queries/jace_sessions.ts` (add `latestChatSessionForWorkspace`)
- Modify: `packages/db-postgres/src/queries/index.ts` (barrel re-exports with WHY comments)
- Modify: `packages/db-postgres/src/schema/upgrade_prompt_events.ts:28` (kind comment: `'seat_limit' | 'capacity' | 'capacity_warning'`)
- Test: `packages/db-postgres/src/__tests__/gate-queries.test.ts` (new)

**Interfaces (produces — later tasks import these exact names from `@agentrail/db-postgres`):**
```ts
export async function hasActiveSeat(db: Db, args: { billingAccountId: string; subject: SeatSubject }): Promise<boolean>;
export async function countActiveIdentitySeats(db: Db, billingAccountId: string): Promise<number>;
export async function recordUpgradePromptOnce(db: Db, args: {
  billingAccountId: string;
  kind: "seat_limit" | "capacity" | "capacity_warning";
  conversationKey: string;
  channel: string;
  periodKey: string;
}): Promise<boolean>; // true = this call won the slot (caller should deliver the prompt)
export async function countAccountRunsStartedInWindow(db: Db, args: {
  billingAccountId: string;
  fromIso: string; // inclusive, ISO 8601 UTC
  toIso: string;   // exclusive
}): Promise<number>;
export type LatestChatSession = { channel: string; conversationKey: string };
export async function latestChatSessionForWorkspace(workspaceId: string): Promise<LatestChatSession | null>;
```

Semantics:
- `hasActiveSeat`: `SELECT 1 FROM seats WHERE billing_account_id = $1 AND released_at IS NULL AND <user_id|chat_identity_id> = $2 LIMIT 1` — branch on the `SeatSubject` variant exactly as `claimSeat` does (`seats.ts:124`). Returns `rows.length > 0`.
- `countActiveIdentitySeats`: `SELECT count(*)::int FROM seats WHERE billing_account_id = $1 AND released_at IS NULL AND chat_identity_id IS NOT NULL` — feeds the /connect hint (active seats keyed on an unlinked platform identity).
- `recordUpgradePromptOnce`: fluent Drizzle — `db.insert(upgradePromptEvents).values({...}).onConflictDoNothing({ target: [billingAccountId, kind, conversationKey, periodKey] }).returning({ id })`; return `rows.length > 0`. This is the insert-based CAS twin of `markBudgetExhaustedNotified` (`workspace_budget.ts:103-118`); doc-comment must say the caller delivers ONLY on `true`, and that `channel` is recorded but deliberately outside the dedup key.
- `countAccountRunsStartedInWindow`: raw SQL —
  ```sql
  SELECT COUNT(*)::int AS count
  FROM runs r
  JOIN workspaces w ON w.id = r.workspace_id
  WHERE w.billing_account_id = ${billingAccountId}
    AND r.created_at >= ${fromIso}
    AND r.created_at < ${toIso}
  ```
  `runs.created_at` IS claim time (rows are inserted by `claimQueueEntry` at claim, `runner.ts:723-746`), so this counts **tasks started in the window** — one capacity unit per admitted run, spec §9's exact v1 rule. Doc-comment both idioms: the `::int` cast and ISO-string (never `Date`) params (`workspace_costs.ts:165-195` explains both).
- `latestChatSessionForWorkspace`: copy the shape of `latestTelegramSessionForWorkspace` (`jace_sessions.ts:619-631`) but `channel IN ('telegram','discord','slack')`, `ORDER BY last_activity_at DESC LIMIT 1`, returning `{ channel, conversationKey }`. Same param convention as its sibling (that module uses the singleton `db` — match whichever convention `latestTelegramSessionForWorkspace` actually uses).

- [ ] TDD in `gate-queries.test.ts` (rendered SQL via the existing `seats-queries.test.ts` harness style): `hasActiveSeat` renders the user-variant and identity-variant WHERE + params; `countActiveIdentitySeats` renders `chat_identity_id IS NOT NULL`; `recordUpgradePromptOnce` renders `on conflict ... do nothing` with the 4-column target and returns true/false by mocked returning length; `countAccountRunsStartedInWindow` renders the JOIN + half-open window and binds ISO strings; `latestChatSessionForWorkspace` renders the channel IN-list and LIMIT 1 → RED → implement → GREEN.
- [ ] Full db suite (`pnpm --filter @agentrail/db-postgres test`) + `pnpm --filter @agentrail/db-postgres build` (dist rebuild — console imports from dist) → commit `feat(db): gate queries — seat lookup, upgrade-prompt CAS, capacity count, latest chat session`.

### Task 2: Telegram thread-id passthrough (delivery trap #2)

**Files:**
- Modify: `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram.ts` (or wherever `sendTelegramMessage` is defined — trace the import at `apps/console/lib/telegram-system-message.ts:17`)
- Modify: `apps/console/lib/telegram-system-message.ts` (delete the `void messageThreadId;` drop at line 38, pass it through)
- Test: extend `apps/console/lib/telegram-system-message.test.ts` + the sender's existing test file

**Interfaces:**
- Produces: `sendTelegramMessage(token, chatId, text, messageThreadId?)` — new optional 4th param; when present and numeric, the Bot API body gains `message_thread_id: Number(messageThreadId)`. `sendSystemTelegramMessage(chatId, text, messageThreadId?)` keeps its exact signature (already accepts the param — today it drops it).
- Consumes: nothing new. All 5 existing callers compile unchanged; `sendSystemChannelMessage` (`channel-dispatch.ts:179`) already passes `messageThreadId` — after this task, Telegram topic threads actually receive system messages in-topic.

- [ ] Read the current `sendTelegramMessage` implementation first (exact body shape, SendResult type). TDD: (a) `sendSystemTelegramMessage("123", "hi", "42")` results in a Bot API payload containing `message_thread_id: 42`; (b) omitted/undefined thread id → no `message_thread_id` key at all; (c) non-numeric thread id → no key (defensive — Telegram rejects non-int). RED → implement (remove the `void` drop; update the doc-comment at `telegram-system-message.ts:25-32` which currently documents the drop) → GREEN.
- [ ] Console suite for the touched files + `tsc --noEmit` → commit `fix(console): telegram system messages honor message_thread_id`.

### Task 3: Discord followup-first system sender (delivery trap #1)

**Files:**
- Modify: `apps/console/lib/discord-system-message.ts` (add `sendSystemDiscordMessagePreferFollowup`)
- Test: extend `apps/console/lib/discord-system-message.test.ts` (create if absent)

**Interfaces (produces):**
```ts
export async function sendSystemDiscordMessagePreferFollowup(params: {
  channelId: string;
  text: string;
  interactionToken?: string;
  applicationId?: string;
}): Promise<SendResult>;
```
Behavior — the console-side mirror of `apps/jace/agent/lib/discord-followup.core.mjs` (do NOT import from apps/jace — it's outside the workspace):
1. When BOTH `interactionToken` and `applicationId` are non-blank (both-or-neither, the `buildDoorInitiatorAuth:788-791` rule): `POST https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}` with JSON body `{ content: text }`, **no Authorization header** (the token IS the credential; valid 15 min). 2xx → `{ ok: true }`.
2. Non-2xx, thrown fetch, or missing credentials → fall through to `sendSystemDiscordMessage(channelId, text)` (the bot-post path — works in public channels, returns the 50001-shaped failure in private ones, which the caller logs).
3. Never throws.

Why: the plain bot path silently loses system prompts in private channels (`50001 Missing Access` — `discord-followup.core.mjs:7-19`); the interaction-followup webhook needs no channel permission. Spec §6 names this the delivery trap the seat prompt must not fall into.

- [ ] TDD with mocked `fetch`: followup URL + body + no-auth-header asserted; followup 2xx → ok, bot path NOT called; followup 404 → bot fallback called with `(channelId, text)`; missing one credential → straight to bot path; fetch throws → bot fallback, no throw. RED → implement → GREEN.
- [ ] Touched-file suite + `tsc --noEmit` → commit `feat(console): discord system sender prefers interaction followup`.

### Task 4: Chat seat gate (processRow + processConsoleRow)

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts`
- Test: create `apps/console/lib/channel-dispatch-seat-gate.test.ts` (pure decision helper) + extend `apps/console/lib/channel-dispatch.test.ts` (wiring: gated turn completes with prompt; flag-off untouched)

**Interfaces:**
- Consumes: Task 1 (`hasActiveSeat`, `countActiveIdentitySeats`, `recordUpgradePromptOnce`), Task 2 (thread-aware telegram via `sendSystemChannelMessage`), Task 3 (`sendSystemDiscordMessagePreferFollowup`), plus existing `resolvePolicyForWorkspace`, `subscriptionsEnforced`, `countActiveSeats`, `getWorkspaceMembership`, `decideSeatClaimForServedTurn`.
- Produces (exported for tests):
```ts
export function decideSeatGate(params: {
  enforced: boolean;                       // subscriptionsEnforced() — resolved by caller
  degraded: boolean;
  billingAccountId: string | null;
  seatLimit: number;
  subjectHasSeat: boolean;
  activeSeatCount: number;
  isWorkspaceAdmin: boolean;               // owner/admin bypass, spec §5 rule 4
}): "pass" | "gate";
export function buildSeatLimitPrompt(hasUnlinkedIdentitySeats: boolean): string;
```
`decideSeatGate` is pure truth-table: `"gate"` ONLY when `enforced && !degraded && billingAccountId && !subjectHasSeat && !isWorkspaceAdmin && activeSeatCount >= seatLimit`. Everything else `"pass"`.

**Orchestration — new module-private `async applySeatGateForServedTurn(...)` in channel-dispatch.ts, returning `"pass" | "gated"`:**
1. `if (!subscriptionsEnforced()) return "pass";` — before any billing read.
2. Whole body in try/catch → catch logs `[seat-gate]` + returns `"pass"` (fail open).
3. `const resolved = await resolvePolicyForWorkspace(workspaceId);` → feed `decideSeatGate` with: `subjectHasSeat = await hasActiveSeat(db, { billingAccountId, subject })` (subject = `identity.userId ? { userId } : { chatIdentityId }` — same rule as `decideSeatClaimForServedTurn:572`); `activeSeatCount = await countActiveSeats(db, billingAccountId)`; `isWorkspaceAdmin` = `identity.userId` ? role of `await getWorkspaceMembership(identity.userId, workspaceId)` is `owner`/`admin` (local `const ADMIN_ROLES = ["owner", "admin"] as const;` — the house per-file pattern) : `false`. Short-circuit order for the hot path: hasActiveSeat first (existing holders are the common case — skip the rest when true).
4. On `"gate"`: `const won = await recordUpgradePromptOnce(db, { billingAccountId, kind: "seat_limit", conversationKey: row.conversationKey, channel: row.channel, periodKey: <UTC YYYY-MM-DD> });` — if `won`, build `buildSeatLimitPrompt(await countActiveIdentitySeats(db, billingAccountId) > 0)` and deliver:
   - discord → `sendSystemDiscordMessagePreferFollowup({ channelId: <same targetId the guardrail-notice path uses>, text, interactionToken: payload.interactionToken, applicationId: payload.applicationId })` — read the credentials off `payload` BEFORE `completeChannelMessage` (complete scrubs them, `channel_inbox.ts:248-257`);
   - telegram/slack → the existing `sendSystemChannelMessage(row.channel, targetId, text, payload.messageThreadId, payload.threadTs, payload.teamId)` exactly as the guardrail-block path at `channel-dispatch.ts:1692-1710` computes its arguments (copy that call's argument derivation verbatim).
5. Gated (won or lost CAS): `completeChannelMessage(row.id)` + the caller returns `"completed"`. A lost CAS blocks silently — the gate always blocks; cooldown only stops prompt spam.

**Placement:**
- `processRow`: immediately after the engagement gate sets `engagementSaidTurn = true` (line 1655) and BEFORE the slice-4 claim hook at 1670 — a gated person must not claim. Skip entirely when `workspaceId === null` (intro path — nothing to count against). `conversationKindForRow` (1573) stays unread by the gate — the gate applies to DMs and groups alike (a DM turn claims a seat too, so it must be capped too); delete its "nothing reads this yet" comment only if you use it, otherwise leave untouched.
- `processConsoleRow`: after `buildConsoleInitiatorAuth` (1117) and BEFORE the claim at 1128. Subject `{ userId: row.senderId }`; `isWorkspaceAdmin` via `getWorkspaceMembership(row.senderId, row.workspaceId)`. Prompt delivery = `appendJaceMessage({ workspaceId, conversationKey, role: "jace", text })` (the console notice pattern at 1151-1158). Then `completeChannelMessage` + `"completed"`.

**Known semantics to doc-comment at the gate:** accepted invites claim unconditionally (slice 4) — a pending invite accepted while at cap can push the account over; those members hold seats and are never re-blocked here. Over-cap resolves by member removal or upgrade, never by locking out a seat-holder. Also: two brand-new people racing the last seat can both pass (count-then-claim, no lock) — fail-open bias, accepted.

- [ ] TDD `decideSeatGate` truth table (each factor flips the verdict; default pass) + `buildSeatLimitPrompt` copy pinned verbatim (with + without the /connect hint line) → RED → implement helpers → GREEN.
- [ ] Wire both call sites; extend `channel-dispatch.test.ts`: (a) flag off ⇒ dispatch behavior byte-identical (no policy resolver call — assert the mock uncalled); (b) enforced + at-cap new identity ⇒ prompt sent via the right sender, row completed, `claimSeat` NOT called, eve NOT invoked; (c) enforced + existing holder ⇒ served; (d) degraded ⇒ served; (e) CAS lost ⇒ completed silently, no send. Full console suite + `tsc --noEmit` → commit `feat(console): chat seat gate at the dispatch seam`.

### Task 5: Capacity gate at the runner claim route

**Files:**
- Modify: `apps/console/app/api/v1/runner/claim/route.ts` (gate block between the workspace-budget ceiling and the wallet admission)
- Modify: `apps/console/app/api/v1/runner/claim/notify.ts` (add capacity notice senders on the generalized latest-session path)
- Test: extend `apps/console/app/api/v1/runner/claim/notify.test.ts` + the claim route's existing test file(s)

**Interfaces:**
- Consumes: Task 1 (`countAccountRunsStartedInWindow`, `recordUpgradePromptOnce`, `latestChatSessionForWorkspace`), Task 2 (thread param — not needed here, claim context has no thread), Task 3 (`sendSystemDiscordMessagePreferFollowup` — no followup token in this async context; use plain `sendSystemDiscordMessage`), existing `resolvePolicyForWorkspace`, `subscriptionsEnforced`, `currentBudgetWindow` (route-local, `:37-48`), `CLAIM_BLOCKED_HEADER`.
- Produces (in notify.ts):
```ts
export function buildCapacityPausedMessage(): string;   // the §7 capacity copy, verbatim
export function buildCapacityWarningMessage(): string;  // the 80% copy, verbatim
export async function notifyAccountCapacity(workspaceId: string, kind: "capacity" | "capacity_warning"): Promise<void>;
```

**Gate block (route.ts), inserted after the workspace-budget block (~:135) and before `isBillingEnabled` wallet admission (~:151):**
```ts
if (subscriptionsEnforced()) {
  try {
    const resolved = await resolvePolicyForWorkspace(workspaceId);
    if (!resolved.degraded && resolved.billingAccountId) {
      const window = currentBudgetWindow(); // UTC calendar month, half-open
      const used = await countAccountRunsStartedInWindow(db, {
        billingAccountId: resolved.billingAccountId,
        fromIso: window.startIso,
        toIso: window.endIso,
      });
      const capacity = resolved.policy.monthlyCapacity;
      if (used >= capacity) {
        void maybeNotifyCapacity(resolved.billingAccountId, workspaceId, "capacity", window.period);
        return new NextResponse(null, {
          status: 204,
          headers: { [CLAIM_BLOCKED_HEADER]: "capacity" },
        });
      }
      if (used >= Math.ceil(capacity * 0.8)) {
        void maybeNotifyCapacity(resolved.billingAccountId, workspaceId, "capacity_warning", window.period);
      }
    }
  } catch (err) {
    console.error("[runner/claim] capacity gate failed open:", err);
  }
}
```
(Adapt to the route's actual local names — read `currentBudgetWindow`'s real return shape first and reuse it; if it returns Dates, convert with `.toISOString()`.) The 204 + header + untouched `queue_entries` row is the established "pause" shape — the entry stays `queued`, the runner re-polls, and the gate self-heals at month rollover. Running work is untouched (the gate sits before `claimQueueEntry` only).

**`maybeNotifyCapacity` (route-local or notify.ts): CAS then send.**
- `periodKey`: `"capacity"` → UTC `YYYY-MM-DD` (daily re-prompt while paused); `"capacity_warning"` → the month key `YYYY-MM` (ONE soft notice per period).
- `conversationKey` for the CAS row: the delivered session's `conversationKey` when `latestChatSessionForWorkspace(workspaceId)` finds one, else the sentinel `workspace:${workspaceId}` (dedup still needs a key when there's nobody to tell).
- Delivery in `notifyAccountCapacity`: resolve `latestChatSessionForWorkspace(workspaceId)`; `telegram` → `sendSystemTelegramMessage(conversationKey, text)`; `discord` → `sendSystemDiscordMessage(conversationKey, text)` (best-effort; private-channel failure is logged — no followup token exists in this async context); `slack` → attempt ONLY if a team id is derivable (read the `jace_sessions` row/conversationKey format first — if the team id is not recoverable, skip with a loud `[capacity-notify]` log; do NOT guess). No session → log + return (same silent no-op as today's budget notice, `notify.ts:52`). Typed send failures are logged, never thrown (the CAS already burned the slot — `notify.ts:56-67` precedent).

- [ ] TDD notify: message builders pinned verbatim; `notifyAccountCapacity` routes per channel; no-session no-op. TDD route: enforced + at-capacity ⇒ 204 with `X-Agentrail-Claim-Blocked: capacity`, `claimQueueEntry` never called; 80-99% ⇒ claim proceeds AND warning CAS attempted once; flag off ⇒ resolver never called; degraded ⇒ proceeds; resolver throws ⇒ proceeds (fail open). RED → implement → GREEN.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): capacity gate at the runner claim route`.

### Task 6: Invite gate

**Files:**
- Modify: `apps/console/app/api/v1/workspaces/[workspaceId]/invites/route.ts` (POST, after the role guard at :61-66, before email validation)
- Test: extend `apps/console/app/api/v1/workspaces/[workspaceId]/invites/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `subscriptionsEnforced`, `resolvePolicyForWorkspace`, `countActiveSeats` (add to the shared `vi.mock("@agentrail/db-postgres")` factory at test :8-20 — it is NOT there yet).

**Behavior:** after admin authz, before any insert:
```ts
if (subscriptionsEnforced()) {
  try {
    const resolved = await resolvePolicyForWorkspace(workspaceId);
    if (!resolved.degraded && resolved.billingAccountId) {
      const seats = await countActiveSeats(db, resolved.billingAccountId);
      if (seats >= resolved.policy.seatLimit) {
        return NextResponse.json(
          { error: "You've reached your team's seat limit. Upgrade your plan or remove an inactive member." },
          { status: 409 }
        );
      }
    }
  } catch (err) {
    console.error("[invites] seat gate failed open:", err);
  }
}
```
409 + flat `{ error }` surfaces verbatim in `invite-member-dialog.tsx:60-88` (it parses `body.error` and `setFormError`s it) — no UI change needed. Re-invite upsert of an existing pending invite is also blocked at cap (acceptable: the CTA says remove a member or upgrade). No `upgrade_prompt_events` row — this is a synchronous UI error, not an async prompt; cooldown is meaningless here.

- [ ] TDD: enforced + at-cap ⇒ 409 with the exact copy, `createInvite` not called; below cap ⇒ 201 unchanged; flag off ⇒ resolver never called, 201; degraded ⇒ 201; resolver throws ⇒ 201 (fail open). RED → implement → GREEN.
- [ ] Route suite + `tsc --noEmit` → commit `feat(console): invite gate refuses invites beyond the seat limit`.

### Task 7: Cold-start seed respects profile entitlement (routing gate closure)

**Files:**
- Modify: `apps/console/lib/alignment/selector.ts` (`decideExploit`, ~:145-163)
- Test: extend `apps/console/lib/alignment/selector.test.ts`

**Interfaces:** no new exports; `decideExploit` is internal to the selector. `seatForSlug` (selector.ts:120) and the filtered `eligibleSlugs` param it already receives are the ingredients.

**The bug (verified):** `decideExploit` derives the seed from static config (`const seed = seedModel(taskType);` at :151) and never checks it against `eligibleSet` — the profile-entitlement filter applies only to stats rows and exploration. Concrete leak: Starter plan (`premium: false`) + `refactor` task + <5 qualified runs ⇒ seed `anthropic/claude-opus-4.8` (premium, `candidates.ts:163`) is selected with `reason: "seed"`. Existing tests miss it because they all use `ui`, whose seed is standard-tagged.

**The fix:** constrain the seed to the filtered pool:
```ts
let seed = seedModel(taskType);
if (!eligibleSet.has(seed.slug)) {
  // Entitlement (or eligibility) excluded the static seed — fall to the first
  // entitled candidate. eligibleSlugs preserves candidates.ts seed-first order
  // (eligibility.ts:92-93) and is non-empty whenever the unfiltered pool is
  // (the empty-pool fail-open at eligibility.ts:127-137), so [0] always exists.
  seed = seatForSlug(eligibleSlugs[0]);
}
```
`eligibleSet` already exists in scope (built from `eligibleSlugs` at :152-156). Everything downstream (`seedRow`, `seedSelection`) keys off the corrected `seed`. When the profile filter empties the pool entirely, `eligibleModelsForTaskType` already fell back to the unfiltered set one layer down — the seed correctly degrades to today's behavior there.

- [ ] TDD: (a) regression — `refactor` + `allowedProfiles: Set(["economy","standard"])` + zero stats ⇒ selection is the first entitled refactor candidate (NOT `anthropic/claude-opus-4.8`), `reason: "seed"`; (b) seed in-profile (ui + standard allowed) ⇒ unchanged static seed (pins existing behavior); (c) no `allowedProfiles` passed ⇒ static seed unchanged (flag-off path). RED → implement → GREEN.
- [ ] Alignment suite + `tsc --noEmit` → commit `fix(console): cold-start seed respects profile entitlement`.

---

## Verification & ship

- Full suites (`pnpm --filter @agentrail/db-postgres test`, `pnpm --filter @agentrail/console test`) + both typechecks; db dist rebuilt.
- Whole-slice adversarial review (fresh reviewer, all 7 tasks as one diff): trace every gate's flag-off path is byte-identical; every fail-open; the complete-not-fail rule; CAS-before-send; copy strings byte-exact against spec §7.
- Browser/live verify (worktree dev server `console-subimpl-3005`): with `BILLING_SUBSCRIPTIONS_ENFORCED=1` in the dev env, mint a session, drive an invite past the seat limit (fixture seats via psql on the dev DB, delete by exact id after) → 409 copy in the dialog; flag off → invites work.
- PR `feat(console): subscription slice 5 — enforcement gates + upgrade prompts`, base `main`. Body: the four gates table (seam, trigger, behavior, prompt), cooldown semantics (3 kinds × period keys), the two delivery-trap fixes, the seed entitlement fix (closes the flag-ON precondition), and what stays for slice 6/7.
- NOT here: console cost-UI swap (slice 6); pricing/landing copy (slice 7); `workspaces.billing_account_id` index (accepted seq scan); Slack teamId plumbing beyond what's derivable.
