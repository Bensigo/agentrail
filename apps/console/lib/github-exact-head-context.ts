import {
  acceptanceContextOverlayManifestSha256,
  type AcceptanceContextOverlayManifestIdentity,
} from "@agentrail/db-postgres";

/**
 * The server-only, read-only GitHub seam for R8.2 Context Pack snapshots.
 *
 * Its caller must resolve the workspace, confirmed Acceptance Record, and
 * immutable correction-packet head before reaching this module. This module
 * deliberately accepts neither a caller ref nor a URL: it can only read the
 * supplied repository's PR metadata, then immutable Git objects keyed by the
 * verified base/head SHAs.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 8000;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_COMPARE_FILES_EXCLUSIVE = 300;
const ALLOWED_FILE_STATUSES = new Set([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
]);

export interface ExactHeadGithubContextInput {
  /** Installation token resolved by the trusted server caller; never returned. */
  token: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
}

export interface ExactHeadChangedFile {
  path: string;
  status: string;
  /** Null is valid only for a removed path. */
  blobSha: string | null;
  previousPath: string | null;
}

export interface ExactHeadGithubContextSnapshot {
  repo: string;
  prNumber: number;
  /** Current exact tip of the PR's base branch at snapshot time. */
  baseSha: string;
  /** Actual three-dot merge base used by GitHub's immutable comparison. */
  mergeBaseSha: string;
  headSha: string;
  headTreeSha: string;
  changedFiles: ExactHeadChangedFile[];
  manifestSha256: string;
  provenance: {
    schemaVersion: 1;
    included: Array<{
      path: string;
      source: "overlay";
      reason: "exact_base_to_head_compare";
    }>;
    excluded: [];
  };
}

export type ExactHeadGithubContextResult =
  | { ok: true; snapshot: ExactHeadGithubContextSnapshot }
  | {
      ok: false;
      kind: "not_proven";
      reason:
        | "invalid_input"
        | "github_unavailable"
        | "github_rejected"
        | "invalid_pr_metadata"
        | "head_mismatch"
        | "invalid_head_commit"
        | "invalid_compare_manifest";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agentrail-console",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGithub(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: githubHeaders(token),
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseCompareManifest(
  value: unknown,
  expectedBaseSha: string
): { changedFiles: ExactHeadChangedFile[]; mergeBaseSha: string } | null {
  if (!isRecord(value) || value["truncated"] === true || !Array.isArray(value["files"])) return null;
  const compareBaseSha =
    isRecord(value["base_commit"]) ? value["base_commit"]["sha"] : null;
  const mergeBaseSha =
    isRecord(value["merge_base_commit"]) ? value["merge_base_commit"]["sha"] : null;
  if (
    !isSha(compareBaseSha) ||
    compareBaseSha.toLowerCase() !== expectedBaseSha ||
    !isSha(mergeBaseSha)
  ) return null;
  const files = value["files"];
  if (files.length === 0 || files.length >= MAX_COMPARE_FILES_EXCLUSIVE) return null;

  const paths = new Set<string>();
  const parsed: ExactHeadChangedFile[] = [];
  for (const file of files) {
    if (!isRecord(file)) return null;
    const path = file["filename"];
    const status = file["status"];
    const rawBlobSha = file["sha"];
    const rawPreviousPath = file["previous_filename"];
    if (!isSafeRelativePath(path) || typeof status !== "string" || !ALLOWED_FILE_STATUSES.has(status)) {
      return null;
    }
    if (paths.has(path)) return null;
    paths.add(path);

    const blobSha = isSha(rawBlobSha) ? rawBlobSha.toLowerCase() : null;
    if (status === "removed") {
      if (rawBlobSha !== undefined && rawBlobSha !== null && blobSha === null) return null;
    } else if (blobSha === null) {
      return null;
    }

    if (status === "renamed") {
      if (!isSafeRelativePath(rawPreviousPath) || rawPreviousPath === path) return null;
    } else if (rawPreviousPath !== undefined && rawPreviousPath !== null) {
      return null;
    }
    parsed.push({
      path,
      status,
      blobSha,
      previousPath: status === "renamed" ? (rawPreviousPath as string) : null,
    });
  }
  return {
    changedFiles: parsed.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ),
    mergeBaseSha: mergeBaseSha.toLowerCase(),
  };
}

/**
 * Resolve an immutable exact-head snapshot. Every failed or ambiguous read is
 * explicitly `not_proven`; this function never falls back to a default branch,
 * stale Wiki, caller-supplied ref, or code search.
 */
export async function readExactHeadGithubContext(
  input: ExactHeadGithubContextInput
): Promise<ExactHeadGithubContextResult> {
  if (
    !input ||
    typeof input.token !== "string" ||
    !input.token.trim() ||
    typeof input.repo !== "string" ||
    !REPO.test(input.repo) ||
    input.repo.split("/").some((segment) => segment === "." || segment === "..") ||
    !Number.isInteger(input.prNumber) ||
    input.prNumber <= 0 ||
    !isSha(input.expectedHeadSha)
  ) {
    return { ok: false, kind: "not_proven", reason: "invalid_input" };
  }
  const headSha = input.expectedHeadSha.toLowerCase();

  let prResponse: Response;
  try {
    prResponse = await fetchGithub(`${GITHUB_API}/repos/${input.repo}/pulls/${input.prNumber}`, input.token);
  } catch {
    return { ok: false, kind: "not_proven", reason: "github_unavailable" };
  }
  if (!prResponse.ok) return { ok: false, kind: "not_proven", reason: "github_rejected" };
  const pr = await readJson(prResponse);
  const actualHead = isRecord(pr) && isRecord(pr["head"]) ? pr["head"]["sha"] : null;
  const baseSha = isRecord(pr) && isRecord(pr["base"]) ? pr["base"]["sha"] : null;
  if (!isSha(actualHead) || !isSha(baseSha)) {
    return { ok: false, kind: "not_proven", reason: "invalid_pr_metadata" };
  }
  if (actualHead.toLowerCase() !== headSha) {
    return { ok: false, kind: "not_proven", reason: "head_mismatch" };
  }

  let commitResponse: Response;
  try {
    commitResponse = await fetchGithub(`${GITHUB_API}/repos/${input.repo}/git/commits/${headSha}`, input.token);
  } catch {
    return { ok: false, kind: "not_proven", reason: "github_unavailable" };
  }
  if (!commitResponse.ok) return { ok: false, kind: "not_proven", reason: "github_rejected" };
  const commit = await readJson(commitResponse);
  const commitSha = isRecord(commit) ? commit["sha"] : null;
  const headTreeSha = isRecord(commit) && isRecord(commit["tree"]) ? commit["tree"]["sha"] : null;
  if (!isSha(commitSha) || commitSha.toLowerCase() !== headSha || !isSha(headTreeSha)) {
    return { ok: false, kind: "not_proven", reason: "invalid_head_commit" };
  }

  const normalizedBaseSha = baseSha.toLowerCase();
  let compareResponse: Response;
  try {
    compareResponse = await fetchGithub(
      `${GITHUB_API}/repos/${input.repo}/compare/${normalizedBaseSha}...${headSha}`,
      input.token
    );
  } catch {
    return { ok: false, kind: "not_proven", reason: "github_unavailable" };
  }
  if (!compareResponse.ok) return { ok: false, kind: "not_proven", reason: "github_rejected" };
  const compareManifest = parseCompareManifest(await readJson(compareResponse), normalizedBaseSha);
  if (compareManifest === null) {
    return { ok: false, kind: "not_proven", reason: "invalid_compare_manifest" };
  }

  const normalizedHeadTreeSha = headTreeSha.toLowerCase();
  return {
    ok: true,
    snapshot: {
      repo: input.repo,
      prNumber: input.prNumber,
      baseSha: normalizedBaseSha,
      mergeBaseSha: compareManifest.mergeBaseSha,
      headSha,
      headTreeSha: normalizedHeadTreeSha,
      changedFiles: compareManifest.changedFiles,
      manifestSha256: acceptanceContextOverlayManifestSha256({
        schemaVersion: 1,
        baseSha: normalizedBaseSha,
        mergeBaseSha: compareManifest.mergeBaseSha,
        headSha,
        files: compareManifest.changedFiles as AcceptanceContextOverlayManifestIdentity["files"],
      }),
      provenance: {
        schemaVersion: 1,
        included: compareManifest.changedFiles.map(({ path }) => ({
          path,
          source: "overlay",
          reason: "exact_base_to_head_compare",
        })),
        excluded: [],
      },
    },
  };
}
