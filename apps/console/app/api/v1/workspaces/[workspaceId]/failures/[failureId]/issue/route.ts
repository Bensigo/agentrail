import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getGithubToken,
  getRepository,
} from "@agentrail/db-postgres";
import { getFailureById, type FailureEventRecord } from "@agentrail/db-clickhouse";
import { parseGithubSlug } from "@/(dashboard)/dashboard/[workspaceId]/failures/[failureId]/github-slug";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; failureId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId, failureId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let failure;
  try {
    failure = await getFailureById(workspaceId, failureId);
  } catch {
    return NextResponse.json({ error: "Failed to load failure" }, { status: 502 });
  }
  if (!failure) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
  };

  return createGithubIssue(workspaceId, failure, body);
}

async function createGithubIssue(
  workspaceId: string,
  failure: FailureEventRecord,
  body: { title?: string; body?: string }
): Promise<NextResponse> {
  if (!failure.repository_id) {
    return NextResponse.json(
      { error: "This failure has no associated repository to file an issue against." },
      { status: 422 }
    );
  }
  const repo = await getRepository(workspaceId, failure.repository_id);
  if (!repo) {
    return NextResponse.json(
      { error: "Repository not found for this failure." },
      { status: 422 }
    );
  }
  const slug = parseGithubSlug(repo.url);
  if (!slug) {
    return NextResponse.json(
      { error: `Repository URL is not a GitHub repo: ${repo.url}` },
      { status: 422 }
    );
  }

  const token = await getGithubToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      {
        error:
          "No GitHub access token for this workspace. The owner must link GitHub (with repo scope) first.",
      },
      { status: 422 }
    );
  }

  const title =
    body.title?.trim() ||
    `[${failure.failure_type}] ${truncate(failure.message, 80)}`;
  const issueBody = body.body?.trim() || markdownBody(failure);

  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "agentrail-console",
        },
        body: JSON.stringify({ title, body: issueBody }),
      }
    );
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 401 = the OAuth token is invalid/expired or was issued before `repo`
    // scope was granted; 403/404 = present but lacking repo access. Both are
    // fixed by re-linking GitHub, so say so plainly instead of "HTTP 401".
    const reLink =
      res.status === 401 || res.status === 403 || res.status === 404;
    return NextResponse.json(
      {
        error: reLink
          ? "GitHub denied the request — your GitHub authorization is missing repository access (the `repo` scope). Sign out and sign in again with GitHub to grant it, then retry."
          : `GitHub rejected the issue (HTTP ${res.status}).`,
        detail: detail.slice(0, 500),
      },
      { status: 502 }
    );
  }

  const created = (await res.json()) as { html_url?: string; number?: number };
  return NextResponse.json({
    ok: true,
    target: "github",
    url: created.html_url ?? null,
    number: created.number ?? null,
  });
}

function markdownBody(failure: FailureEventRecord): string {
  return [
    `**Failure type:** \`${failure.failure_type}\``,
    `**Severity:** ${failure.severity}`,
    `**Phase:** ${failure.phase}`,
    `**Run:** ${failure.run_id}`,
    "",
    "### Message",
    failure.message,
    "",
    "### Evidence",
    "```",
    truncate(failure.evidence ?? "", 5000),
    "```",
    "",
    `_Filed from the AgentRail console failure ${failure.event_id}._`,
  ].join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
