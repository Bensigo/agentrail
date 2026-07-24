import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getConnector,
  getInstallationToken,
  getWorkspaceMembership,
  upsertConnector,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Auto-create the GitHub repo webhook(s) for the onboarding wizard's Connect
 * GitHub step (#1233, spec §5, AC2). An explicit user action ONLY (a button
 * click) — never a page-load side effect, since it writes to an external
 * service (GitHub) using the workspace owner's OAuth token.
 *
 * Generates one webhook secret for the connector, then — best-effort — calls
 * the GitHub API to create a webhook on every repo the connector is
 * configured for, pointed at the existing receiver
 * (`/api/v1/connectors/github/webhook`, unrelated route despite the shared
 * name — that one receives GitHub's deliveries; this one drives GitHub's API
 * to create them). The secret is ALWAYS persisted, even when every GitHub
 * call fails, so the `/setup` UI can render manual "add this webhook
 * yourself" instructions with the same secret as a fallback — and so the
 * step's pure completion signal (`connector has repos + webhookSecret`,
 * `apps/console/lib/onboarding-steps.ts`) is satisfiable even when GitHub is
 * unreachable at connect time.
 */

interface RepoResult {
  repo: string;
  ok: boolean;
  error?: string;
}

function webhookTargetUrl(request: NextRequest): string {
  return `${new URL(request.url).origin}/api/v1/connectors/github/webhook`;
}

async function createHookForRepo(
  repo: string,
  token: string,
  targetUrl: string,
  secret: string
): Promise<RepoResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agentrail-console",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["issues"],
        config: { url: targetUrl, content_type: "json", secret },
      }),
    });
  } catch {
    return { repo, ok: false, error: "Could not reach GitHub." };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const reLink = res.status === 401 || res.status === 403 || res.status === 404;
    return {
      repo,
      ok: false,
      error: reLink
        ? "GitHub denied the request — make sure the Jace GitHub App is installed on this repository, or add the webhook manually below."
        : `GitHub rejected the webhook (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
    };
  }

  return { repo, ok: true };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const connector = await getConnector(workspaceId, "github");
  const repos = connector?.config.repos ?? [];
  if (repos.length === 0) {
    return NextResponse.json(
      { error: "Connect at least one repository before creating a webhook." },
      { status: 422 }
    );
  }

  const secret = randomBytes(24).toString("hex");
  const targetUrl = webhookTargetUrl(request);
  const token = await getInstallationToken(workspaceId);

  const results: RepoResult[] = token
    ? await Promise.all(
        repos.map((repo) => createHookForRepo(repo, token, targetUrl, secret))
      )
    : repos.map((repo) => ({
        repo,
        ok: false,
        error:
          "GitHub is not connected for this workspace — install the Jace GitHub App from Connectors first.",
      }));

  // Persist the secret regardless of outcome (see module doc): the manual
  // fallback and the step's completion signal both depend on it existing.
  await upsertConnector(workspaceId, "github", { config: { webhookSecret: secret } });

  const allOk = results.every((r) => r.ok);

  return NextResponse.json({
    ok: allOk,
    secret,
    results,
    manual: {
      url: targetUrl,
      secret,
      contentType: "application/json",
      events: ["issues"],
    },
  });
}
