/**
 * Session-cookie naming/config for a directly-minted NextAuth database
 * session (issue #1364's sign-up redemption — `signup-redeem.ts` mints the
 * DB row, the route sets the cookie). Mirrors Auth.js's own `defaultCookies`
 * algorithm EXACTLY (`useSecureCookies ? "__Secure-" : ""` name prefix,
 * httpOnly, sameSite=lax, path=/, secure=useSecureCookies) so a session this
 * package inserts directly into `sessions` is found by `auth()`'s own read
 * path with no special-casing on that side — from the framework's
 * perspective this must look exactly like a cookie IT set after an ordinary
 * OAuth sign-in.
 *
 * `packages/auth/src/index.ts` configures no explicit `NEXTAUTH_URL`/
 * `AUTH_URL` (see connect-link/route.ts's doc-comment: "no NEXTAUTH_URL/
 * AUTH_URL/APP_URL env exists in this deploy"), so — matching what Auth.js
 * itself falls back to (`config.useSecureCookies ?? url.protocol ===
 * "https:"`) — `useSecureCookies` here is derived from THIS request's own
 * protocol, the exact same signal `new URL(request.url).origin` already
 * leans on elsewhere in this codebase (connect-link, runner/workspaces) to
 * build a correct public URL. In local dev (http) this resolves to the
 * unprefixed `authjs.session-token` name the `verify-console-ui` skill
 * already documents minting directly; in production (https) it resolves to
 * `__Secure-authjs.session-token`, matching what a real GitHub sign-in would
 * set on the same deployment.
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
