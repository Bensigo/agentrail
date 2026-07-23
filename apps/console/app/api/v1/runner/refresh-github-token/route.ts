import { NextRequest, NextResponse } from "next/server";
import { ensureFreshGithubToken, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * Runner-authed mid-run GitHub token refresh (issue #1391).
 *
 * The claim route already refreshes-on-claim so a handed-out token outlives the
 * execution ceiling. This endpoint is the IN-FLIGHT backstop: when a run's push
 * still 401s (a token that expired mid-run, or a claim that couldn't refresh),
 * the fleet worker calls this ONCE and retries the push with the fresh token,
 * so an in-flight run survives token expiry instead of burning a full attempt's
 * budget for a non-code reason.
 *
 * Authenticated EXACTLY like `/api/v1/runner/claim` and `/api/v1/runner/result`
 * — the same machine bearer token (an `api_keys` row), same
 * workspace-ownership check. It FORCES a refresh (the trigger is a real push
 * 401, not a TTL estimate) and returns the fresh access token over this
 * already-authenticated channel only — the token is never logged.
 *
 * Responses:
 *   200 `{ github_token: "<token>" }` — refresh succeeded (or the stored token
 *        was already usable). The runner retries the push with this token.
 *   502 `{ error: "refresh_failed" }` — the refresh is UNRECOVERABLE (no
 *        refresh token, `bad_refresh_token`, network/HTTP error, or no linked
 *        GitHub owner). The runner records a DISTINCT infrastructure-error
 *        classification instead of a generic red (#1391 AC3).
 *   401 / 403 / 400 — bad bearer / workspace mismatch / missing workspace_id.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json().catch(() => ({}))) as {
    workspace_id?: string;
  };
  const workspaceId = body.workspace_id;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspaceId) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  // Force a refresh — the caller only reaches here after a push already failed
  // auth, so we never want to hand back the same stale token. NEVER throws.
  const fresh = await ensureFreshGithubToken(workspaceId, { force: true });

  if (
    (fresh.outcome === "refreshed" || fresh.outcome === "no-op") &&
    fresh.accessToken
  ) {
    return NextResponse.json({ github_token: fresh.accessToken });
  }

  // "refresh-failed" or "no-account": the run cannot recover its GitHub auth.
  // Return a distinct signal (never the token, never the underlying error) so
  // the runner records the infra classification.
  return NextResponse.json({ error: "refresh_failed" }, { status: 502 });
}
