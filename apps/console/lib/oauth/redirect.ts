/**
 * OAuth Connect Wave 3, W3-T1 — pure redirect-URL builders for
 * `GET /api/v1/connectors/oauth/callback/[provider]`, and the closed
 * `oauth_error` reason set that route's failure branches report through.
 *
 * Kept OUT of `route.ts` deliberately: the App Router ignores extra
 * `route.ts` exports at runtime, but `next build`'s generated route-type
 * validation REJECTS them — a production build failure `vitest`/`tsc`/the
 * dev server never catch (see 403920ea, "next build rejects extra route
 * exports" — two prod deploys died to exactly this this week). Every
 * `route.ts` in this feature exports ONLY its HTTP verb handler(s); every
 * helper, including this one, lives in a sibling module.
 *
 * `oauth_error` is a CLOSED set (plan pin: "never echoed vendor text") —
 * the callback never forwards a vendor's own error string into the redirect
 * query string, only one of these fixed reasons (seven as of the W3-T2 fix
 * round's `project_not_granted`). Mirrors `lib/evidence/types.ts`'s
 * `EvidenceDegradationReason` closed-set pattern (a type + a matching
 * runtime array) one directory over.
 *
 * `project_not_granted` (W3-T2 fix round, independent review Finding #1,
 * `.superpowers/sdd/review-W3T2.md`): an adapter's `postExchange` hook
 * (`types.ts`) caught the vendor's OAuth grant NOT covering the project/
 * resource the workspace already has configured — e.g. Railway's
 * `project:viewer` scope lets the user pick which project(s) to share on
 * RAILWAY's OWN consent screen, independently of this workspace's stored
 * `railwayProjectId`; without this check, a mismatch could silently
 * connect and later render as an honest-looking-but-wrong "no deployments"
 * on every evidence query rather than a legible error at connect time. The
 * fix (via `postExchange`) closes it BEFORE the credential is ever stored.
 */

export type OauthErrorReason =
  | "state_invalid"
  | "provider_unknown"
  | "provider_unconfigured"
  | "denied"
  | "exchange_failed"
  | "store_failed"
  | "project_not_granted";

/** Every {@link OauthErrorReason}, for runtime membership checks / tests. */
export const OAUTH_ERROR_REASONS: readonly OauthErrorReason[] = [
  "state_invalid",
  "provider_unknown",
  "provider_unconfigured",
  "denied",
  "exchange_failed",
  "store_failed",
  "project_not_granted",
];

/** The connectors page, `?connected=<provider>` — the plan's pinned success
 * redirect. */
export function connectedRedirectUrl(baseUrl: string | URL, workspaceId: string, provider: string): URL {
  const url = new URL(`/dashboard/${workspaceId}/connectors`, baseUrl);
  url.searchParams.set("connected", provider);
  return url;
}

/**
 * The failure redirect. Before a state is successfully consumed, no
 * workspaceId is known yet (a forged/expired/replayed callback hit) — those
 * branches pass `workspaceId: null` and land on the workspace-less
 * `/dashboard` root, mirroring `install-callback/route.ts`'s own
 * `dest("/dashboard?github_install=unlinked")` /
 * `dest("/dashboard?github_install=expired")` precedent exactly. Every
 * later failure (the state DID resolve to a real workspace, but the
 * exchange or the store write failed) passes the resolved `workspaceId` and
 * lands on that workspace's own connectors page, per the plan's pinned
 * "redirects to the connectors page" contract.
 */
export function oauthErrorRedirectUrl(
  baseUrl: string | URL,
  workspaceId: string | null,
  reason: OauthErrorReason
): URL {
  const path = workspaceId ? `/dashboard/${workspaceId}/connectors` : "/dashboard";
  const url = new URL(path, baseUrl);
  url.searchParams.set("oauth_error", reason);
  return url;
}

/**
 * The vendor-facing `redirect_uri` — where the authorize-link route tells
 * the vendor to send the browser back once the human approves. Built from
 * the console's own public base URL (`CONSOLE_PUBLIC_URL`, the SAME env var
 * `slack-oauth.ts`'s `buildSlackRedirectUri` reads for its own callback, and
 * `channel-dispatch.ts`'s `resolveConsolePublicUrl` reads for `/connect`
 * links) — trims whitespace and any trailing slash(es) so a copy-pasted env
 * value with or without a trailing `/` produces the identical URL, mirroring
 * `buildSlackRedirectUri` exactly. This is the EXACT string every provider
 * must be registered with on the vendor side (`https://www.heyjace.com/api/v1/
 * connectors/oauth/callback/railway`, `/sentry`, … — see the spec doc's
 * owner-registration steps).
 */
export function oauthCallbackUri(consolePublicUrl: string, provider: string): string {
  const base = consolePublicUrl.trim().replace(/\/+$/, "");
  return `${base}/api/v1/connectors/oauth/callback/${provider}`;
}
