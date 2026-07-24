import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET/POST /api/v1/runner/pr-review
 *
 * Jace's read/write seam for PR review (issue: reviewer subagent + gated
 * post_pr_review tool, NOT this PR's concern beyond the two console
 * endpoints they call). GET fetches a PR's metadata + diff for the read-only
 * `reviewer` subagent's `fetch_pr_diff` tool; POST posts an advisory,
 * COMMENT-only review for the gated root `post_pr_review` tool.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the SAME guard every other Jace-coordinator route uses (see that
 * helper's own doc-comment). It answers only "is the caller Jace", never
 * "which workspace".
 *
 * TENANT RESOLUTION (`eveSessionId`, NOT a caller-supplied `workspaceId`):
 * this route resolves the real workspace server-side from `eveSessionId`
 * through the `jace_sessions` ledger (`getJaceSessionByEveSessionId` ->
 * `getChatIdentityById`), the EXACT chain `runner/repos` and `runner/goals`
 * already use — never from a caller-supplied workspace id. This matters
 * MORE here than in most routes because the read side is called from
 * `agent/subagents/reviewer/tools/fetch_pr_diff.ts`, a DECLARED SUBAGENT's
 * tool: per eve's own docs (`node_modules/eve/docs/subagents.mdx`, "Each
 * delegated subagent spins up its own child session"), a subagent's own
 * `ctx.session.id` is a CHILD session id, not the root conversation's
 * `eveSessionId` registered in `jace_sessions` — sending it here would 404
 * every call. The vendored eve@0.19.0 type defs
 * (`node_modules/eve/dist/src/channel/types.d.ts`, `SessionParent`) confirm
 * the fix: a first-level child's `session.parent.rootSessionId` is set to
 * the TOP session's id at dispatch, which IS the same `eveSessionId` root's
 * own tools (e.g. `create_repo.ts`) read as `ctx.session.id`. So
 * `fetch_pr_diff.ts` sends `ctx.session.parent?.rootSessionId ??
 * ctx.session.id`, and `post_pr_review.ts` (a ROOT tool, not a subagent's)
 * sends `ctx.session.id` directly — both land here as the same
 * `eveSessionId` field, and this route resolves it identically either way.
 * (An earlier read of this issue's brief described the contract as
 * `{ workspaceId, repo, prNumber }`; this deliberately keeps the estabished,
 * heavily-documented "never trust a caller-supplied workspaceId" invariant
 * instead — see this PR's description for the full reasoning.)
 *
 * REPO <-> WORKSPACE VALIDATION: unlike `create_repo`/`create_goal` (which
 * auto-resolve the workspace's own connected repo), the caller names an
 * explicit `repo` — the human picks which repo to review in chat. So this
 * route never proxies an arbitrary repo with the resolved workspace's stored
 * GitHub token: `getRepositoryByName(workspaceId, repo)` must find a row (a
 * repo the workspace has actually connected) before any GitHub call is made.
 * A `repo` that is well-formed but not connected to THIS workspace 404s,
 * exactly like an unknown repo would — it never reveals whether the name
 * exists on GitHub at all, only that it isn't reachable from here.
 *
 * GITHUB ERROR CLASSIFICATION: GitHub's own status codes are never passed
 * through raw. 404 (PR not found), 401/403 (the workspace's App installation
 * credentials are stale/revoked/missing) and rate-limiting (403 with a
 * rate-limit message, or 429) are each classified into a clean, honest 4xx
 * (`classifyGithubError`); anything else collapses to a 502 (upstream
 * failure), mirroring `runner/repos`'s posture for its own GitHub call.
 *
 * WRITE SAFETY (POST only): the GitHub review `event` is HARDCODED to
 * `"COMMENT"` server-side — nothing in the request body can select
 * `APPROVE` or `REQUEST_CHANGES`. Jace is advisory only; this is the
 * enforced backstop, not just a convention the caller is trusted to follow.
 * If GitHub 422s (a `line` a comment names isn't part of the diff), this
 * retries EXACTLY ONCE, folding every inline comment into the summary body
 * (prefixed with its `path:line`) and resubmitting with an empty
 * `comments` array, so the review still lands with nothing lost. GitHub's
 * 422 for this case does not reliably identify WHICH comment(s) failed to
 * map, so rather than guess, every comment is folded on any 422 — the
 * summary-only resubmission is built from fields we already validated, so
 * it essentially cannot itself 422 for the same reason.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;

// Read-side caps (issue brief): a pathological PR (generated lockfiles,
// vendored bundles) must never blow up the reviewer's context. Each file is
// checked against the RUNNING total so far: a file that would push either
// the count or the cumulative patch bytes over its cap is omitted WHOLE
// (never partially truncated mid-diff — a partial diff reads worse than an
// honestly-omitted one) and its path is recorded, but later, smaller files
// can still be included if they fit under what's left of the budget — one
// oversized generated file (e.g. a lockfile) does not starve the rest of an
// otherwise-small PR.
const MAX_CHANGED_FILES = 50;
const MAX_PATCH_BYTES = 200_000;
// Bound on how many files this route will even walk across pages of
// GET .../files before giving up on naming every omitted path — a safety
// valve against a pathological PR with thousands of changed files, not a
// product limit (GitHub itself caps this endpoint's own listing at 3000).
const MAX_FILES_TO_SCAN = 300;
const FILES_PER_PAGE = 100;

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

function parsePrNumber(raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, reason: "prNumber must be a positive integer" };
  }
  return { ok: true, value: n };
}

function extractGithubMessage(body: unknown): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return (body as Record<string, unknown>).message as string;
  }
  return "";
}

/**
 * Map a non-2xx GitHub response to OUR OWN clean, classified status + error.
 * Never leaks a raw GitHub status/body straight through.
 */
function classifyGithubError(status: number, body: unknown): { status: number; error: string } {
  if (!Number.isFinite(status) || status <= 0) {
    return { status: 502, error: "Could not reach GitHub." };
  }
  if (status === 404) {
    return { status: 404, error: "PR not found" };
  }
  if (status === 429) {
    return { status: 429, error: "GitHub rate limit exceeded — try again later" };
  }
  if (status === 401 || status === 403) {
    const message = extractGithubMessage(body);
    if (/rate limit/i.test(message)) {
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

/**
 * Shared by GET and POST: auth is already checked by the caller.
 * eveSessionId -> jace_sessions ledger -> workspaceId (never caller input);
 * then repo <-> workspace ownership; then the workspace's stored GitHub
 * token. Identical resolution + identical 404/409 shapes for both routes.
 */
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

// ---------------------------------------------------------------------------
// GET — fetch PR metadata + diff (reviewer's fetch_pr_diff tool)
// ---------------------------------------------------------------------------

interface GithubPrResponse {
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  base?: { ref?: unknown } | null;
  head?: { ref?: unknown } | null;
}

interface GithubFileEntry {
  filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
}

type FetchFilesResult =
  | { ok: true; files: GithubFileEntry[] }
  | { ok: false; status: number; body: unknown };

async function fetchAllPrFiles(
  repo: string,
  prNumber: number,
  token: string
): Promise<FetchFilesResult> {
  const files: GithubFileEntry[] = [];
  let page = 1;
  while (files.length < MAX_FILES_TO_SCAN) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        { headers: githubHeaders(token) }
      );
    } catch {
      return { ok: false, status: 0, body: null };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, status: res.status, body };
    }
    const pageBody = (await res.json().catch(() => null)) as unknown;
    const pageFiles = Array.isArray(pageBody) ? (pageBody as GithubFileEntry[]) : [];
    files.push(...pageFiles);
    if (pageFiles.length < FILES_PER_PAGE) break; // last page
    page += 1;
  }
  return { ok: true, files };
}

interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * Apply the file-count + total-patch-byte caps, checking each file (in
 * GitHub's own listing order) against the running total so far. A file that
 * would push the count to 50+ or the cumulative patch bytes over ~200KB is
 * omitted WHOLE (never partially truncated) and its path recorded — but the
 * running total is only advanced by files actually INCLUDED, so a single
 * oversized file (its own patch alone over the byte cap) is skipped without
 * starving smaller files later in the list that still fit.
 */
function capChangedFiles(rawFiles: GithubFileEntry[]): {
  changedFiles: ChangedFile[];
  truncated: boolean;
  omittedPaths: string[];
} {
  const changedFiles: ChangedFile[] = [];
  const omittedPaths: string[] = [];
  let patchBytes = 0;
  let truncated = false;

  for (const f of rawFiles) {
    const path = typeof f.filename === "string" ? f.filename : "";
    const patch = typeof f.patch === "string" ? f.patch : "";
    const patchLen = Buffer.byteLength(patch, "utf8");
    const overFileCap = changedFiles.length >= MAX_CHANGED_FILES;
    const overByteCap = patchBytes + patchLen > MAX_PATCH_BYTES;

    if (overFileCap || overByteCap) {
      truncated = true;
      if (path) omittedPaths.push(path);
      continue;
    }

    changedFiles.push({
      path,
      status: typeof f.status === "string" ? f.status : "",
      additions: typeof f.additions === "number" ? f.additions : 0,
      deletions: typeof f.deletions === "number" ? f.deletions : 0,
      patch,
    });
    patchBytes += patchLen;
  }

  return { changedFiles, truncated, omittedPaths };
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
  const prNumberCheck = parsePrNumber(params.get("prNumber"));
  if (!prNumberCheck.ok) {
    return NextResponse.json({ error: prNumberCheck.reason }, { status: 400 });
  }
  const prNumber = prNumberCheck.value;

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  let prRes: Response;
  try {
    prRes = await fetchWithTimeout(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: githubHeaders(token),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }
  if (!prRes.ok) {
    const errBody = await prRes.json().catch(() => null);
    const { status, error } = classifyGithubError(prRes.status, errBody);
    return NextResponse.json({ error }, { status });
  }
  const prBody = (await prRes.json().catch(() => ({}))) as GithubPrResponse;

  const filesResult = await fetchAllPrFiles(repo, prNumber, token);
  if (!filesResult.ok) {
    const { status, error } = classifyGithubError(filesResult.status, filesResult.body);
    return NextResponse.json({ error }, { status });
  }

  const { changedFiles, truncated, omittedPaths } = capChangedFiles(filesResult.files);

  return NextResponse.json(
    {
      title: typeof prBody.title === "string" ? prBody.title : "",
      author: prBody.user && typeof prBody.user.login === "string" ? prBody.user.login : "",
      baseRef: prBody.base && typeof prBody.base.ref === "string" ? prBody.base.ref : "",
      headRef: prBody.head && typeof prBody.head.ref === "string" ? prBody.head.ref : "",
      body: typeof prBody.body === "string" ? prBody.body : "",
      changedFiles,
      truncated,
      omittedPaths,
    },
    { status: 200 }
  );
}

// ---------------------------------------------------------------------------
// POST — post an advisory, COMMENT-only review (post_pr_review tool)
// ---------------------------------------------------------------------------

interface RawComment {
  path: string;
  line: number;
  body: string;
}

interface RawBody {
  eveSessionId: string;
  repo: string;
  prNumber: number;
  summary: string;
  comments: RawComment[];
}

function isRawComment(v: unknown): v is RawComment {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.path === "string" &&
    o.path.length > 0 &&
    typeof o.line === "number" &&
    Number.isInteger(o.line) &&
    o.line > 0 &&
    typeof o.body === "string" &&
    o.body.length > 0
  );
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string" || o.eveSessionId.length === 0) return false;
  if (typeof o.repo !== "string" || o.repo.length === 0) return false;
  if (typeof o.prNumber !== "number" || !Number.isInteger(o.prNumber) || o.prNumber <= 0) {
    return false;
  }
  if (typeof o.summary !== "string") return false;
  if (!Array.isArray(o.comments) || !o.comments.every(isRawComment)) return false;
  return true;
}

interface GithubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Fold every comment into the summary text, prefixed with its path:line — the AC3-equivalent "review still lands" fallback for a 422. */
function foldCommentsIntoSummary(summary: string, comments: RawComment[]): string {
  const folded = comments.map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`).join("\n");
  const header =
    "**Additional comments (could not be attached to a specific diff line):**";
  return summary.trim().length > 0
    ? `${summary}\n\n---\n${header}\n${folded}`
    : `${header}\n${folded}`;
}

async function postReviewToGithub(
  repo: string,
  prNumber: number,
  token: string,
  body: string,
  comments: GithubReviewComment[]
): Promise<Response> {
  return fetchWithTimeout(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: githubHeaders(token),
    // event is HARDCODED to "COMMENT" — nothing in the request body can ever
    // select APPROVE or REQUEST_CHANGES. Jace is advisory only; this is the
    // enforced backstop.
    body: JSON.stringify({
      body,
      event: "COMMENT",
      ...(comments.length ? { comments } : {}),
    }),
  });
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRawBody(raw)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), repo (string), prNumber (positive integer), " +
          "summary (string), and comments (array of { path, line, body })",
      },
      { status: 400 }
    );
  }
  const { eveSessionId, repo, prNumber, summary, comments } = raw;

  if (summary.trim().length === 0 && comments.length === 0) {
    return NextResponse.json(
      { error: "summary or at least one comment is required" },
      { status: 400 }
    );
  }

  const repoCheck = validateRepoFormat(repo);
  if (!repoCheck.ok) {
    return NextResponse.json({ error: repoCheck.reason }, { status: 400 });
  }

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  const inlineComments: GithubReviewComment[] = comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT",
    body: c.body,
  }));

  let res: Response;
  try {
    res = await postReviewToGithub(repo, prNumber, token, summary, inlineComments);
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }

  let finalSummary = summary;
  let foldedComments: RawComment[] = [];

  if (res.status === 422) {
    // A line named by one or more comments isn't part of the diff. Rather
    // than guess which one from GitHub's error body, fold ALL of them into
    // the summary and retry exactly once with an empty comments array — see
    // this file's module doc-comment for why.
    foldedComments = comments;
    finalSummary = foldCommentsIntoSummary(summary, comments);
    try {
      res = await postReviewToGithub(repo, prNumber, token, finalSummary, []);
    } catch {
      return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const { status, error } = classifyGithubError(res.status, errBody);
    return NextResponse.json({ error }, { status });
  }

  const posted = (await res.json().catch(() => ({}))) as { html_url?: unknown };

  return NextResponse.json(
    {
      posted: true,
      reviewUrl: typeof posted.html_url === "string" ? posted.html_url : null,
      summary: finalSummary,
      inlineCommentsPosted: foldedComments.length > 0 ? 0 : inlineComments.length,
      foldedComments,
    },
    { status: 201 }
  );
}
