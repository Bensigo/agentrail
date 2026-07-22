/**
 * Shared sign-up-link MINT primitive (issue #1364) — the one place that
 * generates a token + TTL and writes it via `setChatIdentitySignupToken`.
 * Two callers share this: `POST /api/v1/runner/signup-link/route.ts` (a
 * standalone mint, mirroring `send_connect_link`'s reach into
 * `connect-link`) and `POST /api/v1/runner/workspaces/route.ts` (issue #1364
 * PR ②'s wire-in — `create_workspace` triggers a mint in-process, no HTTP
 * round trip to itself, when it hits an unbound sender). Neither caller
 * duplicates the token-generation/TTL logic; each owns its OWN eligibility
 * check around the call (they differ slightly in what they do on
 * "ineligible" — a 404 vs. folding into a 409 — so that stays with each
 * route, not here).
 */
import { randomBytes } from "node:crypto";
import { setChatIdentitySignupToken } from "@agentrail/db-postgres";

// Same sizing rationale as connect-link/route.ts's LINK_TOKEN_BYTES: 24
// bytes -> 48 hex chars, comfortably over the 32-char floor, sized for an
// unguessable-over-chat link rather than a session-grade secret (see
// `signup-redeem.ts`'s SESSION_TOKEN_BYTES for that larger class).
const SIGNUP_TOKEN_BYTES = 24;
const SIGNUP_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface MintedSignupLink {
  url: string;
  expiresAt: Date;
}

/**
 * Mint a one-time sign-up token for `chatIdentityId` and build its
 * redemption URL from `origin` (the caller's own request origin — see
 * connect-link/route.ts's doc-comment for why this is built from the
 * incoming request rather than an env var in this deploy).
 *
 * NO eligibility check here by design — callers resolve + gate eligibility
 * themselves before calling this (see the module comment above); this
 * function only ever performs the mint write once a caller has already
 * decided to.
 */
export async function mintSignupLink(
  chatIdentityId: string,
  origin: string
): Promise<MintedSignupLink> {
  const signupToken = randomBytes(SIGNUP_TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_TTL_MS);
  await setChatIdentitySignupToken(chatIdentityId, signupToken, expiresAt);
  return { url: `${origin}/signup/${signupToken}`, expiresAt };
}
