/**
 * Session-cookie naming/config for a directly-minted NextAuth database
 * session (issue #1364's sign-up redemption — `signup-redeem.ts` mints the
 * DB row, the `/signup/[token]` page's Server Action sets the cookie).
 * Mirrors Auth.js's own `defaultCookies` algorithm EXACTLY
 * (`useSecureCookies ? "__Secure-" : ""` name prefix, httpOnly,
 * sameSite=lax, path=/, secure=useSecureCookies) so a session this package
 * inserts directly into `sessions` is found by `auth()`'s own read path
 * with no special-casing on that side — from the framework's perspective
 * this must look exactly like a cookie IT set after an ordinary OAuth
 * sign-in.
 *
 * `packages/auth/src/index.ts` configures no explicit `NEXTAUTH_URL`/
 * `AUTH_URL` (see connect-link/route.ts's doc-comment: "no NEXTAUTH_URL/
 * AUTH_URL/APP_URL env exists in this deploy"), so — matching what Auth.js
 * itself falls back to (`config.useSecureCookies ?? url.protocol ===
 * "https:"`) — `useSecureCookies` is derived from the CURRENT request's own
 * protocol. `resolveUseSecureCookiesFromHeaders` below is how a Server
 * Action gets that signal: unlike a Route Handler (which reads
 * `request.nextUrl.protocol` directly off its own `NextRequest`, the
 * pattern `connect-link`/`runner/workspaces` use to build a public origin),
 * a Server Action has no `NextRequest` object of its own — `next/headers`'s
 * `headers()` is the documented way to read the incoming request's headers
 * from inside one, so this reads `x-forwarded-proto` (the standard signal a
 * reverse proxy sets, including Railway in front of this deploy) off that.
 * In local dev (no proxy in front of `next dev`, header absent) this
 * resolves to the unprefixed `authjs.session-token` name the
 * `verify-console-ui` skill already documents minting directly; in
 * production (proxy sets `x-forwarded-proto: https`) it resolves to
 * `__Secure-authjs.session-token`, matching what a real GitHub sign-in
 * would set on the same deployment.
 */

export const SESSION_COOKIE_BASE_NAME = "authjs.session-token";

export function sessionCookieName(useSecureCookies: boolean): string {
  return useSecureCookies
    ? `__Secure-${SESSION_COOKIE_BASE_NAME}`
    : SESSION_COOKIE_BASE_NAME;
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  expires: Date;
}

export function sessionCookieOptions(
  useSecureCookies: boolean,
  expires: Date
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: useSecureCookies,
    expires,
  };
}

/**
 * Resolve `useSecureCookies` from the CURRENT request's `x-forwarded-proto`
 * header (see the module comment above for why a Server Action needs
 * `next/headers` rather than a `NextRequest`). A comma-separated value
 * (some proxy chains append one hop per proxy) uses only the first —
 * the client-facing hop, which is the one that determines what the
 * BROWSER actually connected over. Missing header (local dev, no proxy in
 * front of `next dev`) defaults to `false` (insecure/unprefixed), matching
 * this deploy's own local-dev posture.
 */
export async function resolveUseSecureCookiesFromHeaders(): Promise<boolean> {
  // Dynamic import, deliberately: `sessionCookieName`/`sessionCookieOptions`
  // above are plain, Next-independent pure functions (their own tests never
  // touch `next/headers`) — importing `next/headers` at module top-level
  // would make EVERY import of this file, including for those two, drag in
  // a Next.js-request-context dependency it doesn't need. Scoping the
  // import to this one function keeps that coupling local to the one
  // function that actually requires request context.
  const { headers } = await import("next/headers");
  const requestHeaders = await headers();
  const proto = requestHeaders.get("x-forwarded-proto");
  if (!proto) return false;
  return proto.split(",")[0]?.trim().toLowerCase() === "https";
}
