import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/code-search
 *
 * The reviewer's capped textual usage search — the search_code tool
 * resolves callers/usages of a changed or removed exported symbol so the
 * reviewer can judge blast radius from evidence instead of a disclaimer
 * (spec: docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md
 * §1).
 *
 * AUTH + TENANT RESOLUTION + REPO<->WORKSPACE VALIDATION: identical to the
 * sibling issue/repo-file routes (same requireJaceConsoleSecret guard, same
 * eveSessionId -> jace_sessions -> workspace chain, same
 * getRepositoryByName ownership check — never a caller-supplied workspaceId,
 * never a repo this workspace hasn't connected).
 *
 * QUERY SCOPING: `q` is required, trimmed, and capped at MAX_QUERY_CHARS.
 * GitHub code search is scoped to this one repo server-side — a
 * `repo:<repo>` qualifier is appended to the caller's query before it ever
 * reaches GitHub, never left to the caller to add or omit.
 *
 * GITHUB ERROR CLASSIFICATION: GitHub's own statuses are never passed
 * through raw — mostly the same table as issue/repo-file (429 /
 * reconnect-409 / else 502), with two deltas: a 422 (GitHub's "unparseable
 * search query" response) classifies to an honest 400
 * `invalid search query` instead of a generic 502; the 401/403 rate-limit
 * sniff widens to `/rate limit|secondary rate/i` — code search carries its
 * own tight ~10 req/min-per-installation limit, so a secondary-rate-limit
 * rejection is expected under load, not a credentials problem.
 *
 * RESPONSE SHAPE: `{ totalCount, note, results: [{ path, fragments }] }`,
 * capped at MAX_SEARCH_RESULTS results with fragments capped at
 * MAX_FRAGMENT_CHARS chars each. `note` is a fixed, honest label carried
 * verbatim — GitHub code search is textual matching, not a compiled call
 * graph, and nothing downstream should mistake a text hit for a resolved
 * reference.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;
const MAX_SEARCH_RESULTS = 20;
const MAX_FRAGMENT_CHARS = 400;
const MAX_QUERY_CHARS = 256;
const SEARCH_NOTE = "textual matches, not a compiled call graph";
const REPO_FORMAT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.text-match+json",
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

/** Reject before any DB or GitHub call: blank after trim, or over
 * MAX_QUERY_CHARS. Both failure modes share one message — there is no
 * legitimate reason for a caller to distinguish "missing" from "too long". */
function validateQuery(q: string): { ok: true } | { ok: false; reason: string } {
  if (!q || q.length > MAX_QUERY_CHARS) {
    return { ok: false, reason: `q is required (max ${MAX_QUERY_CHARS} chars)` };
  }
  return { ok: true };
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function num(x: unknown, d: number): number {
  return typeof x === "number" ? x : d;
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
  if (status === 422) return { status: 400, error: "invalid search query" };
  if (status === 429) return { status: 429, error: "GitHub rate limit exceeded — try again later" };
  if (status === 401 || status === 403) {
    if (/rate limit|secondary rate/i.test(extractGithubMessage(body))) {
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

  if (!session || !identity) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Chat identity not found" }, { status: 404 }),
    };
  }

  const workspaceId = session.workspaceId ?? identity.workspaceId;
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

interface GithubCodeSearchTextMatch {
  fragment?: unknown;
}

interface GithubCodeSearchItem {
  path?: unknown;
  text_matches?: GithubCodeSearchTextMatch[];
}

interface GithubCodeSearchResponse {
  total_count?: unknown;
  items?: GithubCodeSearchItem[];
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  const q = params.get("q")?.trim() ?? "";

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }
  const repoCheck = validateRepoFormat(repo);
  if (!repoCheck.ok) {
    return NextResponse.json({ error: repoCheck.reason }, { status: 400 });
  }
  const queryCheck = validateQuery(q);
  if (!queryCheck.ok) {
    return NextResponse.json({ error: queryCheck.reason }, { status: 400 });
  }

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(
    `${q} repo:${repo}`
  )}&per_page=${MAX_SEARCH_RESULTS}`;

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

  const body = (await res.json().catch(() => ({}))) as GithubCodeSearchResponse;

  const results = (body.items ?? []).slice(0, MAX_SEARCH_RESULTS).map((it) => ({
    path: str(it?.path),
    fragments: (it?.text_matches ?? [])
      .map((m) => str(m?.fragment))
      .filter(Boolean)
      .map((f) => (f.length > MAX_FRAGMENT_CHARS ? f.slice(0, MAX_FRAGMENT_CHARS) : f)),
  }));

  return NextResponse.json(
    {
      totalCount: num(body.total_count, results.length),
      note: SEARCH_NOTE,
      results,
    },
    { status: 200 }
  );
}
