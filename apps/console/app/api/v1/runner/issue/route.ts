import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/issue
 *
 * Jace's read seam for ONE GitHub issue — the goal payload root's ungated
 * fetch_issue tool resolves acceptance criteria from before QA-ing the work
 * that closes it (spec: docs/superpowers/specs/2026-07-29-qa-ac-awareness-design.md).
 *
 * AUTH + TENANT RESOLUTION + REPO<->WORKSPACE VALIDATION: identical to the
 * sibling pr-review route (same requireJaceConsoleSecret guard, same
 * eveSessionId -> jace_sessions -> workspace chain, same
 * getRepositoryByName ownership check — never a caller-supplied workspaceId,
 * never a repo this workspace hasn't connected).
 *
 * PULL-REQUEST GUARD: GitHub's issues endpoint also serves PRs (a PR is an
 * issue). A payload carrying a `pull_request` key 404s with a plain-language
 * error instead of leaking PR content through the issue seam.
 *
 * GITHUB ERROR CLASSIFICATION: GitHub's own statuses are never passed
 * through raw — same classification table as pr-review.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;
const MAX_ISSUE_BODY_BYTES = 8000;
const REPO_FORMAT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agentrail-console",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function validateRepoFormat(repo: string): { ok: true } | { ok: false; reason: string } {
  if (!repo) return { ok: false, reason: "repo is required" };
  if (!REPO_FORMAT_RE.test(repo)) {
    return { ok: false, reason: "repo must be in the form owner/name" };
  }
  return { ok: true };
}

function parseIssueNumber(raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, reason: "issueNumber must be a positive integer" };
  }
  return { ok: true, value: n };
}

function extractGithubMessage(body: unknown): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return (body as Record<string, unknown>).message as string;
  }
  return "";
}

function classifyGithubError(status: number, body: unknown): { status: number; error: string } {
  if (!Number.isFinite(status) || status <= 0) {
    return { status: 502, error: "Could not reach GitHub." };
  }
  if (status === 404) return { status: 404, error: "Issue not found" };
  if (status === 429) return { status: 429, error: "GitHub rate limit exceeded — try again later" };
  if (status === 401 || status === 403) {
    if (/rate limit/i.test(extractGithubMessage(body))) {
      return { status: 429, error: "GitHub rate limit exceeded — try again later" };
    }
    return {
      status: 409,
      error:
        "GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console",
    };
  }
  return { status: 502, error: `GitHub rejected the request (HTTP ${status}).` };
}

/** Cap the issue body to MAX_ISSUE_BODY_BYTES on a UTF-8 character boundary
 * (a mid-character cut decodes to a trailing U+FFFD, which is stripped). */
function capIssueBody(body: string): { body: string; bodyTruncated: boolean } {
  const buf = Buffer.from(body, "utf8");
  if (buf.byteLength <= MAX_ISSUE_BODY_BYTES) return { body, bodyTruncated: false };
  const text = buf.subarray(0, MAX_ISSUE_BODY_BYTES).toString("utf8").replace(/�+$/, "");
  return { body: text, bodyTruncated: true };
}

type ResolveOutcome =
  | { ok: true; workspaceId: string; token: string }
  | { ok: false; response: NextResponse };

async function resolveWorkspaceRepoToken(
  eveSessionId: string,
  repo: string
): Promise<ResolveOutcome> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;

  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session not found" }, { status: 404 }),
    };
  }

  // review-job worker sessions (Arc B) are workspace-anchored with no chat
  // identity (chatIdentityId null, workspaceId set) — identity legitimately
  // stays null for those, so it is read optionally below rather than gating
  // the whole resolution the way the old `!session || !identity` check did.
  const workspaceId = session.workspaceId ?? identity?.workspaceId;
  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet — create one first" },
        { status: 409 }
      ),
    };
  }

  const connectedRepo = await getRepositoryByName(workspaceId, repo);
  if (!connectedRepo) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "repo not connected to this workspace" },
        { status: 404 }
      ),
    };
  }

  const token = await getInstallationToken(workspaceId);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "GitHub is not connected for this workspace — install the Jace GitHub App first" },
        { status: 409 }
      ),
    };
  }

  return { ok: true, workspaceId, token };
}

interface GithubIssueResponse {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  pull_request?: unknown;
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }
  const repoCheck = validateRepoFormat(repo);
  if (!repoCheck.ok) {
    return NextResponse.json({ error: repoCheck.reason }, { status: 400 });
  }
  const issueNumberCheck = parseIssueNumber(params.get("issueNumber"));
  if (!issueNumberCheck.ok) {
    return NextResponse.json({ error: issueNumberCheck.reason }, { status: 400 });
  }
  const issueNumber = issueNumberCheck.value;

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  let res: Response;
  try {
    res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      headers: githubHeaders(token),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const { status, error } = classifyGithubError(res.status, errBody);
    return NextResponse.json({ error }, { status });
  }
  const issue = (await res.json().catch(() => ({}))) as GithubIssueResponse;

  if (issue && typeof issue === "object" && "pull_request" in issue) {
    return NextResponse.json(
      { error: "that number is a pull request, not an issue" },
      { status: 404 }
    );
  }

  const { body: cappedBody, bodyTruncated } = capIssueBody(
    typeof issue.body === "string" ? issue.body : ""
  );

  return NextResponse.json(
    {
      number: typeof issue.number === "number" ? issue.number : issueNumber,
      title: typeof issue.title === "string" ? issue.title : "",
      body: cappedBody,
      state: typeof issue.state === "string" ? issue.state : "",
      bodyTruncated,
    },
    { status: 200 }
  );
}
