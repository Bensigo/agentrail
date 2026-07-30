import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

/**
 * Seat lifecycle queries (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3
 * "New tables", §5 "Seats and identity"; see `schema/seats.ts` for the
 * table shape and the WHY behind soft-release + the two partial unique
 * indexes). Slice 4 Task 1 — the claim/release/read side over `seats`;
 * slice 1's `countActiveSeats` (`queries/billing_accounts.ts`) already
 * covers the account-wide `COUNT(*)` read, so it isn't repeated here.
 *
 * Same conventions as `billing_accounts.ts` (read that file's own top
 * doc-comment for the full rationale, only summarized here): `db` is an
 * explicit parameter on every function, never the imported `db` singleton,
 * so a test can pass a captured-SQL mock straight to the call site with no
 * `vi.mock("../db.js")`; every query is raw `db.execute(sql\`...\`)`, not
 * the Drizzle builder chain, for the same "capture + render with
 * `PgDialect`" testability `billing-accounts-queries.test.ts` established;
 * raw `db.execute` returns snake_case columns and Postgres's own wire-text
 * timestamps (not `Date`), so `toDate` below — copied from that module, not
 * imported: it's module-private there too (see its own doc-comment for the
 * full "why a copy" reasoning, which mirrors `isUniqueViolation`'s own
 * precedent of duplicating a small helper per call site rather than
 * centralizing it) — is what makes `claimedAt` an honest `Date` on the way
 * out of {@link listActiveSeatsWithHolders}.
 */

/**
 * Exactly one of the two branches — a linked console account (`userId`) or
 * an unlinked platform identity (`chatIdentityId`) — mirroring
 * `schema/seats.ts`'s own `seats_exactly_one_subject` CHECK at the type
 * level. The `?: never` on the unused side is the standard TypeScript shape
 * for an XOR of two mutually exclusive optional fields: it's what makes
 * `{ userId: "x", chatIdentityId: "y" }` a compile error for any caller.
 * `claimSeat` below deliberately does NOT rely on narrowing this union via
 * `in`/truthy checks on `subject` itself — under `strict`, a plain truthy
 * check on `subject.userId` does not eliminate the `chatIdentityId` branch
 * (a `string` can be falsy, e.g. `""`, so a falsy `userId` doesn't prove the
 * other shape), and `"userId" in subject` doesn't either (both branches
 * *declare* the key, one just as `never`). Comparing the ALREADY-`string |
 * undefined`-typed property against `undefined` (`subject.userId !==
 * undefined`) is the one form that narrows correctly in both directions —
 * verified against this exact package's `tsc --strict` before writing the
 * function below, not assumed from memory.
 */
export type SeatSubject =
  | { userId: string; chatIdentityId?: never }
  | { chatIdentityId: string; userId?: never };

export type SeatWithHolder = {
  id: string;
  claimedVia: string;
  claimedAt: Date;
  holderLabel: string;
  holderKind: "user" | "identity";
};

/**
 * Postgres's raw wire text for a `timestamptz` (a SPACE separator, a bare
 * 2-digit UTC offset, a possibly-6-digit fraction) needs normalizing to real
 * ISO 8601 before `new Date(...)` sees it — see `billing_accounts.ts`'s
 * `normalizePostgresTimestampText`/`toDate` for the full rationale (verified
 * 2026-07-30 against the real dev DB there; this is a verbatim copy, module-
 * private here too, for the same reason that module's own copy isn't
 * exported).
 */
function normalizePostgresTimestampText(raw: string): string {
  const isoSeparator = raw.replace(" ", "T");
  const truncatedFraction = isoSeparator.replace(/\.(\d{3})\d*/, ".$1");
  return /[+-]\d{2}$/.test(truncatedFraction) ? `${truncatedFraction}:00` : truncatedFraction;
}

/** See `normalizePostgresTimestampText` above and `billing_accounts.ts`'s
 * `toDate` for the full doc. Accepts an already-`Date` value unchanged. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(normalizePostgresTimestampText(value));
}

/**
 * Claim a seat for (billingAccountId, subject) — a no-op, never an error,
 * when that subject already holds an ACTIVE seat in this account (spec §5
 * rule 1: claimed on a console invite accept or a served chat turn, either
 * of which can fire more than once for the same person).
 *
 * `INSERT ... ON CONFLICT (...) WHERE <predicate> DO NOTHING` against the
 * matching partial unique index (`seats_active_user_idx` /
 * `seats_active_identity_idx`, `schema/seats.ts`) — not a `NOT
 * EXISTS`-guarded insert (the 0062-backfill idempotency shape, also used by
 * `completeOwnerElectWorkspace`'s membership insert) — because `DO NOTHING`
 * resolves a race between two concurrent claims for the SAME subject
 * ATOMICALLY at the index level: Postgres itself detects the conflict and
 * skips the insert, so BOTH callers' promises resolve with no error and
 * exactly one row survives, satisfying "concurrent duplicate claims must
 * both succeed as no-ops" without any application-level retry or
 * error-code-matching. A bare `NOT EXISTS` guard is a check-then-act: two
 * concurrent calls can both observe "no active row yet" before either
 * commits, both attempt the insert, and the loser would hit the same
 * partial unique index anyway — but as a thrown `23505`, pushing
 * catch-and-swallow error handling onto every caller instead of the
 * database. (This is genuinely a live index-level guarantee, not merely a
 * per-request debounce — but it is NOT exercised by this file's tests: this
 * package has no live-DB test harness, so nothing here can prove two
 * literally-concurrent Postgres sessions behave as documented. That claim
 * rests on Postgres's own `INSERT ... ON CONFLICT DO NOTHING` documentation
 * and the schema's partial unique index, not on a test in this repo.)
 *
 * The `WHERE` clause on the `ON CONFLICT` target REPEATS the partial
 * index's own predicate (`released_at IS NULL AND <subject column> IS NOT
 * NULL`) — required for Postgres to even consider a PARTIAL unique index as
 * the arbiter: "If an index_predicate is specified, it must, as a further
 * requirement for inference, satisfy arbiter indexes" (PostgreSQL `INSERT`
 * docs, `ON CONFLICT`'s `conflict_target` grammar — verified against
 * postgresql.org/docs/current/sql-insert.html before writing this, not
 * assumed from memory). Omitting it would make Postgres look for a
 * NON-partial unique index on these exact columns instead, find none, and
 * fail the whole statement with "there is no unique or exclusion constraint
 * matching the ON CONFLICT specification" — loud and immediate, not a
 * silent wrong-index match, but still worth getting right the first time.
 *
 * `claimed_at` is left off the column list — `schema/seats.ts`'s own
 * `.defaultNow()` stamps it.
 */
export async function claimSeat(
  db: Db,
  args: {
    billingAccountId: string;
    subject: SeatSubject;
    claimedVia: "console" | "telegram" | "discord" | "slack";
  }
): Promise<void> {
  const { billingAccountId, subject, claimedVia } = args;

  if (subject.userId !== undefined) {
    await db.execute(sql`
      INSERT INTO seats (billing_account_id, user_id, claimed_via)
      VALUES (${billingAccountId}, ${subject.userId}, ${claimedVia})
      ON CONFLICT (billing_account_id, user_id) WHERE released_at IS NULL AND user_id IS NOT NULL
      DO NOTHING
    `);
    return;
  }

  await db.execute(sql`
    INSERT INTO seats (billing_account_id, chat_identity_id, claimed_via)
    VALUES (${billingAccountId}, ${subject.chatIdentityId}, ${claimedVia})
    ON CONFLICT (billing_account_id, chat_identity_id) WHERE released_at IS NULL AND chat_identity_id IS NOT NULL
    DO NOTHING
  `);
}

/**
 * Release a seat by its own id — fill-only (`released_at IS NULL` guard),
 * so calling this twice (a retry, a double-click) is a safe no-op the
 * second time rather than an error or a clobbered timestamp. No-ops (0 rows
 * affected) on an unknown or already-released id — nothing for the caller
 * to branch on, matching `bindStripeCustomer`'s own fill-only contract
 * (`billing_accounts.ts`).
 */
export async function releaseSeat(db: Db, seatId: string): Promise<void> {
  await db.execute(sql`
    UPDATE seats
    SET released_at = now()
    WHERE id = ${seatId}
      AND released_at IS NULL
  `);
}

/**
 * Release the ACTIVE user-seat for (billingAccountId, userId), if any — one
 * building block toward spec §5 rule 5 ("Removing a member … releases the
 * seat immediately"; user deletion additionally requires this happen "IN
 * THE SAME TRANSACTION as the delete" — see `schema/seats.ts`'s own
 * doc-comment on why `user_id` carries no FK cascade of its own).
 *
 * This function takes `db: Db`, exactly like every other function in this
 * module — which means, same as {@link claimSeat} / {@link releaseSeat}, it
 * CANNOT be handed a `tx` from inside someone else's `db.transaction(async
 * (tx) => …)` callback: `tx` (a `PgTransaction<...>`) is missing the
 * `$client` property `Db` requires, so passing it here is a compile error,
 * not just a style choice (verified against this exact package's `tsc
 * --strict`, the same limitation `stripe_events.ts`'s
 * `applySubscriptionStateForStripeEvent` and `github_intake.ts`'s
 * `QueryExecutor` doc-comments describe). A future user-deletion flow that
 * genuinely needs this release atomic WITH the delete statement will have
 * to inline the equivalent raw UPDATE against its own `tx`, the same way
 * {@link collapseIdentitySeatsForUser} below inlines rather than calling
 * this function — that wiring is out of this task's scope (no deletion
 * flow exists yet to wire it into); this function is what a NON-transactional
 * caller (e.g. the console members-page "remove member" action, its own
 * single write) calls directly. Same fill-only shape as {@link releaseSeat}.
 */
export async function releaseUserSeatForAccount(
  db: Db,
  args: { billingAccountId: string; userId: string }
): Promise<void> {
  await db.execute(sql`
    UPDATE seats
    SET released_at = now()
    WHERE billing_account_id = ${args.billingAccountId}
      AND user_id = ${args.userId}
      AND released_at IS NULL
  `);
}

/**
 * The `/connect` collapse (spec §5 rule 3): once `chat_identities.user_id`
 * binds an unlinked identity to a console account, every account where that
 * identity held an active seat gets a user-seat claimed (a no-op if the
 * user already holds one there) and the identity-seat released — the two
 * seats a not-yet-linked person accumulated across platforms become one.
 * Freeing capacity is the actual point (spec §5 rule 3's own words: "their
 * identity-seats collapse into one user-seat, freeing capacity") — the
 * common case this matters for is a person who ALREADY independently holds
 * a user-seat in an account (e.g. accepted a console invite) and separately
 * ran up identity-seats before connecting; those collapse away and the
 * count drops by one per account.
 *
 * `claimedVia: "console"` is hardcoded for the seat claimed here, not taken
 * as a parameter — the `/connect` binding itself is a console-side action
 * (`apps/console/app/(auth)/connect/[token]/page.tsx`), so it's the correct
 * fixed value regardless of which chat platform the identity being
 * collapsed came from.
 *
 * ONE `db.transaction` wraps the discovery read AND every claim/release
 * pair — not one transaction per account — so a crash partway through never
 * leaves some accounts collapsed and others still double-counted. Claim
 * runs BEFORE release for each account (matching the brief's own stated
 * order): if the claim is ever a genuine insert (the user didn't already
 * hold a seat there), the account briefly holds both the new user-seat and
 * the still-active identity-seat rather than a window with neither — never
 * a person who transiently drops to zero seats in an account mid-collapse.
 *
 * This inlines raw SQL against `tx` rather than calling {@link claimSeat} /
 * a release helper with `tx` in place of `db`: `db.transaction(async (tx) =>
 * ...)`'s `tx` (a `PgTransaction<...>`) and this module's `Db` (`typeof
 * db`) are NOT mutually assignable — the same documented Drizzle limitation
 * `stripe_events.ts`'s `applySubscriptionStateForStripeEvent` and
 * `github_intake.ts`'s `QueryExecutor` both call out — so any `Db`-typed
 * helper in this file could never be called from inside this transaction
 * anyway; `completeOwnerElectWorkspace` (`queries/index.ts`) is the existing
 * precedent for inlining instead of fighting that mismatch.
 */
export async function collapseIdentitySeatsForUser(
  db: Db,
  args: { chatIdentityId: string; userId: string }
): Promise<void> {
  const { chatIdentityId, userId } = args;

  await db.transaction(async (tx) => {
    const accountRows = (await tx.execute(sql`
      SELECT billing_account_id
      FROM seats
      WHERE chat_identity_id = ${chatIdentityId}
        AND released_at IS NULL
    `)) as unknown as Array<{ billing_account_id: string }>;

    for (const row of Array.from(accountRows)) {
      const billingAccountId = row.billing_account_id;

      // Claim the user-seat first (no-op via DO NOTHING if one is already
      // active for this account) — see this function's own doc-comment for
      // why this ordering, and why ON CONFLICT DO NOTHING rather than
      // NOT EXISTS (same reasoning as claimSeat above).
      await tx.execute(sql`
        INSERT INTO seats (billing_account_id, user_id, claimed_via)
        VALUES (${billingAccountId}, ${userId}, 'console')
        ON CONFLICT (billing_account_id, user_id) WHERE released_at IS NULL AND user_id IS NOT NULL
        DO NOTHING
      `);

      // Then release the identity-seat that funded this account's entry —
      // fill-only, same shape as releaseSeat/releaseUserSeatForAccount.
      await tx.execute(sql`
        UPDATE seats
        SET released_at = now()
        WHERE billing_account_id = ${billingAccountId}
          AND chat_identity_id = ${chatIdentityId}
          AND released_at IS NULL
      `);
    }
  });
}

/** Raw (snake_case) shape of one `listActiveSeatsWithHolders` row, straight
 * off `db.execute` — see that function's own doc-comment for the join. */
interface RawSeatWithHolderRow {
  id: string;
  claimed_via: string;
  claimed_at: string | Date;
  user_id: string | null;
  chat_identity_id: string | null;
  user_name: string | null;
  user_email: string | null;
  identity_display_name: string | null;
  identity_platform: string | null;
}

/**
 * Derive `holderKind`/`holderLabel` from one raw joined row — kept as a
 * small pure function (not a SQL `CASE WHEN`/`COALESCE` expression) so every
 * branch (name present, name missing, both missing, display_name present,
 * display_name missing) is directly unit-testable against a plain object
 * literal; this package has no live-DB test harness to exercise a SQL
 * expression's actual behavior against real Postgres, only rendered-SQL
 * pattern matching against mocked `db.execute` rows — matching
 * `getBillingAccountForWorkspace`'s own precedent of doing shape/label work
 * in JS after a plain-column `SELECT`, not in the query text.
 *
 * `seats_exactly_one_subject` (`schema/seats.ts`) guarantees `user_id` XOR
 * `chat_identity_id` is set on every row, so branching on `user_id !==
 * null` alone is total — there is no third case. Never returns a raw UUID
 * (house display rule, `ui-prefer-names-over-ids`): a user with neither
 * `name` nor `email` set, or an identity with no `display_name`, falls back
 * to a generic label instead of ever surfacing `user_id`/`chat_identity_id`.
 */
function deriveSeatHolder(
  row: RawSeatWithHolderRow
): Pick<SeatWithHolder, "holderKind" | "holderLabel"> {
  if (row.user_id !== null) {
    return {
      holderKind: "user",
      holderLabel: row.user_name ?? row.user_email ?? "Unknown member",
    };
  }
  return {
    holderKind: "identity",
    holderLabel: row.identity_display_name
      ? `${row.identity_display_name} (${row.identity_platform})`
      : `Unknown (${row.identity_platform})`,
  };
}

/**
 * Every ACTIVE seat for a billing account, with a human-readable holder
 * label — the seats-list read behind the settings "Plan & billing" page
 * (spec §7: "seats list with release"). LEFT JOINs both possible subject
 * tables (`users`, `chat_identities`) since a single query can't inner-join
 * either one alone without dropping half the rows (exactly one side is
 * populated per row, per the exactly-one-subject CHECK); {@link
 * deriveSeatHolder} picks the right side and formats the label. Ordered
 * oldest-claim-first (`claimed_at ASC`) for a stable, deterministic list.
 *
 * Returns `[]` for an account with no active seats (an unknown id yields
 * the same empty join) — never throws.
 */
export async function listActiveSeatsWithHolders(
  db: Db,
  billingAccountId: string
): Promise<SeatWithHolder[]> {
  const rows = (await db.execute(sql`
    SELECT
      s.id,
      s.claimed_via,
      s.claimed_at,
      s.user_id,
      s.chat_identity_id,
      u.name AS user_name,
      u.email AS user_email,
      ci.display_name AS identity_display_name,
      ci.platform AS identity_platform
    FROM seats s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN chat_identities ci ON ci.id = s.chat_identity_id
    WHERE s.billing_account_id = ${billingAccountId}
      AND s.released_at IS NULL
    ORDER BY s.claimed_at ASC
  `)) as unknown as RawSeatWithHolderRow[];

  return Array.from(rows).map((row) => {
    const { holderKind, holderLabel } = deriveSeatHolder(row);
    return {
      id: row.id,
      claimedVia: row.claimed_via,
      claimedAt: toDate(row.claimed_at),
      holderLabel,
      holderKind,
    };
  });
}

/**
 * The billing account id a seat belongs to, by the seat's own id — slice 4
 * Task 5's ownership-check primitive. `releaseSeatAction`
 * (`apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/actions.ts`)
 * takes a bare `seatId` from the client, and nothing about that id proves on
 * its own which workspace's account it belongs to; nothing else in this
 * module returns a seat's account given only its id (the closest,
 * {@link listActiveSeatsWithHolders}, runs the opposite direction — every
 * seat for a KNOWN account), so this is what lets that action confirm a seat
 * belongs to the caller's own workspace BEFORE calling {@link releaseSeat},
 * rather than trusting the id outright.
 *
 * Deliberately NOT scoped to `released_at IS NULL`, unlike
 * {@link listActiveSeatsWithHolders}: {@link releaseSeat} is fill-only (a
 * no-op on an already-released seat, see its own doc-comment) precisely so a
 * retry or a double-click is safe — scoping this lookup to active-only would
 * undermine that by turning "already released" into "doesn't exist" from the
 * caller's perspective (a typed error) instead of the quiet no-op
 * `releaseSeat` itself would give. This only returns `null` — never
 * throws — when the id matches no row at all.
 */
export async function getSeatAccountId(db: Db, seatId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT billing_account_id
    FROM seats
    WHERE id = ${seatId}
    LIMIT 1
  `)) as unknown as Array<{ billing_account_id: string }>;

  const row = Array.from(rows)[0];
  return row ? row.billing_account_id : null;
}
