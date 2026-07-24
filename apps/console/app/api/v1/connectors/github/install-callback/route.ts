import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  consumeGithubInstallState,
  bindWorkspaceGithubInstallation,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import {
  resolveGithubAppConfig,
  getInstallationAccount,
} from "@agentrail/github-app";

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

  const consumed = await consumeGithubInstallState(state);
  if (!consumed) return dest("/dashboard?github_install=expired");

  const membership = await getWorkspaceMembership(
    session.user.id,
    consumed.workspaceId
  );
  if (!membership) return dest("/dashboard?github_install=forbidden");

  if (!installationId) return dest("/dashboard?github_install=error");

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
  return dest(
    `/dashboard/${consumed.workspaceId}/connectors?github_install=connected`
  );
}
