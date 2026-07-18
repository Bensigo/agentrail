import { NextRequest, NextResponse } from "next/server";
import {
  claimQueueEntry,
  touchApiKeyLastUsed,
  hasActiveSelfHostedRunner,
  getMcpConnectorKeys,
  getGithubToken,
} from "@agentrail/db-postgres";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * Runner work-claim. Bearer-authenticated with the runner token (an api_key).
 * Atomically claims the oldest `queued` queue entry for the workspace and flips
 * it to `running`, returning it as a WorkItem. 204 (empty) when nothing queued.
 *
 * Self-hosted precedence (#1267 PR ①, Locked-5): a `kind: 'fleet'` bearer (the
 * hosted fleet, minted by POST /api/v1/fleet/workspace-tokens/sync) backs off
 * with a plain 204 whenever the workspace has an active self-hosted runner —
 * a live self-hosted runner always wins its own workspace's queue; the fleet
 * only serves workspaces with none (or a gone-stale one). "Active" is the
 * same `hasActiveRunner` heuristic used elsewhere, narrowed to
 * kind='self_hosted' (see hasActiveSelfHostedRunner's own doc-comment): a
 * non-revoked key whose `last_used_at` is within the last hour. A self-hosted
 * runner that died without revoking its key still shadows the workspace from
 * the fleet for up to that window — accepted v1 behavior; an operator who
 * wants the fleet to pick up slack immediately would need to revoke the dead
 * key rather than wait it out. `kind: 'self_hosted'` bearers (and any future
 * non-'fleet' kind) are byte-identical to pre-#1267 behavior: this guard runs
 * ONLY when `auth.kind === 'fleet'`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
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

  if (auth.kind === "fleet" && (await hasActiveSelfHostedRunner(workspaceId))) {
    return new NextResponse(null, { status: 204 });
  }

  const item = await claimQueueEntry(workspaceId);
  if (!item) {
    return new NextResponse(null, { status: 204 });
  }

  // Timeline state marker: the run has started (best-effort).
  await recordRunLifecycleEvent(
    workspaceId,
    item.id,
    "run_started",
    `Claimed ${item.external_id} — running locally`
  );

  // Hand the run its connected MCP keys (decrypted here, over the authenticated
  // link) so the runner can write the agent's MCP config into the cloned repo —
  // the codebase-level half of MCP connectors. Empty {} when none are connected.
  // Best-effort: a key-fetch hiccup must not block dispatching the work.
  let mcpKeys: Record<string, string> = {};
  try {
    mcpKeys = await getMcpConnectorKeys(workspaceId);
  } catch (err) {
    console.error("[runner/claim] failed to load MCP keys:", err);
  }

  // Hand the run the workspace's connected GitHub OAuth token (the same token
  // getGithubToken already resolves for the heartbeat's GitHub polling) so the
  // runner can authenticate `git clone`/`git push`/`gh pr create` for THIS
  // workspace's repo over the already-authenticated claim link — no separately
  // configured PAT required. "" when the workspace owner hasn't linked GitHub
  // (or the stored token is null); the runner then falls back to its own
  // locally configured GIT_TOKEN, if any (back-compat).
  //
  // NOTE: this is the OAuth access_token NextAuth persisted at login — it can
  // expire and there is no refresh flow here (out of scope for this fix). An
  // expired token surfaces as an ordinary git/gh auth failure on the runner
  // side. Never logged: only caught error OBJECTS are logged below, never the
  // token value itself.
  let githubToken = "";
  try {
    githubToken = (await getGithubToken(workspaceId)) ?? "";
  } catch (err) {
    console.error("[runner/claim] failed to load GitHub token:", err);
  }

  return NextResponse.json({
    ...item,
    mcp_keys: mcpKeys,
    github_token: githubToken,
  });
}
