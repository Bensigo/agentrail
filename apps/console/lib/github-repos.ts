/**
 * GitHub REST helpers for the connect-repo picker (#1293, migrated off
 * per-user OAuth by the GitHub App identity design — spec §5/§6, Task 6
 * delta of the drift addendum).
 *
 * Two operations, BOTH driven by the WORKSPACE's App installation token
 * (`getInstallationToken(workspaceId)`, never a per-user OAuth token, a PAT,
 * or the `gh` CLI):
 *   - `listInstallationRepos` — powers the searchable picker (AC1): every
 *     repo the App installation was actually granted, straight from
 *     `GET /installation/repositories` — there is no broader "repos this
 *     user can see" universe to enumerate once repo access comes from the
 *     installation grant rather than the signed-in user's own OAuth scope.
 *   - `checkRepoAccess` — validates a picked/typed repo is a MEMBER of that
 *     same installation grant before a `repositories` row is created (AC2).
 *     A repo the installation was granted always carries Contents:write
 *     under the App's permission set (spec §3), so membership alone answers
 *     the old per-repo `GET /repos/{owner}/{repo}` "can I push?" probe —
 *     there is no partial-access state left to distinguish, so that probe
 *     (and its `no_push` outcome) is gone.
 *
 * Both return discriminated results the route layer translates into HTTP, so
 * the "reconnect" / "rate limited" / "not found" distinctions stay testable
 * without a live token. `"reconnect"` now means "the installation is
 * missing, revoked, or the App token was rejected — send the user through
 * the install-link flow (Task 3's mint endpoint)", not the old OAuth
 * re-consent. The fetch idiom (8s AbortController timeout + `githubHeaders`)
 * mirrors the existing GitHub calls in app/api/v1/runner/repos/route.ts.
 */

const GITHUB_API = "https://api.github.com";

// Same bound + idiom as the other connector-verify fetches in this app (8s).
const GITHUB_FETCH_TIMEOUT_MS = 8000;

// GitHub App installations are grant-scoped (typically well under a few
// hundred repos), but this bounds pagination defensively against a
// pathological installation or a misbehaving API rather than looping
// forever: 50 pages * 100 = 5,000 repos is far beyond any real installation.
const MAX_PAGES = 50;

export interface PickerRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

/** Why a list attempt failed, in terms the UI can act on. */
export type ListReposFailure =
  // Installation token missing/rejected/revoked → send the user through the
  // install-link (re)install flow.
  | { ok: false; kind: "reconnect"; status: number; message: string }
  // Secondary/primary rate limit hit → "try again shortly".
  | { ok: false; kind: "rate_limited"; status: number; message: string }
  // Network error or any other non-2xx → generic.
  | { ok: false; kind: "error"; status: number; message: string };

export type ListReposResult = { ok: true; repos: PickerRepo[] } | ListReposFailure;

export type RepoAccessResult =
  // Repo is a member of the installation's granted repository list.
  | { ok: true }
  // Not in the installation's granted list — doesn't exist, or the
  // installation simply wasn't granted it (GitHub's API can't distinguish
  // the two from an App's point of view, and the remediation is the same
  // either way: add it at the installation, or pick a different repo).
  | { ok: false; kind: "not_found" }
  // The installation list call itself failed (token/rate/network hiccup) —
  // caller cannot conclude, so should NOT block.
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
 * credential/installation problem the user fixes by reconnecting. */
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

/** One page of `GET /installation/repositories`, translated to a
 * `ListReposFailure` on any non-2xx/network outcome, or the page's raw
 * `repositories` array on success. */
async function fetchInstallationRepoPage(
  token: string,
  page: number
): Promise<{ ok: true; repositories: unknown[] } | ListReposFailure> {
  const url = `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`;

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
      message: "GitHub rejected the App installation token — reconnect GitHub to refresh access.",
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
      message: "GitHub denied access to the App installation — reconnect GitHub.",
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

  // `/installation/repositories` responds with a WRAPPER object
  // (`{ total_count, repositories: [...] }`), unlike `/user/repos`'s bare
  // array — the shape this whole function exists to unwrap.
  const wrapper = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const repositories = Array.isArray(wrapper.repositories) ? wrapper.repositories : [];
  return { ok: true, repositories };
}

/**
 * List every repo the workspace's App installation was granted, most of
 * which is what the picker shows (AC1). Fully paginates
 * `GET /installation/repositories` (`per_page=100`, stopping once a page
 * returns fewer than 100 — the standard "was that the last page" signal)
 * rather than exposing a caller-chosen page: an installation's repo set is
 * the full universe the picker needs, not a paged view into something much
 * larger the way a user's cross-org `/user/repos` could be. `q` filters
 * client-side over the fully-aggregated set by substring of `full_name`
 * (case-insensitive).
 */
export async function listInstallationRepos(
  token: string,
  opts: { q?: string } = {}
): Promise<ListReposResult> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await fetchInstallationRepoPage(token, page);
    if (!result.ok) return result;
    all.push(...result.repositories);
    if (result.repositories.length < 100) break;
  }

  let repos = all.map(coerceRepo).filter((r): r is PickerRepo => r !== null);

  const q = opts.q?.trim().toLowerCase();
  if (q) {
    repos = repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }
  return { ok: true, repos };
}

/**
 * Confirm `owner/repo` is a member of the workspace's App installation
 * grant — AgentRail can only ever act through that installation, so
 * membership IS the access check (see the module comment for why the old
 * per-repo push-permission probe is gone). Case-insensitive on `full_name`
 * to match GitHub's own case-insensitive repo naming. A failure of the
 * underlying list call is `indeterminate` so the caller can fall back to
 * regex-only rather than block a legitimate connect on a transient hiccup.
 */
export async function checkRepoAccess(
  token: string,
  owner: string,
  repo: string
): Promise<RepoAccessResult> {
  const result = await listInstallationRepos(token);
  if (!result.ok) return { ok: false, kind: "indeterminate" };

  const target = `${owner}/${repo}`.toLowerCase();
  const found = result.repos.some((r) => r.full_name.toLowerCase() === target);
  return found ? { ok: true } : { ok: false, kind: "not_found" };
}
