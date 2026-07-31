import { createHash, randomBytes } from "crypto";

/**
 * PKCE (RFC 7636) — the code_verifier/code_challenge pair, generic across
 * every OAuth-capable provider (W3-T2 fix round, independent review
 * upgrade — see `.superpowers/sdd/review-W3T2.md`). Deliberately built
 * SHARED, not Railway-specific: the coordinator's own scope ruling notes
 * Cloudflare's own OAuth (a documented future phase) REQUIRES PKCE, so
 * this plumbing pays for itself twice rather than being retrofitted later.
 * The link route (`connectors/oauth/link/route.ts`) mints a verifier for
 * EVERY oauth connect attempt and always passes the derived challenge into
 * `adapter.authorizeUrl()` — whether a given adapter actually WIRES it into
 * its own authorize URL / token exchange is that adapter's own choice (see
 * `lib/oauth/types.ts`'s `AuthorizeUrlInput.codeChallenge`/
 * `ExchangeInput.codeVerifier` doc-comments), exactly like `ExchangeInput.params`
 * is always populated regardless of whether a specific adapter reads it.
 *
 * S256 only — RFC 7636 also permits a bare "plain" method (the challenge
 * IS the verifier, unhashed), but every provider this codebase targets
 * documents/recommends S256 specifically (Railway's own worked PKCE
 * example uses `code_challenge_method=S256` exclusively,
 * `docs.railway.com/integrations/oauth/creating-an-app`), and "plain"
 * defeats PKCE's own security property (the "challenge" would be fully
 * visible in the authorize redirect, same as having no PKCE at all) — never
 * implemented here.
 */

/**
 * `code_verifier` — RFC 7636 requires 43-128 characters from the unreserved
 * URL-safe charset `[A-Za-z0-9-._~]`. 32 random bytes, base64url-encoded
 * (Node's own `"base64url"` `Buffer` encoding omits `=` padding already —
 * no manual stripping needed), yields exactly 43 characters: the spec's
 * minimum length, and base64url's alphabet (`[A-Za-z0-9\-_]`) is a strict
 * subset of the unreserved charset, so every character is valid by
 * construction.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * `code_challenge`, S256 method: `base64url(sha256(code_verifier))`, per
 * RFC 7636 and confirmed against Railway's own worked PKCE example
 * (`docs.railway.com/integrations/oauth/creating-an-app.md`: `&code_challenge=CODE_CHALLENGE
 * &code_challenge_method=S256`, verifier included as `code_verifier=` at
 * the token-exchange step).
 */
export function computeCodeChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}
