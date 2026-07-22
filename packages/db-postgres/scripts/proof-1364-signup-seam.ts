/**
 * Hand-run LIVE-DB proof for issue #1364's sign-up seam (PR ①) — the
 * security invariants a mocked-db unit test can only assert the CONTRACT
 * of, not the real atomicity of: single-use consume under an ACTUAL
 * concurrent race, and expiry enforcement, against a real Postgres instance
 * (not the automated `vitest` suite, which never hits live Postgres — see
 * `queries/chat_identities.test.ts` for the mocked-db version of the same
 * assertions).
 *
 * Usage:
 *   cd packages/db-postgres
 *   DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail \
 *     npx tsx scripts/proof-1364-signup-seam.ts
 *
 * Defaults to the same dev DB URL as `db.ts`'s own fallback, but pointed at
 * port 5434 (this repo's dev Postgres — see `.claude/skills/verify-console-ui`)
 * rather than 5432, since that's where a locally-running dev DB actually is.
 *
 * SAFETY (see `test-cleanup-deleted-user-data` — never delete by a
 * non-unique name/label on a live DB): every row this script creates is
 * cleaned up by ITS OWN exact primary key, in `finally`, even on assertion
 * failure. Nothing pre-existing is ever touched, queried by a shared name,
 * or deleted by anything other than the exact id/token this run itself
 * generated.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db.js";
import { chatIdentities } from "../src/schema/chat_identities.js";
import { sessions } from "../src/schema/auth.js";
import {
  setChatIdentitySignupToken,
  consumeChatIdentitySignupToken,
  bindChatIdentityUser,
  getChatIdentityById,
} from "../src/queries/chat_identities.js";
import { createUserForSignup, createConsoleSession } from "../src/queries/signup_account.js";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

async function main() {
  const marker = `signup-proof-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const [identity] = await db
    .insert(chatIdentities)
    .values({
      platform: "signup-proof",
      platformUserId: marker,
      displayName: "Proof User",
    })
    .returning();
  if (!identity) throw new Error("setup: failed to insert the throwaway chat identity");

  let createdUserId: string | null = null;
  let createdSessionToken: string | null = null;

  try {
    console.log(`\nchat_identity under test: ${identity.id} (${marker})\n`);

    // --- AC3: expiry — a token whose expiry is already in the past is
    // rejected exactly like an unknown one, never consumed. ---
    console.log("Expiry enforcement:");
    const expiredToken = `expired-${randomUUID()}`;
    await setChatIdentitySignupToken(identity.id, expiredToken, new Date(Date.now() - 60_000));
    const expiredResult = await consumeChatIdentitySignupToken(expiredToken);
    check("consuming an already-expired token returns null", expiredResult === null);
    const afterExpiredAttempt = await getChatIdentityById(identity.id);
    check(
      "an expired token is left untouched by the failed consume attempt (still sitting in the column)",
      afterExpiredAttempt?.signupToken === expiredToken
    );

    // --- AC3: single-use — consume once (succeeds), consume again (fails). ---
    console.log("\nSingle-use (sequential):");
    const token = `seq-${randomUUID()}`;
    await setChatIdentitySignupToken(identity.id, token, new Date(Date.now() + 30 * 60 * 1000));
    const first = await consumeChatIdentitySignupToken(token);
    check("first consume returns the identity row", first?.id === identity.id);
    check("first consume nulls the token column on the returned row", first?.signupToken === null);
    const second = await consumeChatIdentitySignupToken(token);
    check("second consume of the SAME token returns null (already used)", second === null);

    // --- AC3: single-use under an ACTUAL concurrent race — the proof a
    // mocked-db unit test structurally cannot provide: two real, concurrent
    // UPDATE statements against the SAME row, same token, fired together. ---
    console.log("\nSingle-use (concurrent race — the real atomicity proof):");
    const raceToken = `race-${randomUUID()}`;
    await setChatIdentitySignupToken(identity.id, raceToken, new Date(Date.now() + 30 * 60 * 1000));
    const [raceA, raceB] = await Promise.all([
      consumeChatIdentitySignupToken(raceToken),
      consumeChatIdentitySignupToken(raceToken),
    ]);
    const winners = [raceA, raceB].filter((r) => r !== null);
    const losers = [raceA, raceB].filter((r) => r === null);
    check("EXACTLY ONE of two concurrent consumes wins (never zero, never two)", winners.length === 1);
    check("the other concurrent consume gets null (loses the race, does not double-bind)", losers.length === 1);

    // --- account creation + binding + session mint (server-side, from the
    // token alone) ---
    console.log("\nAccount creation + binding + session mint:");
    const user = await createUserForSignup(identity.displayName);
    createdUserId = user.id;
    check("createUserForSignup creates a real users row with a generated id", typeof user.id === "string" && user.id.length > 0);
    check("createUserForSignup never sets an email (Telegram sign-up carries none)", user.email === null);

    await bindChatIdentityUser(identity.id, user.id);
    const bound = await getChatIdentityById(identity.id);
    check("bindChatIdentityUser lands userId on the identity row", bound?.userId === user.id);

    const sessionToken = `session-proof-${randomUUID()}`;
    createdSessionToken = sessionToken;
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createConsoleSession(user.id, sessionToken, sessionExpires);
    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.sessionToken, sessionToken));
    check("createConsoleSession lands a sessions row keyed by the EXACT raw token (no hashing)", sessionRow?.userId === user.id);
    check("the session row's expires matches what was passed", sessionRow?.expires.getTime() === sessionExpires.getTime());
  } finally {
    // Cleanup — exact PKs only, see module doc-comment's SAFETY note.
    if (createdSessionToken) {
      await db.delete(sessions).where(eq(sessions.sessionToken, createdSessionToken));
    }
    await db.delete(chatIdentities).where(eq(chatIdentities.id, identity.id));
    if (createdUserId) {
      const { users } = await import("../src/schema/auth.js");
      await db.delete(users).where(eq(users.id, createdUserId));
    }
    console.log("\nCleanup: removed the exact rows this run created (session, chat identity, user).");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nSCRIPT ERROR (not an assertion failure):", err);
    process.exit(1);
  });
