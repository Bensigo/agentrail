import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/repo-file
 *
 * The reviewer's read seam for ONE file or directory listing in a
 * workspace's connected GitHub repo at a ref — context tools resolve the
 * repository around a diff instead of judging from the diff alone (spec:
 * docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md §1).
 *
 * AUTH + TENANT RESOLUTION + REPO<->WORKSPACE VALIDATION: identical to the
 * sibling issue/pr-review routes (same requireJaceConsoleSecret guard, same
 * eveSessionId -> jace_sessions -> workspace chain, same
 * getRepositoryByName ownership check — never a caller-supplied workspaceId,
 * never a repo this workspace hasn't connected).
 *
 * PATH SAFETY: `path` is rejected before any DB or GitHub call if it starts
 * with `/` or if any `/`-split segment is `.` or `..` — GitHub's contents
 * API resolves relative to the repo root, and a traversal segment has no
 * legitimate use here.
 *
 * GITHUB ERROR CLASSIFICATION: GitHub's own statuses are never passed
 * through raw — same classification table as issue/pr-review (404 / 429 /
 * reconnect-409 / else 502), plus one addition: a 403 whose message names
 * GitHub's own >1MB blob-size limit classifies to an honest 422 instead of
 * the generic reconnect-409.
 *
 * RESPONSE SHAPE: a file responds
 * `{ path, ref, kind: "file", content, size, truncated }` with content
 * decoded and capped at MAX_FILE_CONTENT_BYTES UTF-8 bytes on a character
 * boundary; a directory responds
 * `{ path, ref, kind: "dir", entries: [{ name, type }] }` capped at
 * MAX_DIR_ENTRIES entries; anything else the contents API can return for a
 * path (symlink, submodule) 422s as unreadable rather than guessing at its
 * shape.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;
const MAX_FILE_CONTENT_BYTES = 65536;
const MAX_DIR_ENTRIES = 100;
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
 * `.`/`..` traversal segment. */
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

/** encodeURIComponent each `/`-separated segment while keeping the
 * separators literal, so GitHub's contents API still sees a path. */
function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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
  if (status === 404) return { status: 404, error: "File or directory not found" };
  if (status === 429) return { status: 429, error: "GitHub rate limit exceeded — try again later" };
  if (status === 403 && /too.?large|blobs? up to/i.test(extractGithubMessage(body))) {
    return { status: 422, error: "file too large to fetch" };
  }
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

/** Cap file content to MAX_FILE_CONTENT_BYTES on a UTF-8 character boundary
 * (a mid-character cut decodes to a trailing U+FFFD, which is stripped). */
function capContent(content: string): { content: string; truncated: boolean } {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength <= MAX_FILE_CONTENT_BYTES) return { content, truncated: false };
  const text = buf.subarray(0, MAX_FILE_CONTENT_BYTES).toString("utf8").replace(/�+$/, "");
  return { content: text, truncated: true };
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

interface GithubContentsEntry {
  name?: unknown;
  type?: unknown;
}

interface GithubContentsFile {
  type?: unknown;
  content?: unknown;
  size?: unknown;
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  const path = params.get("path")?.trim() ?? "";
  const rawRef = params.get("ref")?.trim() ?? "";
  const ref = rawRef ? rawRef : undefined;

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

  const url = `https://api.github.com/repos/${repo}/contents/${encodePathSegments(path)}${
    ref ? `?ref=${encodeURIComponent(ref)}` : ""
  }`;

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

  const body = await res.json().catch(() => ({}));

  if (Array.isArray(body)) {
    const entries = (body as GithubContentsEntry[]).slice(0, MAX_DIR_ENTRIES).map((e) => ({
      name: str(e?.name),
      type: str(e?.type),
    }));
    return NextResponse.json(
      { path, ref: ref ?? "", kind: "dir", entries },
      { status: 200 }
    );
  }

  if (body && typeof body === "object" && (body as GithubContentsFile).type === "file") {
    const file = body as GithubContentsFile;
    const decoded = Buffer.from(str(file.content), "base64").toString("utf8");
    const { content, truncated } = capContent(decoded);
    return NextResponse.json(
      { path, ref: ref ?? "", kind: "file", content, size: num(file.size, 0), truncated },
      { status: 200 }
    );
  }

  return NextResponse.json(
    { error: "path is not a readable file or directory" },
    { status: 422 }
  );
}
