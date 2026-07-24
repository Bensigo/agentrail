import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/backlog?eveSessionId=<id>
 *
 * The READ-ONLY backlog sweep behind Jace's `backlog-triage` skill (issue
 * #1291, epic #1257). Returns the workspace's OPEN GitHub issues across every
 * repo it has connected, normalized to the signals grooming reasons over —
 * number, title, labels, created_at, updated_at, comment count, and a short
 * body excerpt. This is the read half of "Jace actually owns the backlog";
 * every MUTATION (label/close/dedupe) goes through the SEPARATE, human-gated
 * `POST /api/v1/runner/backlog/mutate` route, never this one. This route reads
 * and returns; it never writes to the tracker.
 *
 * NOT the run-failure "triage" feature: that is FAILURE DIAGNOSIS
 * (`agent/subagents/triage`, `/api/v1/runner/failure-bundle`). This is BACKLOG
 * GROOMING — a deliberately distinct name and code path.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the SAME guard every other Jace-coordinator route uses (see that helper's
 * own doc-comment). It answers only "is the caller Jace", never "which
 * workspace".
 *
 * TENANT RESOLUTION (`eveSessionId`, NOT a caller-supplied `workspaceId`):
 * this route resolves the real workspace server-side from `eveSessionId`
 * through the `jace_sessions` ledger (`getJaceSessionByEveSessionId` ->
 * `getChatIdentityById`), the EXACT chain `runner/repos`, `runner/goals`, and
 * `runner/pr-review` already use — never from a caller-supplied workspace id.
 * The issue brief sketched a `/workspaces/[workspaceId]/backlog` shape; this
 * deliberately keeps the established, heavily-documented "never trust a
 * caller-supplied workspaceId" invariant instead (a shared deployment-wide
 * secret authorizes any Jace call, so a caller-supplied workspaceId path
 * param would let any holder of that secret enumerate any tenant's backlog).
 * See `pr-review/route.ts`'s doc-comment for the same divergence-from-brief
 * reasoning. A session with no anchor, or an intro (chat-identity-only)
 * session with no `workspaceId` yet, collapses into the same 404, matching
 * this seam's anti-enumeration posture elsewhere.
 *
 * GITHUB READ (per connected repo): `GET /repos/{owner}/{repo}/issues?
 * state=open&per_page=100`, paginated (up to MAX_PAGES_PER_REPO pages) and
 * PR-filtered — GitHub's issues endpoint returns pull requests too, so any
 * entry carrying a `pull_request` field is dropped. Each repo's failure is
 * isolated: one repo the token can't read (renamed, access revoked) is
 * recorded in `warnings` and skipped, never failing the whole sweep. The
 * GitHub token is a short-lived App installation token minted fresh at the
 * point of use (`getInstallationToken`) and never returned to the caller or
 * logged.
 *
 * 400 — missing `eveSessionId`. 401 — bad/missing secret. 404 — no session,
 * or a session with no resolvable workspace yet. 409 — the workspace has no
 * connected GitHub token yet. 200 — `{ issues: [...], repos: [...],
 * warnings: [...] }` (issues aggregated across every readable repo).
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;

// Server-side excerpt cap. Jace additionally runs every issue's title/body/
// labels through hardenUntrusted() before the model reads them (see
// `agent/lib/fetch_backlog.core.mjs`); this is the transport-size backstop.
const BODY_EXCERPT_MAX_LEN = 600;

// Paging bounds. GitHub caps `per_page` at 100; MAX_PAGES_PER_REPO * 100 is
// the per-repo ceiling (a pathological repo with thousands of open issues must
// never blow up the sweep's context or hang the request). MAX_ISSUES_TOTAL is
// the aggregate ceiling across all repos.
const PER_PAGE = 100;
const MAX_PAGES_PER_REPO = 5;
const MAX_ISSUES_TOTAL = 400;

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

interface GithubIssueEntry {
  number?: unknown;
  title?: unknown;
  labels?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  comments?: unknown;
  body?: unknown;
  pull_request?: unknown;
}

interface NormalizedIssue {
  repo: string;
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
  bodyExcerpt: string;
}

/** GitHub label entries are `{ name }` objects (or, rarely, bare strings). */
function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const l of raw) {
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string") {
      out.push((l as { name: string }).name);
    }
  }
  return out;
}

/**
 * Normalize ONE GitHub issue entry into the grooming shape, or `null` when it
 * is a pull request (GitHub's issues endpoint includes PRs — any entry with a
 * `pull_request` key is one) or has no usable number.
 */
function normalizeIssue(repo: string, entry: GithubIssueEntry): NormalizedIssue | null {
  if (entry.pull_request !== undefined && entry.pull_request !== null) return null;
  const number = typeof entry.number === "number" ? entry.number : Number(entry.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const body = typeof entry.body === "string" ? entry.body : "";
  return {
    repo,
    number,
    title: typeof entry.title === "string" ? entry.title : "",
    labels: normalizeLabels(entry.labels),
    createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
    updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : "",
    comments: typeof entry.comments === "number" ? entry.comments : 0,
    bodyExcerpt: body.length > BODY_EXCERPT_MAX_LEN ? body.slice(0, BODY_EXCERPT_MAX_LEN) : body,
  };
}

type RepoSweep =
  | { ok: true; issues: NormalizedIssue[] }
  | { ok: false; warning: string };

/**
 * Sweep one repo's OPEN issues, paginating up to MAX_PAGES_PER_REPO and
 * filtering out PRs. A per-repo failure (unreachable, 4xx, malformed body) is
 * returned as a `warning` string — never thrown — so one bad repo cannot fail
 * the whole workspace sweep.
 */
async function sweepRepo(
  repo: string,
  token: string,
  remaining: number
): Promise<RepoSweep> {
  const issues: NormalizedIssue[] = [];
  let page = 1;

  while (page <= MAX_PAGES_PER_REPO && issues.length < remaining) {
    const url =
      `https://api.github.com/repos/${repo}/issues` +
      `?state=open&per_page=${PER_PAGE}&page=${page}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: githubHeaders(token) });
    } catch {
      return { ok: false, warning: `Could not reach GitHub to read ${repo}.` };
    }
    if (!res.ok) {
      return {
        ok: false,
        warning: `GitHub could not read issues for ${repo} (HTTP ${res.status}).`,
      };
    }
    const pageBody = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(pageBody)) {
      return { ok: false, warning: `GitHub returned an unexpected response for ${repo}.` };
    }
    for (const entry of pageBody as GithubIssueEntry[]) {
      const normalized = normalizeIssue(repo, entry);
      if (normalized) issues.push(normalized);
      if (issues.length >= remaining) break;
    }
    if (pageBody.length < PER_PAGE) break; // last page
    page += 1;
  }

  return { ok: true, issues };
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const eveSessionId = request.nextUrl.searchParams.get("eveSessionId")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session?.workspaceId ?? identity?.workspaceId ?? null;

  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const token = await getInstallationToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected for this workspace — install the Jace GitHub App first" },
      { status: 409 }
    );
  }

  const repos = await listWorkspaceRepositories(workspaceId);
  const repoNames = repos
    .map((r) => (typeof r.name === "string" ? r.name : ""))
    .filter((n) => n.length > 0);

  const allIssues: NormalizedIssue[] = [];
  const warnings: string[] = [];

  for (const repo of repoNames) {
    if (allIssues.length >= MAX_ISSUES_TOTAL) {
      warnings.push(
        `Reached the ${MAX_ISSUES_TOTAL}-issue sweep cap before reading every repo; ${repo} and any later repos were skipped.`
      );
      break;
    }
    const sweep = await sweepRepo(repo, token, MAX_ISSUES_TOTAL - allIssues.length);
    if (sweep.ok) allIssues.push(...sweep.issues);
    else warnings.push(sweep.warning);
  }

  return NextResponse.json(
    { issues: allIssues, repos: repoNames, warnings },
    { status: 200 }
  );
}
