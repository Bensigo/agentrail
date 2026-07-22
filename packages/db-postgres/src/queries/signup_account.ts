import { db } from "../db.js";
import { users, sessions, type User } from "../schema/auth.js";

/**
 * Sign-up account primitives (issue #1364) — the two writes the sign-up
 * redemption flow (`apps/console/lib/signup-redeem.ts`) needs that the
 * existing GitHub-OAuth-only auth path (`packages/auth`) never had to do
 * itself: mint a bare `users` row with no OAuth provider behind it, and mint
 * a database-session row directly, bypassing the OAuth round trip entirely.
 * NextAuth's own `DrizzleAdapter` normally owns both of these (it creates a
 * `users` row on a provider's first sign-in, and a `sessions` row on every
 * sign-in) — this module duplicates just enough of that adapter contract to
 * do it from a magic-link redemption instead of an OAuth callback. Every
 * write here must still land rows the SAME adapter/tables `packages/auth`
 * reads at request time (`schema/auth.ts`), so a later `auth()` call sees a
 * perfectly ordinary session — nothing about this path is a shadow auth
 * system.
 */

/**
 * Create a brand-new `users` row for a first-time sign-up (issue #1364).
 * `email` is deliberately never set here: a Telegram sign-up carries no
 * email address, and `users.email` has its own unique index that tolerates
 * many NULLs (Postgres treats NULL <> NULL for uniqueness), so leaving it
 * unset is correct, not a placeholder. `name` is best-effort UX only (shown
 * back in the console's own chrome eventually) — never used to resolve
 * identity anywhere; the caller (`signup-redeem.ts`) still binds this new
 * user's id to the chat identity as the ONE authoritative link.
 */
export async function createUserForSignup(name: string | null): Promise<User> {
  const [row] = await db.insert(users).values({ name }).returning();
  if (!row) {
    // Unreachable in practice: a bare INSERT ... RETURNING on a table with a
    // server-generated primary key and no unique constraint this call could
    // violate (email is null, not compared). Fail loudly rather than
    // fabricate a user row that would silently diverge from the DB.
    throw new Error("createUserForSignup: insert returned no row");
  }
  return row;
}

/**
 * Insert a database-session row for `userId`, keyed by the EXACT
 * `sessionToken` the caller will also set as the `authjs.session-token` (or
 * `__Secure-`-prefixed, over https) cookie value. NextAuth v5's database
 * session strategy (`packages/auth/src/index.ts`'s `DrizzleAdapter`) looks
 * sessions up by this column's raw value — no hashing on either side (same
 * plain-token contract the `verify-console-ui` skill already relies on for
 * minting a test session) — so whatever this function is given IS the
 * bearer credential from this point on. `sessionToken` generation is
 * entirely the CALLER's responsibility (see `signup-redeem.ts`): this
 * function only ever writes what it is handed, the same "primitive, not
 * policy" split every other setter in this package follows.
 */
export async function createConsoleSession(
  userId: string,
  sessionToken: string,
  expires: Date
): Promise<void> {
  await db.insert(sessions).values({ sessionToken, userId, expires });
}
