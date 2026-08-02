import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/file-history
 *
 * The reviewer's churn/history seam — recent commits touching one path, so
 * `file_history` can answer "is this rewriting something recent?" and hand
 * back an older `sha` for a `repo-file?ref=<sha>` "previous implementation"
 * read (spec:
 * docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md §1).
 *
 * AUTH + TENANT RESOLUTION + REPO<->WORKSPACE VALIDATION: identical to the
 * sibling issue/repo-file/code-search routes (same requireJaceConsoleSecret
 * guard, same eveSessionId -> jace_sessions -> workspace chain, same
 * getRepositoryByName ownership check — never a caller-supplied workspaceId,
 * never a repo this workspace hasn't connected).
 *
 * PATH SAFETY: identical to repo-file's `validatePath` — `path` is rejected
 * before any DB or GitHub call if it starts with `/` or if any `/`-split
 * segment is `.` or `..`.
 *
 * LIMIT: optional, parsed as an integer. A missing value, a non-numeric
 * value, or a value less than 1 defaults to DEFAULT_LIMIT; a value over
 * MAX_LIMIT clamps to MAX_LIMIT — never a caller-controlled unbounded
 * `per_page` against GitHub.
 *
 * GITHUB ERROR CLASSIFICATION: GitHub's own statuses are never passed
 * through raw — same base table as repo-file/code-search (404 / 429 /
 * reconnect-409 / else 502). One addition specific to this route: the
 * commits endpoint's success body is expected to be a JSON array; anything
 * else (GitHub shape drift, an intermediary's error page slipping through
 * with a 2xx) classifies to an honest 502
 * `{ error: "GitHub returned an unexpected response." }` rather than being
 * mapped and silently producing garbage commits.
 *
 * RESPONSE SHAPE: `{ path, commits: [{ sha, shortSha, authorLogin, date,
 * messageFirstLine }] }`, capped at the effective `limit`. `authorLogin`
 * falls back to `commit.author.name` (the free-text git commit author,
 * always present) when GitHub can't resolve the top-level `author` to a
 * GitHub account (unlinked commit email, deleted account).
 * `messageFirstLine` is the commit message's first line, capped at
 * MESSAGE_FIRST_LINE_MAX_CHARS chars.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MESSAGE_FIRST_LINE_MAX_CHARS = 200;
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

/** Reject before any DB or GitHub call: empty, absolute, or a path with a
 * `.`/`..` traversal segment. Identical to repo-file's `validatePath` — the
 * commits API takes `path` as a query filter rather than a URL segment, but
 * a traversal segment still has no legitimate use here. */
function validatePath(path: string): { ok: true } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: "path is required" };
  if (path.startsWith("/")) {
    return { ok: false, reason: "path must be a relative path without . or .. segments" };
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return { ok: false, reason: "path must be a relative path without . or .. segments" };
  }
  return { ok: true };
}

/** NaN or <1 defaults to DEFAULT_LIMIT; >MAX_LIMIT clamps to MAX_LIMIT.
 * Never errors — an out-of-range limit is a clamp, not a 400. */
function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
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
  if (status === 404) return { status: 404, error: "repository not found" };
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

interface GithubCommitItem {
  sha?: unknown;
  author?: unknown;
  commit?: unknown;
}

interface MappedCommit {
  sha: string;
  shortSha: string;
  authorLogin: string;
  date: string;
  messageFirstLine: string;
}

/** `author` is GitHub's resolved-account link for the commit — null when
 * the commit's email isn't linked to a GitHub account or the account was
 * deleted. Falls back to the free-text git commit author name, which
 * GitHub always carries. */
function mapCommit(c: GithubCommitItem | null | undefined): MappedCommit {
  const sha = str(c?.sha);
  const author = c?.author as Record<string, unknown> | null | undefined;
  const commit = c?.commit as Record<string, unknown> | undefined;
  const commitAuthor = commit?.author as Record<string, unknown> | undefined;
  const authorLogin =
    author && typeof author.login === "string" ? (author.login as string) : str(commitAuthor?.name);

  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorLogin,
    date: str(commitAuthor?.date),
    messageFirstLine: str(commit?.message).split("\n")[0].slice(0, MESSAGE_FIRST_LINE_MAX_CHARS),
  };
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  const path = params.get("path")?.trim() ?? "";
  const limit = parseLimit(params.get("limit")?.trim() ?? "");

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }
  const repoCheck = validateRepoFormat(repo);
  if (!repoCheck.ok) {
    return NextResponse.json({ error: repoCheck.reason }, { status: 400 });
  }
  const pathCheck = validatePath(path);
  if (!pathCheck.ok) {
    return NextResponse.json({ error: pathCheck.reason }, { status: 400 });
  }

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(
    path
  )}&per_page=${limit}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: githubHeaders(token) });
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const { status, error } = classifyGithubError(res.status, errBody);
    return NextResponse.json({ error }, { status });
  }

  const body = await res.json().catch(() => null);

  if (!Array.isArray(body)) {
    return NextResponse.json(
      { error: "GitHub returned an unexpected response." },
      { status: 502 }
    );
  }

  const commits = (body as GithubCommitItem[]).slice(0, limit).map(mapCommit);

  return NextResponse.json({ path, commits }, { status: 200 });
}
