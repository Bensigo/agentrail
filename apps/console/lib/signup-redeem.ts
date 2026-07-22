/**
 * Pure(ish) redemption core for the `/signup/[token]` magic link (issue
 * #1364, PR ①) — split out from the route handler for the same reason
 * `connect-bind-decision.ts` / `connect-owner-elect-completion.ts` are split
 * from `/connect/[token]/page.tsx`: the security-critical logic needs to be
 * unit-testable without a real request, a real cookie jar, or a database.
 * The route (`route.ts`) is a thin wrapper: call this, then translate the
 * result into an HTTP response + a `Set-Cookie` header.
 *
 * ## What this closes (spec: issue #1364)
 *
 * Today an unrecognized Telegram sender can chat with Jace (the intro-
 * conversation path, issue #1261/#1262) but has no account: `chat_identities`
 * maps a KNOWN sender to a user + workspace, but nothing MINTS a user for a
 * first-time one. This is the mint: redeeming a valid, unexpired, single-use
 * sign-up token creates (or, on a race/replay, reuses) a real `users` row,
 * binds the ORIGINATING chat identity to it, and hands back a database
 * session token the route sets as the `authjs.session-token` cookie — a
 * genuine, usable console login, with NO GitHub OAuth round trip. (GitHub
 * connect — issue #1263's `/connect/[token]` — remains a separate, later
 * upgrade path for the same identity; this flow never touches it.)
 *
 * ## AC3 (SECURITY — the crux): where the bound telegram identity comes from
 *
 * This function's ONLY input is the opaque token string. There is no second
 * parameter for "which chat identity", "which platform", or "which user" —
 * structurally, nothing here CAN accept a caller-supplied identity, so there
 * is nothing for a redeemer (browser, script, replayed request) to override.
 * The identity is entirely resolved server-side, from whatever row
 * `consumeChatIdentitySignupToken` — an atomic UPDATE keyed on the token
 * column alone — happens to match. The token itself was only ever handed out
 * by `POST /api/v1/runner/signup-link` to the trusted Jace-coordinator caller
 * (`requireJaceConsoleSecret`), which resolves the identity to mint FOR from
 * `eveSessionId` (Eve's own session id, never model-supplied — see that
 * route's doc-comment for the full chain). So the identity a token redeems to
 * is fixed at MINT time, by trusted server context, long before any redeemer
 * shows up.
 *
 * ## Single-use / expiry (AC3)
 *
 * `consumeChatIdentitySignupToken` is ONE UPDATE ... RETURNING statement that
 * checks token equality AND expiry AND nulls the token columns all in the
 * same statement (see that function's own doc-comment in
 * `queries/chat_identities.ts`) — there is no read-then-write window a
 * concurrent (double-click) redemption could land in. A second, concurrent
 * call with the same token always sees the columns already nulled and gets
 * `null` back — this function's very first line — before it does ANYTHING
 * else: no second user, no second bind, no second session. An expired token
 * fails the same guard and is rejected the same way. All three failure
 * modes — expired, already-used, never-existed — collapse into the SAME
 * `{ kind: "expired_or_used" }` result, same anti-enumeration posture as
 * `/connect/[token]`'s "expired or already used" screen (spec §4.2 AC3):
 * never leak which case it was.
 *
 * ## Existing-user reuse (idempotent, not a hijack)
 *
 * `identity.userId` can already be non-null at redemption time — e.g. a
 * SECOND sign-up token minted and redeemed for the same identity (the mint
 * route's own eligibility check should prevent this in the steady state, but
 * this function does not trust that alone), or the identity independently
 * completed a GitHub connect (`/connect/[token]`) in the gap between mint and
 * redemption. Either way there is already a real, legitimate user this
 * identity belongs to — server-resolved from the SAME consumed row, not from
 * anything the redeemer supplies — so this reuses it (mints a fresh session
 * for that existing user) rather than creating a second, orphaned account.
 * This is deliberately NOT the connect flow's `foreign_user` guard: that
 * guard exists because the connect page compares the token's identity
 * against an INDEPENDENTLY established signed-in session (a real second
 * credential that could disagree). This flow has no such second credential —
 * there is nothing else to cross-check against — so "identity already has a
 * user" can only mean "this identity's own account", never someone else's.
 *
 * ## Owner-elect completion (issue #1264 interop)
 *
 * `identity.workspaceId` captured here is the value from BEFORE this
 * redemption's own writes (the token consume's own `.returning()`). Non-null
 * covers the legacy/edge case where a workspace already got bound to this
 * identity via the pre-#1364 owner-elect auto-creation path (issue #1264,
 * still reachable directly against `POST /api/v1/runner/workspaces` for an
 * already-user-linked identity — see that route's updated doc-comment) before
 * this sign-up token was ever redeemed. Reuses `completeConnectOwnerElect`
 * verbatim (workspace/user pair in, `{completed, workspaceName}` out) — same
 * safe-to-call-unconditionally contract as the connect page's own use of it.
 */

import { randomBytes } from "node:crypto";
import {
  consumeChatIdentitySignupToken,
  createUserForSignup,
  createConsoleSession,
  bindChatIdentityUser,
} from "@agentrail/db-postgres";
import {
  completeConnectOwnerElect,
  buildOwnerElectCompletionLine,
} from "./connect-owner-elect-completion";
import { sendSignupConfirmation } from "./signup-confirmation";

// 32 bytes -> 64 hex chars: generous entropy for a bearer credential that
// authenticates a real console session (a materially higher-stakes secret
// than the 24-byte connect/signup MINT tokens — this IS the session, not a
// one-time redemption ticket for one), mirroring the size class NextAuth's
// own `generateSessionToken` uses (a random UUID/32-byte-equivalent) rather
// than the shorter LINK_TOKEN_BYTES idiom from connect-link/route.ts.
const SESSION_TOKEN_BYTES = 32;

// 30 days: mirrors Auth.js's own default database-session `maxAge`
// (`packages/auth/src/index.ts` sets no explicit `session.maxAge`, so the
// framework default applies) — a freshly minted session should carry the
// SAME lifetime an ordinary GitHub sign-in would get, not a bespoke shorter
// or longer one.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SignupRedeemResult =
  | { kind: "expired_or_used" }
  | {
      kind: "signed_up";
      sessionToken: string;
      sessionExpires: Date;
      accountLabel: string;
      ownerElectCompletionLine: string | null;
    };

/**
 * Redeem a sign-up token end to end. Never throws on an invalid/expired
 * token (returns `{ kind: "expired_or_used" }`); a genuine DB failure on the
 * WRITE side (user creation, session insert) still propagates — unlike the
 * best-effort in-thread confirmation, a failure there means the account
 * write may not have completed and the caller (the route) must not claim
 * success.
 */
export async function redeemSignupToken(token: string): Promise<SignupRedeemResult> {
  // AC3: this is the ONE server-side source of truth for "which telegram
  // identity does this token belong to" — see the module comment above.
  const identity = await consumeChatIdentitySignupToken(token);
  if (!identity) return { kind: "expired_or_used" };

  let userId: string;
  if (identity.userId != null) {
    // Idempotent reuse — see module comment's "Existing-user reuse" section.
    userId = identity.userId;
  } else {
    const user = await createUserForSignup(identity.displayName);
    userId = user.id;
    await bindChatIdentityUser(identity.id, userId);
  }

  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const sessionExpires = new Date(Date.now() + SESSION_TTL_MS);
  await createConsoleSession(userId, sessionToken, sessionExpires);

  // Owner-elect completion (issue #1264 interop) — see module comment.
  // Never throws (completeConnectOwnerElect's own contract); a failure here
  // degrades to a nameless/no completion line, never blocks the sign-up
  // itself (the account + session are already real by this point).
  const ownerElectCompletion = await completeConnectOwnerElect({
    workspaceId: identity.workspaceId,
    userId,
  });
  const ownerElectCompletionLine = buildOwnerElectCompletionLine(ownerElectCompletion);

  const accountLabel = identity.displayName ?? "there";

  // Fire-and-forget, best-effort — same posture as the connect page's own
  // confirmation send: this function's success must never depend on a
  // Telegram round trip settling. The route wraps this call too (belt and
  // suspenders), but the `.catch` here is the primary guard.
  void sendSignupConfirmation({
    chatIdentityId: identity.id,
    accountLabel,
    ownerElectCompletion,
  }).catch(() => {});

  return {
    kind: "signed_up",
    sessionToken,
    sessionExpires,
    accountLabel,
    ownerElectCompletionLine,
  };
}
