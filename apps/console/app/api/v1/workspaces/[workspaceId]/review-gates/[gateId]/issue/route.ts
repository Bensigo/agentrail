import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getGithubToken,
  getRepository,
  getConnector,
  getConnectorSecret,
  getReviewGate,
  getRun,
} from "@agentrail/db-postgres";
import {
  buildFindingIssue,
  type ReviewGateFinding,
} from "@/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

// Inlined here because the failures route's github-slug helper is not a
// committed shared module on this branch.
function parseGithubSlug(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; gateId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId, gateId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    findingIndex?: number;
    target?: string;
    title?: string;
    body?: string;
  };

  const gate = await getReviewGate(workspaceId, gateId);
  if (!gate) {
    return NextResponse.json({ error: "Review gate not found" }, { status: 404 });
  }
  const findings = (gate.findings ?? []) as ReviewGateFinding[];
  const idx = body.findingIndex ?? -1;
  const finding = findings[idx];
  if (!finding) {
    return NextResponse.json(
      { error: "Finding not found at that index" },
      { status: 404 }
    );
  }

  // runs has no PR-URL column on this branch, so fall back to a run reference.
  const prUrl = `run ${gate.runId}`;
  const built = buildFindingIssue(finding, {
    runId: gate.runId,
    prUrl,
    gateId,
    index: idx,
  });
  const title = body.title?.trim() || built.title;
  const issueBody = body.body?.trim() || built.body;

  let target: "github" | "linear" | null =
    body.target === "github" || body.target === "linear" ? body.target : null;
  if (!target) {
    const linear = await getConnector(workspaceId, "linear");
    target = linear && linear.enabled && linear.hasSecret ? "linear" : "github";
  }

  return target === "linear"
    ? createLinearIssue(workspaceId, title, issueBody)
    : createGithubIssue(workspaceId, gate.runId, title, issueBody);
}

async function createGithubIssue(
  workspaceId: string,
  runId: string,
  title: string,
  issueBody: string
): Promise<NextResponse> {
  const run = await getRun(workspaceId, runId).catch(() => null);
  if (!run?.repositoryId) {
    return NextResponse.json(
      {
        error:
          "This run has no associated repository to file an issue against.",
      },
      { status: 422 }
    );
  }
  const repo = await getRepository(workspaceId, run.repositoryId);
  if (!repo) {
    return NextResponse.json({ error: "Repository not found." }, { status: 422 });
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
          "No GitHub access token for this workspace. Link GitHub (with repo scope) first.",
      },
      { status: 422 }
    );
  }
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
    const reLink = res.status === 401 || res.status === 403 || res.status === 404;
    return NextResponse.json(
      {
        error: reLink
          ? "GitHub denied the request — re-link GitHub with `repo` scope and retry."
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

async function createLinearIssue(
  workspaceId: string,
  title: string,
  description: string
): Promise<NextResponse> {
  const connector = await getConnector(workspaceId, "linear");
  if (!connector || !connector.enabled || !connector.hasSecret) {
    return NextResponse.json(
      { error: "Linear is not connected for this workspace." },
      { status: 422 }
    );
  }
  const apiKey = await getConnectorSecret(workspaceId, "linear");
  if (!apiKey) {
    return NextResponse.json(
      { error: "Linear is connected but its API key is missing." },
      { status: 422 }
    );
  }
  let teamId: string;
  try {
    const teamRes = await linearQuery(
      apiKey,
      "{ teams(first: 1) { nodes { id } } }"
    );
    if (!teamRes.ok) {
      return NextResponse.json(
        {
          error:
            teamRes.status === 401 || teamRes.status === 400
              ? "Linear rejected the API key. Reconnect Linear with a valid personal API key."
              : `Linear could not be reached (HTTP ${teamRes.status}).`,
        },
        { status: 502 }
      );
    }
    const json = (await teamRes.json()) as {
      data?: { teams?: { nodes?: { id: string }[] } };
    };
    const first = json.data?.teams?.nodes?.[0]?.id;
    if (!first) {
      return NextResponse.json(
        { error: "The Linear API key has no team to file issues into." },
        { status: 422 }
      );
    }
    teamId = first;
  } catch {
    return NextResponse.json({ error: "Could not reach Linear." }, { status: 502 });
  }
  try {
    const res = await linearQuery(
      apiKey,
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`,
      { input: { teamId, title, description } }
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `Linear rejected the issue (HTTP ${res.status}).` },
        { status: 502 }
      );
    }
    const json = (await res.json()) as {
      data?: {
        issueCreate?: {
          success?: boolean;
          issue?: { identifier?: string; url?: string };
        };
      };
      errors?: { message: string }[];
    };
    if (json.errors?.length || !json.data?.issueCreate?.success) {
      return NextResponse.json(
        { error: json.errors?.[0]?.message ?? "Linear did not create the issue." },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      target: "linear",
      url: json.data.issueCreate.issue?.url ?? null,
      identifier: json.data.issueCreate.issue?.identifier ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Linear." }, { status: 502 });
  }
}

function linearQuery(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<Response> {
  return fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}
