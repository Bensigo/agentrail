/**
 * Server-only, read-only current-PR seam used to reconcile a signed but stale
 * webhook delivery. It deliberately accepts a bound repository and PR number,
 * never a caller-provided URL or ref, and it never returns an installation
 * token or GitHub response body.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 8_000;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
export const MAX_CURRENT_PR_RESPONSE_BYTES = 256 * 1024;

export interface CurrentGithubPullRequestInput {
  /** Installation token supplied by a trusted server caller; never returned. */
  token: string;
  repo: string;
  prNumber: number;
}

export interface CurrentGithubPullRequest {
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
}

export type CurrentGithubPullRequestResult =
  | { ok: true; pullRequest: CurrentGithubPullRequest }
  | {
      ok: false;
      kind: "not_proven";
      reason:
        | "invalid_input"
        | "github_unavailable"
        | "github_rejected"
        | "invalid_pr_metadata";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agentrail-console",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

type GithubJsonRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: "github_unavailable" | "github_rejected" | "invalid_response" };

async function cappedJson(response: Response): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CURRENT_PR_RESPONSE_BYTES)
  ) return null;

  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CURRENT_PR_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* malformed response remains bounded */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    throw new Error("github response body unavailable");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

async function readGithubJson(url: string, token: string): Promise<GithubJsonRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: githubHeaders(token),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "github_rejected" };
    const value = await cappedJson(response);
    return value === null
      ? { ok: false, reason: "invalid_response" }
      : { ok: true, value };
  } catch {
    return { ok: false, reason: "github_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read and validate the current target-repository PR metadata. A closed,
 * merged, malformed, redirected, oversized, or unavailable response is not
 * authority for custody restoration.
 */
export async function readCurrentGithubPullRequest(
  input: CurrentGithubPullRequestInput
): Promise<CurrentGithubPullRequestResult> {
  if (
    !input ||
    typeof input.token !== "string" || !input.token.trim() ||
    typeof input.repo !== "string" || !REPO.test(input.repo) ||
    input.repo.split("/").some((segment) => segment === "." || segment === "..") ||
    !Number.isInteger(input.prNumber) || input.prNumber <= 0
  ) return { ok: false, kind: "not_proven", reason: "invalid_input" };

  const read = await readGithubJson(
    `${GITHUB_API}/repos/${input.repo}/pulls/${input.prNumber}`,
    input.token
  );
  if (!read.ok) {
    return {
      ok: false,
      kind: "not_proven",
      reason: read.reason === "invalid_response" ? "invalid_pr_metadata" : read.reason,
    };
  }

  const pr = read.value;
  const head = isRecord(pr) ? pr.head : null;
  const base = isRecord(pr) ? pr.base : null;
  const baseRepo = isRecord(base) ? base.repo : null;
  const expectedUrl = `https://github.com/${input.repo}/pull/${input.prNumber}`;
  if (
    !isRecord(pr) ||
    pr.number !== input.prNumber ||
    pr.html_url !== expectedUrl ||
    !isRecord(head) || !isSha(head.sha) ||
    !isRecord(base) || !isSha(base.sha) ||
    !isRecord(baseRepo) || baseRepo.full_name !== input.repo ||
    typeof pr.draft !== "boolean" ||
    typeof pr.state !== "string" ||
    typeof pr.merged !== "boolean" ||
    (pr.state !== "open" && pr.state !== "closed") ||
    (pr.state === "open" && pr.merged !== false)
  ) return { ok: false, kind: "not_proven", reason: "invalid_pr_metadata" };

  return {
    ok: true,
    pullRequest: {
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: head.sha.toLowerCase(),
      baseSha: base.sha.toLowerCase(),
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      htmlUrl: expectedUrl,
    },
  };
}
