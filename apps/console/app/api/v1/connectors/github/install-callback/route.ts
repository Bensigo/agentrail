import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  consumeGithubInstallState,
  bindWorkspaceGithubInstallation,
  getWorkspaceMembership,
  upsertConnector,
  getUserGithubAccessTokenById,
} from "@agentrail/db-postgres";
import {
  resolveGithubAppConfig,
  getInstallationAccount,
  listUserInstallationIds,
} from "@agentrail/github-app";

// installation_id arrives as a query param — GitHub's real IDs are numeric,
// but nothing stops a forged request from sending anything. Reject non-
// numeric shapes before they ever reach a GitHub call or the ownership gate.
const NUMERIC_ID = /^\d+$/;

/**
 * GET /api/v1/connectors/github/install-callback — the GitHub App's ONE
 * global Setup URL (spec §5: it cannot be workspace-scoped; the workspace
 * travels exclusively in the single-use `state` token).
 *
 * Order matters: auth FIRST, then consume. A signed-out hit redirects to
 * /login without burning the single-use state (the magic-link-over-chat
 * lesson: never consume a single-use token on a GET that isn't the real
 * redemption). Installs started directly on github.com/apps/<slug> arrive
 * with no state at all — those get a "finish from workspace settings"
 * redirect, never a guessed workspace.
 *
 * ANTI-IDOR: `state` alone only proves the caller intended to install
 * GitHub for a workspace they're a member of — it says NOTHING about which
 * GitHub installation they actually own. `installation_id` is a caller-
 * supplied, low-entropy, sequential query param, and
 * `getInstallationAccount` authenticates as the APP (not the user) and will
 * happily return data for ANY installation of the App. Without a separate
 * ownership check, an attacker who is an admin of their OWN workspace can
 * mint a legit `state` there, then forge this GET with a victim's
 * `installation_id` and bind the victim's installation to the attacker's
 * workspace. The ownership gate below — `getUserGithubAccessTokenById` +
 * `listUserInstallationIds` — is the actual anti-IDOR boundary: it proves
 * the CALLER's own GitHub login token can see this installation before any
 * bind is allowed to happen.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state")?.trim() ?? "";
  const installationId = params.get("installation_id")?.trim() ?? "";
  const dest = (path: string) =>
    NextResponse.redirect(new URL(path, request.url), { status: 302 });

  if (!state) return dest("/dashboard?github_install=unlinked");

  const session = await auth();
  if (!session?.user?.id) return dest("/login");

  // Consuming BEFORE the ownership check below is deliberate anti-probing
  // posture: each forged attempt burns a single-use state the attacker must
  // re-mint (from their own workspace) before trying again, rather than
  // letting installation ids be probed for free against one live state.
  const consumed = await consumeGithubInstallState(state);
  if (!consumed) return dest("/dashboard?github_install=expired");

  const membership = await getWorkspaceMembership(
    session.user.id,
    consumed.workspaceId
  );
  if (!membership) return dest("/dashboard?github_install=forbidden");

  if (!installationId) return dest("/dashboard?github_install=error");
  if (!NUMERIC_ID.test(installationId)) {
    return dest("/dashboard?github_install=error");
  }

  // Ownership gate (anti-IDOR): confirm the CALLER's own GitHub login token
  // can see this installation_id before allowing any bind. Fails CLOSED on
  // every branch except an explicit "yes, it's in the caller's list".
  const loginToken = await getUserGithubAccessTokenById(session.user.id);
  if (!loginToken) return dest("/dashboard?github_install=verify_failed");

  const owned = await listUserInstallationIds(loginToken);
  if (!owned.ok) {
    // "unauthorized" = the caller's stored login token itself is stale/
    // expired/revoked (sign out/in and retry) — distinct reason, same fail-
    // closed redirect as any other ownership-check failure (network hiccup,
    // GitHub rejection): never bind on anything short of a verified "yes".
    return dest("/dashboard?github_install=verify_failed");
  }
  if (!owned.ids.includes(installationId)) {
    // Forged id and a genuinely foreign installation get the identical
    // treatment — this redirect must never distinguish "not yours" from
    // "doesn't exist" (anti-enumeration).
    return dest("/dashboard?github_install=forbidden");
  }

  // Capture account login/type once so create_repo can branch org-vs-personal
  // without a live GitHub call (spec §2). Best-effort on the account fetch:
  // a GitHub hiccup here must not lose the installation binding.
  let accountLogin = "";
  let accountType = "User";
  const cfg = resolveGithubAppConfig(process.env);
  if (cfg.ok) {
    const account = await getInstallationAccount(installationId, {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
    });
    if (account.ok) {
      accountLogin = account.login;
      accountType = account.type;
    }
  }
  await bindWorkspaceGithubInstallation(consumed.workspaceId, {
    installationId,
    accountLogin,
    accountType,
  });

  // Self-configure the github connector row (same idiom as runner/repos/route.ts
  // step 1b and the webhook route's upsertConnector call) so the Connectors
  // page's GithubManage card — driven by the connectors GET route's installed
  // check — flips to "connected" right away, instead of dead-ending on the
  // pre-install copy until a repo happens to get linked separately.
  // Best-effort: a write failure here must NEVER lose the installation binding
  // above or change this redirect — the callback already did the thing that
  // matters.
  try {
    await upsertConnector(consumed.workspaceId, "github", { enabled: true });
  } catch (err) {
    console.error(
      "[install-callback] failed to self-configure the github connector row:",
      err
    );
  }

  return dest(
    `/dashboard/${consumed.workspaceId}/connectors?github_install=connected`
  );
}
