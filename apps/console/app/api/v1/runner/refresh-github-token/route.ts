import { NextRequest, NextResponse } from "next/server";
import { getInstallationToken, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * Runner-authed mid-run GitHub token refresh (issue #1391; GitHub App swap
 * spec: docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md
 * §5/§6).
 *
 * The claim route now hands out a freshly minted installation token on EVERY
 * claim (no OAuth refresh-token exchange left to do at claim time), so this
 * endpoint is the IN-FLIGHT backstop only: when a run's push still 401s (an
 * installation token's 1h TTL expired mid-run), the fleet worker calls this
 * ONCE and retries the push with a fresh mint, so an in-flight run survives
 * token expiry instead of burning a full attempt's budget for a non-code
 * reason.
 *
 * Authenticated EXACTLY like `/api/v1/runner/claim` and `/api/v1/runner/result`
 * — the same machine bearer token (an `api_keys` row), same
 * workspace-ownership check. Installation tokens are minted fresh from
 * GitHub on every call (spec §2: no caching, no OAuth refresh-token exchange)
 * and returned over this already-authenticated channel only — the token is
 * never logged.
 *
 * Responses:
 *   200 `{ github_token: "<token>" }` — a fresh installation token minted.
 *        The runner retries the push with this token.
 *   502 `{ error: "refresh_failed" }` — the mint is UNRECOVERABLE (no GitHub
 *        App installation bound to this workspace, App env unconfigured,
 *        GitHub unreachable, or the App was uninstalled). The runner records
 *        a DISTINCT infrastructure-error classification instead of a
 *        generic red (#1391 AC3).
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

  // Mint a fresh installation token — the caller only reaches here after a
  // push already failed auth, so we never want to hand back a cached value
  // (there is none: getInstallationToken never caches, spec §2). Workspace
  // comes from the bearer key (auth.workspaceId), never the request body.
  const token = await getInstallationToken(auth.workspaceId);

  if (token) {
    return NextResponse.json({ github_token: token });
  }

  // null: no installation bound, App env unconfigured, GitHub unreachable, or
  // the App was uninstalled — the run cannot recover its GitHub auth. Return
  // a distinct signal (never the token, never the underlying reason) so the
  // runner records the infra classification.
  return NextResponse.json({ error: "refresh_failed" }, { status: 502 });
}
