/**
 * Squash-merge a PR via GitHub's REST API (issue #1278 PR②) — the
 * permission-ON enforcement step. No `gh` CLI on Railway, so this is a
 * direct `fetch`, mirroring the existing connector-verify fetch idiom in
 * this app (same headers/timeout shape as `githubHeaders`/`fetchWithTimeout`
 * in `app/api/v1/runner/repos/route.ts` — copied locally rather than
 * imported, matching that file's own precedent of not sharing this helper
 * cross-file).
 *
 * SECURITY (non-negotiable, issue #1278 PR② AC2): the runner self-reports
 * `pr_url` on `POST /api/v1/runner/result` — a malicious or compromised
 * runner must never be able to point the console's GitHub token at an
 * arbitrary PR. `parseGithubPrUrl` + `prUrlMatchesQueueEntryRepo` are the
 * gate: a PR URL is only ever handed to `mergePullRequestSquash` after its
 * owner/repo is proven to EXACTLY match the queue entry that produced this
 * result (derived from `queue_entries.external_id`, a server-controlled
 * value the runner never sets — see `repoSlugFromExternalId`'s doc-comment).
 *
 * `mergePullRequestSquash`'s token NEVER appears in a returned or logged
 * value: every failure path returns a closed-union `reason` code, never the
 * raw response body or a caught error's message — same closed-union
 * contract as `connectors/secret/telegram.ts`'s `SendResult`.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agentrail-console",
  };
}

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub PR URL into `{owner, repo, number}`, or `null` for anything
 * that is not EXACTLY `https://github.com/{owner}/{repo}/pull/{n}` — https
 * only, host must be literally `github.com` (no lookalike/subdomain), a
 * well-formed positive integer PR number, no extra path segments/query/hash
 * tolerance beyond what `URL` itself normalizes. This is the FIRST half of
 * the pr_url security gate (see the module doc-comment) — a permissive
 * parse here would undermine the owner/repo check that follows it.
 */
export function parseGithubPrUrl(prUrl: string): ParsedPrUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(prUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return null;
  }
  const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner: m[1]!, repo: m[2]!, number };
}

/**
 * Extract `owner/repo` (lowercased) from a queue entry's `external_id`. The
 * ONLY writer of this shape is `enqueueGithubIssue`
 * (`packages/db-postgres/src/queries/github_intake.ts`:
 * `` `${repoFullName}#${number}` ``) — a server-controlled value set at
 * intake time, never something the runner supplies on result. Returns
 * `null` for anything else (an onboard row's `onboard:owner/name` id, a
 * cli/linear entry, a malformed/legacy id) — the caller treats `null` as
 * "cannot verify", never as a wildcard match.
 */
export function repoSlugFromExternalId(externalId: string): string | null {
  const m = externalId.match(/^([^/\s#]+\/[^/\s#]+)#\d+$/);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The full SECURITY gate (see module doc-comment): `true` only when `prUrl`
 * parses as a genuine GitHub PR URL AND its `owner/repo` EXACTLY matches
 * (case-insensitively) the repo encoded on the queue entry's own
 * `externalId`. Any parse failure on either side is a hard `false` — fail
 * closed, never guess.
 */
export function prUrlMatchesQueueEntryRepo(
  prUrl: string,
  externalId: string
): boolean {
  const parsedPr = parseGithubPrUrl(prUrl);
  if (!parsedPr) return false;
  const entrySlug = repoSlugFromExternalId(externalId);
  if (!entrySlug) return false;
  return `${parsedPr.owner}/${parsedPr.repo}`.toLowerCase() === entrySlug;
}

export type MergeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_mergeable" | "network_error" | "unexpected_response";
      status?: number;
    };

/**
 * Squash-merge `parsed` via `PUT /repos/{owner}/{repo}/pulls/{number}/merge`.
 *
 * The caller MUST have already run `parsed` through
 * `prUrlMatchesQueueEntryRepo` — this function trusts its input and performs
 * no repo-ownership check of its own; it is the mechanical merge step, not
 * the security gate.
 *
 * Never throws; every outcome is a closed union (`MergeResult`), so a
 * network blip or a GitHub-side rejection (branch protection, merge
 * conflict, already merged/closed) is reported the same honest way — the
 * caller decides what "loud log" and "never retry-loop" mean for its own
 * flow (issue #1278 PR② AC3).
 */
export async function mergePullRequestSquash(
  token: string,
  parsed: ParsedPrUrl
): Promise<MergeResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/merge`,
      {
        method: "PUT",
        headers: githubHeaders(token),
        body: JSON.stringify({
          merge_method: "squash",
          commit_title: `AgentRail merge PR #${parsed.number}`,
          commit_message:
            "Merged via AgentRail (merge permission ON, objective gate green).",
        }),
      }
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }

  // 405 (not mergeable — conflicts, blocking checks) and 409 (head sha
  // moved / already merged) are GitHub's documented "can't merge right now"
  // responses, distinct from a genuine transport/auth/unexpected failure.
  if (res.status === 405 || res.status === 409) {
    return { ok: false, reason: "not_mergeable", status: res.status };
  }

  if (!res.ok) {
    return { ok: false, reason: "unexpected_response", status: res.status };
  }

  const body = (await res.json().catch(() => ({}))) as { merged?: unknown };
  if (body?.merged !== true) {
    return { ok: false, reason: "unexpected_response", status: res.status };
  }

  return { ok: true };
}
