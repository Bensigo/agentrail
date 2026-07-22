/**
 * GitHub REST helpers for the connect-repo picker (#1293).
 *
 * Two operations, both driven by the CONNECTING user's own stored OAuth
 * `access_token` (never a PAT, never the `gh` CLI, never returned to the
 * client):
 *   - `listUserRepos`  — powers the searchable picker (AC1).
 *   - `checkRepoAccess` — validates a picked/typed repo exists AND is pushable
 *                         before a `repositories` row is created (AC2).
 *
 * Both return discriminated results the route layer translates into HTTP, so
 * the "reconnect GitHub" / "rate limited" / "not found" distinctions stay
 * testable without a live token. The fetch idiom (8s AbortController timeout +
 * `githubHeaders`) mirrors the existing GitHub calls in
 * app/api/v1/runner/repos/route.ts.
 */

const GITHUB_API = "https://api.github.com";

// Same bound + idiom as the other connector-verify fetches in this app (8s).
const GITHUB_FETCH_TIMEOUT_MS = 8000;

export interface PickerRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

/** Why a list attempt failed, in terms the UI can act on. */
export type ListReposFailure =
  // Token missing/expired/revoked or under-scoped → "Reconnect GitHub".
  | { ok: false; kind: "reconnect"; status: number; message: string }
  // Secondary/primary rate limit hit → "try again shortly".
  | { ok: false; kind: "rate_limited"; status: number; message: string }
  // Network error or any other non-2xx → generic.
  | { ok: false; kind: "error"; status: number; message: string };

export type ListReposResult = { ok: true; repos: PickerRepo[] } | ListReposFailure;

export type RepoAccessResult =
  // 200 + push/admin/maintain — safe to connect.
  | { ok: true }
  // 404, or 200 without any write permission → definitively reject.
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "no_push" }
  // Token/rate/network hiccup — caller cannot conclude, so should NOT block.
  | { ok: false; kind: "indeterminate" };

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agentrail-console",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A 403 with `x-ratelimit-remaining: 0` is a rate limit; any other 403 is a
 * credential/scope problem the user fixes by reconnecting. */
function is403RateLimit(res: Response): boolean {
  return res.headers.get("x-ratelimit-remaining") === "0";
}

function coerceRepo(raw: unknown): PickerRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const full_name = typeof r.full_name === "string" ? r.full_name : "";
  const html_url = typeof r.html_url === "string" ? r.html_url : "";
  if (!full_name || !html_url) return null;
  return {
    full_name,
    html_url,
    private: typeof r.private === "boolean" ? r.private : false,
    default_branch:
      typeof r.default_branch === "string" && r.default_branch
        ? r.default_branch
        : "main",
  };
}

/**
 * List repos the token's user can see, most-recently-updated first, across
 * personal + collaborator + org-member affiliations. `q` filters client-side
 * over the fetched page by substring of `full_name` (case-insensitive) — the
 * picker is a convenience over a user's own repos, not a global code search, so
 * a single 100-item page keyed on `sort=updated` covers the overwhelmingly
 * common case without a second round-trip; `page` is honoured for the rare
 * user who needs to reach further.
 */
export async function listUserRepos(
  token: string,
  opts: { q?: string; page?: number } = {}
): Promise<ListReposResult> {
  const page =
    typeof opts.page === "number" && Number.isFinite(opts.page) && opts.page > 0
      ? Math.floor(opts.page)
      : 1;
  const url =
    `${GITHUB_API}/user/repos?per_page=100&sort=updated` +
    `&affiliation=owner,collaborator,organization_member&page=${page}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: githubHeaders(token) });
  } catch {
    return { ok: false, kind: "error", status: 502, message: "Could not reach GitHub." };
  }

  if (res.status === 401) {
    return {
      ok: false,
      kind: "reconnect",
      status: 401,
      message: "GitHub rejected the stored credentials — reconnect GitHub to refresh access.",
    };
  }
  if (res.status === 403) {
    if (is403RateLimit(res)) {
      return {
        ok: false,
        kind: "rate_limited",
        status: 429,
        message: "GitHub's rate limit was reached — try again in a few minutes.",
      };
    }
    return {
      ok: false,
      kind: "reconnect",
      status: 403,
      message: "GitHub denied access with the stored credentials — reconnect GitHub.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      kind: "error",
      status: 502,
      message: `GitHub returned an unexpected response (HTTP ${res.status}).`,
    };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return {
      ok: false,
      kind: "error",
      status: 502,
      message: "GitHub returned an unexpected response.",
    };
  }

  const list = Array.isArray(raw) ? raw : [];
  let repos = list
    .map(coerceRepo)
    .filter((r): r is PickerRepo => r !== null);

  const q = opts.q?.trim().toLowerCase();
  if (q) {
    repos = repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }
  return { ok: true, repos };
}

/**
 * Confirm `owner/repo` exists AND the token's user has write (push) access —
 * AgentRail must be able to push branches/PRs, so read-only visibility isn't
 * enough. A 404 (private-and-invisible reads identically to non-existent) or a
 * 200 without push/admin/maintain is a definitive reject; a token/rate/network
 * failure is `indeterminate` so the caller can fall back to regex-only rather
 * than block a legitimate connect on a transient GitHub hiccup.
 */
export async function checkRepoAccess(
  token: string,
  owner: string,
  repo: string
): Promise<RepoAccessResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: githubHeaders(token) }
    );
  } catch {
    return { ok: false, kind: "indeterminate" };
  }

  if (res.status === 404) return { ok: false, kind: "not_found" };
  // 401 (bad token) / 403 (rate or scope) → can't conclude anything about the
  // repo itself; don't block.
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "indeterminate" };
  if (!res.ok) return { ok: false, kind: "indeterminate" };

  let body: { permissions?: { push?: unknown; admin?: unknown; maintain?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, kind: "indeterminate" };
  }
  const p = body.permissions ?? {};
  const canPush = p.push === true || p.admin === true || p.maintain === true;
  return canPush ? { ok: true } : { ok: false, kind: "no_push" };
}
