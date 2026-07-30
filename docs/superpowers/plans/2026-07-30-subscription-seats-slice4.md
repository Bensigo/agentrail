# Subscription Slice 4 — Seat Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seats become real — claimed automatically at the two claim moments (served chat turn, accepted console invite), collapsed by `/connect`, released on removal, and visible with a release control on the Plan & billing page — per spec §5 (`docs/superpowers/specs/2026-07-29-subscription-platform-design.md`).

**Architecture:** One PR on `feat/sub-s4-seats` (currently stacked on `feat/sub-s3-stripe`; retargets to `main` when #1526 merges). **Claiming is unconditional data collection** — fire-and-forget, never blocks a turn, no feature-flag reads anywhere in this slice; pre-populating the seat ledger before enforcement means flag-on grandfathers existing teams smoothly. **Enforcement (caps, prompts) is slice 5.** The `seats` schema exists (slice 1: soft-release `released_at`, exactly-one-subject CHECK, partial uniques on active `(account,user)` / `(account,chat_identity)`); this slice adds NO migrations.

**Tech Stack:** Drizzle/Postgres raw-SQL queries (`packages/db-postgres`), channel-dispatch seam (`apps/console/lib/channel-dispatch.ts`), Next server actions/pages, vitest.

## Global Constraints

- **A seat = one unique human per billing account** (spec §5): keyed on `user_id` when the person is known (bound identity, console user), else `chat_identity_id`. Same human in N of the account's workspaces = 1 seat.
- **Claim moments exactly** (spec §5.1): (a) console invite accepted into any workspace of the account; (b) a chat turn that WILL be served — messages the engagement gate filters claim NOTHING, so the chat claim hook sits strictly AFTER the thread-engagement gate decides `turn = true`.
- **Release rule** (spec §5.5 reconciled with §5.2): membership removal releases the user's seat only when they hold no remaining membership in ANY of the account's workspaces. `/connect` collapse releases redundant identity-seats immediately.
- Fire-and-forget discipline for dispatch-path writes: `.catch(console.error)`, never `await` in a way that can fail or delay the turn (the slice-0 back-stamp is the precedent).
- Idempotency at the DB layer: claims are insert-if-no-active-seat (safe under concurrent turns); releases are `SET released_at = now() WHERE ... AND released_at IS NULL`.
- No `BILLING_SUBSCRIPTIONS_ENFORCED` reads anywhere. No cap logic anywhere (slice 5). No migrations.
- House conventions as before: raw-SQL idiom + rendered-SQL tests in `packages/db-postgres` (mock `db`, params-bound assertions); explicit-path commits with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer; rebuild the package dist after db changes; full suites + both typechecks before each commit (28 `channel-dispatch.test.ts` failures are the known pre-existing baseline).

---

### Task 1: Seat lifecycle queries

**Files:**
- Create: `packages/db-postgres/src/queries/seats.ts`
- Modify: `packages/db-postgres/src/queries/index.ts` (named re-exports)
- Test: `packages/db-postgres/src/__tests__/seats-queries.test.ts`

**Interfaces (produces — later tasks import these exact names):**
```ts
export type SeatSubject = { userId: string; chatIdentityId?: never } | { chatIdentityId: string; userId?: never };
export function claimSeat(db, args: { billingAccountId: string; subject: SeatSubject; claimedVia: "console" | "telegram" | "discord" | "slack" }): Promise<void>;
export function releaseSeat(db, seatId: string): Promise<void>;
export function releaseUserSeatForAccount(db, args: { billingAccountId: string; userId: string }): Promise<void>;
export function collapseIdentitySeatsForUser(db, args: { chatIdentityId: string; userId: string }): Promise<void>;
export type SeatWithHolder = { id: string; claimedVia: string; claimedAt: Date; holderLabel: string; holderKind: "user" | "identity" };
export function listActiveSeatsWithHolders(db, billingAccountId: string): Promise<SeatWithHolder[]>;
```
Semantics:
- `claimSeat`: insert only when no ACTIVE seat exists for that subject in that account — `WHERE NOT EXISTS (… released_at IS NULL …)` guard (the 0062-backfill idempotency pattern) or `ON CONFLICT` against the partial unique (verify Postgres partial-index conflict-target syntax against a real doc/SDK source before choosing; either is acceptable, document the choice). Concurrent duplicate claims must both succeed as no-ops (one row).
- `collapseIdentitySeatsForUser`: ONE transaction — for every account where the identity holds an active seat: claim a user-seat if none active, then release the identity-seat. Freed capacity is the point (spec §5.3).
- `listActiveSeatsWithHolders`: LEFT JOIN `users` (label: name/email) and `chat_identities` (label: display_name + platform); `holderLabel` never a raw UUID (house display rule); timestamps through the module's `toDate` coercion convention (see `billing_accounts.ts`).
- [ ] TDD (rendered SQL: the NOT-EXISTS/conflict guard; release's fill-only WHERE; collapse's two statements in one `db.transaction`; holder-label joins; param binding) → RED → implement → GREEN → full db suite + typecheck → dist rebuild → commit `feat(db): seat lifecycle queries`.

### Task 2: Chat-turn claim wiring (all four channels)

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts` (both `processRow` and `processConsoleRow`)
- Test: `apps/console/lib/channel-dispatch-seat-claim.test.ts` (new; pure-helper style — export a small decision helper if needed to keep it unit-testable without the full dispatch harness)

**Placement (read the current file first — line numbers have drifted):**
- `processRow`: AFTER the thread-engagement gate decides the message is a real turn (the gate `completeChannelMessage`s-and-returns for non-turns) and after the effective `workspaceId` is known — i.e., in the served path right before/alongside `applyInputGuardrails`. NOT in the slice-0 back-stamp block (that one runs pre-engagement and would claim seats for ignored messages).
- Subject: the row's `identity` — `identity.userId ? {userId} : {chatIdentityId: identity.id}`; `claimedVia = row.channel`.
- Account: resolve `billing_account_id` from the workspace — add a light `getBillingAccountIdForWorkspace(db, workspaceId): Promise<string | null>` to `packages/db-postgres/src/queries/billing_accounts.ts` (id-only SELECT; barrel export) rather than fetching the full row per turn. Null account (transitional) → skip claim silently.
- Fire-and-forget: `void claimSeatSafely(...).catch(...)` — one wrapper, shared by both call sites, logging with a namespaced prefix.
- `processConsoleRow`: same wrapper; `row.senderId` IS the console user id; `claimedVia: "console"`.
- [ ] TDD on the exported decision helper (subject selection, null-account skip) + call-site placement assertions where the existing dispatch tests allow → suites + typecheck → commit `feat(console): claim seats on served chat turns`.

### Task 3: Invite-accept claim + membership-removal release

**Files:**
- Modify: the invite-accept server path — trace `apps/console/app/(auth)/invite/[token]/page.tsx` to wherever the membership row is inserted (page action or API route), and hook there.
- Modify: the member-removal server path — trace `members-client.tsx`'s DELETE fetch to its API route; hook after the membership delete.
- Test: extend the traced routes'/actions' existing tests.

**Behavior:**
- Invite accepted → membership inserted → `claimSeat({ billingAccountId(workspace), subject: {userId}, claimedVia: "console" })`, awaited but non-fatal (log + continue on error — the invite must still succeed).
- Membership removed → count the user's remaining memberships across ALL workspaces of that billing account (`listAccountWorkspaceIds` exists) → zero remaining → `releaseUserSeatForAccount`. Non-fatal on error.
- [ ] TDD (invite path claims; removal releases only on last-workspace; mid-account removal keeps the seat) → suites + typecheck → commit `feat(console): seat claim on invite accept, release on member removal`.

### Task 4: `/connect` seat collapse

**Files:**
- Modify: the bind flow — `apps/console/app/(auth)/connect/[token]/page.tsx` (after `bindChatIdentityUser`, ~line 133; read `apps/console/lib/connect-bind-decision.ts` for the flow's shape)
- Test: extend the connect flow's existing tests (`connect-bind-*` test files exist)

**Behavior:** after a successful bind, `collapseIdentitySeatsForUser({ chatIdentityId: identity.id, userId: session.user.id })` — awaited, non-fatal (loud log; the bind must still succeed). Doc-comment: this is spec §5.3's linking nudge made real — linking frees seats.
- [ ] TDD → suites + typecheck → commit `feat(console): /connect collapses identity seats into the user seat`.

### Task 5: Seats list + release on the Plan & billing page

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/page.tsx` (Seats section under the plan card)
- Modify: `billing/actions.ts` (add `releaseSeatAction(workspaceId, seatId)` — admin-gated, typed results, verifies the seat belongs to the workspace's account before releasing)
- Modify: `billing/billing-helpers.ts` (+ its test — `seatRowLabel(seat)` etc.)
- Test: extend `billing/actions.test.ts`

**Content:** each active seat: holder label (name / platform display — never UUIDs), `claimedVia` badge, claimed date, Release button (admin-only, same `canManage` + server-side `ADMIN_ROLES` double-layer as the existing actions). Empty state: one muted line ("Seats are claimed automatically when someone talks to Jace or accepts an invite."). Releasing your own seat is allowed (it self-heals on your next turn — doc-comment).
- [ ] TDD (action: authz, wrong-account seat rejected, happy path; helpers pinned) → suites + typecheck → commit `feat(console): seats list with release on plan & billing`.

---

## Verification & ship
- Full suites + typechecks; browser-verify the billing page's seats section (worktree dev server, minted session — claim a seat by inserting a fixture or via a console chat turn, see it listed, release it).
- PR `feat(console): subscription slice 4 — seat lifecycle`, base `main` after #1526 merges (retarget + rebase per stacked mechanics). Body: claim-moments table, the last-workspace release rule, unconditional-claim rationale (pre-populating before enforcement), and what slice 5 adds on top.
- NOT here: caps, upgrade prompts, `upgrade_prompt_events` usage, flag reads (slice 5); wallet/cost UI (slice 6).
