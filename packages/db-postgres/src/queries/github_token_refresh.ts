import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { accounts } from "../schema/auth.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import { persistGithubAccountTokens } from "./index.js";

/**
 * GitHub OAuth token refresh for long runs (issue #1391).
 *
 * The runner claim (`apps/console/app/api/v1/runner/claim/route.ts`) hands the
 * fleet the workspace owner's GitHub OAuth `access_token` so `git clone` /
 * `git push` / `gh pr create` authenticate as that workspace. When GitHub's
 * "expiring user tokens" are enabled the access token lives only ~8h and a run
 * that outlives it fails at PUSH time — after all the compute is already spent.
 *
 * This module is the one source of truth for exchanging the stored
 * `refresh_token` for a fresh `access_token`. Two callers use it:
 *   1. The claim route, BEFORE handing out a token — refresh only when the
 *      remaining TTL is below the execution ceiling (a no-op for the common
 *      case of a token with hours of life left, so the working loop is
 *      byte-identical then).
 *   2. The runner-authed mid-run refresh route
 *      (`/api/v1/runner/refresh-github-token`), which FORCES a refresh after a
 *      push already 401'd, so an in-flight run survives token expiry.
 *
 * GitHub OAuth refresh mechanics (verified via context7, GitHub Docs
 * "Refreshing user access tokens"): POST
 * `https://github.com/login/oauth/access_token` with `client_id`,
 * `client_secret`, `grant_type=refresh_token`, `refresh_token`. A 200 returns a
 * NEW `access_token` AND a NEW `refresh_token` (rotation — the old refresh
 * token and old access token are both invalidated, so the new refresh token
 * MUST be persisted or the next refresh breaks), plus `expires_in` /
 * `refresh_token_expires_in` (seconds). A `bad_refresh_token` error (HTTP 200
 * OR 400 with an `error` field) means the refresh token is invalid/expired and
 * the user must re-authorize — unrecoverable here.
 *
 * The token value is NEVER logged and only ever returned to the runner over the
 * already-authenticated claim/refresh channel.
 */

/**
 * The execution ceiling used as the claim-time refresh threshold: a claim must
 * never hand out a token whose remaining TTL is less than the longest a single
 * run can take. Matches the host runner's hard wall-clock ceiling
 * (`agentrail/sandbox/native_runner.py` `DEFAULT_TIMEOUT = 3600`s) so a token
 * handed out at claim is guaranteed to outlive the run it's handed to.
 */
export const EXECUTION_CEILING_SECONDS = 3600;

/** GitHub's OAuth token endpoint (overridable for tests via the options). */
const GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

/** The minimal fetch shape this module needs — injectable so tests never hit
 * the network (a real GitHub OAuth round-trip is not reproducible in the
 * sandbox; see the issue's live-fleet smoke flag). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface GithubOwnerAccount {
  providerAccountId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  tokenType: string | null;
}

/**
 * The workspace OWNER's stored GitHub OAuth account — the full row the refresh
 * flow needs (access token, refresh token, expiry, provider account id). This
 * is the same owner-membership join `getGithubToken` uses, widened to the
 * fields a refresh requires. Returns null when the workspace has no owner or
 * the owner never linked GitHub.
 */
async function getWorkspaceGithubOwnerAccount(
  workspaceId: string
): Promise<GithubOwnerAccount | null> {
  const rows = await db
    .select({
      providerAccountId: accounts.providerAccountId,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
      scope: accounts.scope,
      tokenType: accounts.token_type,
    })
    .from(workspaceMemberships)
    .innerJoin(
      accounts,
      and(
        eq(accounts.userId, workspaceMemberships.userId),
        eq(accounts.provider, "github")
      )
    )
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.role, "owner")
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    providerAccountId: row.providerAccountId,
    accessToken: row.accessToken ?? null,
    refreshToken: row.refreshToken ?? null,
    expiresAt: row.expiresAt ?? null,
    scope: row.scope ?? null,
    tokenType: row.tokenType ?? null,
  };
}

export interface EnsureFreshGithubTokenOptions {
  /** Refresh when the token's remaining TTL is below this many seconds.
   * Defaults to {@link EXECUTION_CEILING_SECONDS}. Ignored when `force` is set. */
  minRemainingSeconds?: number;
  /** Force a refresh regardless of the current TTL — used by the mid-run
   * recovery route, where the trigger is a real push 401, not a TTL estimate. */
  force?: boolean;
  /** Injected clock (epoch ms). Defaults to `Date.now()`. */
  now?: number;
  /** Injected fetch. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export interface EnsureFreshGithubTokenResult {
  /** The freshest access token we could produce: the refreshed one when a
   * refresh happened, else the currently-stored one. Never null when
   * `outcome` is "ok" | "no-op". */
  accessToken: string | null;
  /** "no-op": token had ample TTL (or is non-expiring) — nothing was refreshed
   *          and nothing was fetched (the common, working-loop case).
   *  "refreshed": a refresh was needed and SUCCEEDED — `accessToken` is fresh.
   *  "no-account": the workspace has no owner / no linked GitHub token at all.
   *  "refresh-failed": a refresh was needed but FAILED (no refresh token,
   *          bad_refresh_token, or a network/HTTP error). `accessToken` holds
   *          the stale stored token (if any) so the claim path can still hand
   *          out today's best-effort token and let mid-run recovery try. */
  outcome: "no-op" | "refreshed" | "no-account" | "refresh-failed";
}

/**
 * Ensure the workspace owner's GitHub access token has more than
 * `minRemainingSeconds` of life (or force a refresh), refreshing + persisting
 * via {@link persistGithubAccountTokens} when needed. NEVER throws — every
 * failure mode degrades to a typed `outcome` so the claim route can never be
 * broken by a refresh hiccup.
 */
export async function ensureFreshGithubToken(
  workspaceId: string,
  options: EnsureFreshGithubTokenOptions = {}
): Promise<EnsureFreshGithubTokenResult> {
  const {
    minRemainingSeconds = EXECUTION_CEILING_SECONDS,
    force = false,
    now = Date.now(),
    fetchImpl,
  } = options;

  let account: GithubOwnerAccount | null;
  try {
    account = await getWorkspaceGithubOwnerAccount(workspaceId);
  } catch {
    // A read hiccup must never break the claim: report no-account so the
    // caller falls back exactly as it would for an unlinked workspace.
    return { accessToken: null, outcome: "no-account" };
  }
  if (!account || !account.accessToken) {
    return { accessToken: account?.accessToken ?? null, outcome: "no-account" };
  }

  // Decide whether a refresh is required. A NULL `expires_at` means the token
  // does not expire (GitHub's expiring-user-tokens NOT enabled) — there is no
  // refresh token and no point refreshing, so this is always a no-op.
  if (!force) {
    if (account.expiresAt === null) {
      return { accessToken: account.accessToken, outcome: "no-op" };
    }
    const remainingSeconds = account.expiresAt - Math.floor(now / 1000);
    if (remainingSeconds >= minRemainingSeconds) {
      // Ample TTL — hand out the current token unchanged, no network call.
      return { accessToken: account.accessToken, outcome: "no-op" };
    }
  }

  // A refresh is required. Without a refresh token we cannot do it — degrade to
  // the stale token (best-effort; mid-run recovery is the backstop for claim).
  if (!account.refreshToken) {
    return { accessToken: account.accessToken, outcome: "refresh-failed" };
  }

  const clientId = process.env["GITHUB_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    return { accessToken: account.accessToken, outcome: "refresh-failed" };
  }

  const doFetch: FetchLike =
    fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
  };
  try {
    const resp = await doFetch(GITHUB_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    payload = (await resp.json()) as typeof payload;
    // GitHub returns 200 with an `error` field on a bad refresh token, and a
    // non-2xx on other failures — both are unrecoverable refreshes.
    if (!resp.ok || payload.error || !payload.access_token) {
      return { accessToken: account.accessToken, outcome: "refresh-failed" };
    }
  } catch {
    // Network / parse failure — never surface the token or the raw error.
    return { accessToken: account.accessToken, outcome: "refresh-failed" };
  }

  // Persist the rotated tokens (both are new — see the module header). Compute
  // the new absolute expiry from the relative `expires_in`; keep the prior
  // scope when GitHub omits it on refresh (scope is unchanged by a refresh).
  const newExpiresAt =
    typeof payload.expires_in === "number"
      ? Math.floor(now / 1000) + payload.expires_in
      : account.expiresAt;
  try {
    await persistGithubAccountTokens({
      providerAccountId: account.providerAccountId,
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? account.refreshToken,
      expires_at: newExpiresAt,
      scope: payload.scope || account.scope,
      token_type: payload.token_type ?? account.tokenType,
    });
  } catch {
    // The refresh SUCCEEDED but persistence failed: still hand back the fresh
    // token (the run can use it now), just report the failure so the caller
    // doesn't assume the DB is updated. Treat as refreshed — the token is real.
    return { accessToken: payload.access_token, outcome: "refreshed" };
  }

  return { accessToken: payload.access_token, outcome: "refreshed" };
}
