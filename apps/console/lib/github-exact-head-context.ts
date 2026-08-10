import {
  acceptanceContextOverlayHeadRangeCoordinateSha256,
  acceptanceContextPackCustodyOverlayManifestSha256,
  acceptanceContextOverlayManifestSha256,
  type AcceptanceContextPackCustodyOverlayManifestIdentity,
  type AcceptanceContextOverlayManifestIdentity,
} from "@agentrail/db-postgres";
import { createHash } from "node:crypto";

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
export const MAX_EXACT_HEAD_PR_RESPONSE_BYTES = 256 * 1024;
export const MAX_EXACT_HEAD_COMMIT_RESPONSE_BYTES = 64 * 1024;
export const MAX_EXACT_HEAD_COMPARE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_EXACT_HEAD_PATCH_RANGES = 128;
export const MAX_EXACT_HEAD_PATCH_LINE = 1_000_000;
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
  /** Normalized HEAD-side unified-diff ranges; null when GitHub supplied no usable patch. */
  headRanges?: Array<{ startLine: number; endLine: number }> | null;
  /** SHA-256 of GitHub's raw patch, retained without retaining the raw patch itself. */
  patchSha256?: string | null;
  /** UTF-8 byte length of the discarded raw patch. */
  patchByteCount?: number | null;
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

/**
 * Projects the exact GitHub comparison into the v2 DB custody identity. The
 * legacy v1 manifest remains available for #1657 compatibility, while this
 * digest commits the discarded patch's size, hash, and normalized HEAD lines.
 */
export function exactHeadContextCustodyOverlay(
  snapshot: ExactHeadGithubContextSnapshot
): AcceptanceContextPackCustodyOverlayManifestIdentity | null {
  if (!snapshot || !isSha(snapshot.baseSha) || !isSha(snapshot.mergeBaseSha) || !isSha(snapshot.headSha)
    || !Array.isArray(snapshot.changedFiles) || snapshot.changedFiles.length < 1
    || snapshot.changedFiles.length >= MAX_COMPARE_FILES_EXCLUSIVE) return null;
  const files: AcceptanceContextPackCustodyOverlayManifestIdentity["files"] = [];
  for (const file of snapshot.changedFiles) {
    if (!isSafeRelativePath(file.path) || !ALLOWED_FILE_STATUSES.has(file.status)
      || (file.status === "removed" ? file.blobSha !== null : !isSha(file.blobSha))
      || (file.status === "renamed"
        ? !isSafeRelativePath(file.previousPath) || file.previousPath === file.path
        : file.previousPath !== null)) return null;
    const noPatch = file.patchSha256 === null && file.patchByteCount === null && file.headRanges === null;
    const hasPatch = typeof file.patchSha256 === "string" && /^[a-f0-9]{64}$/iu.test(file.patchSha256)
      && Number.isSafeInteger(file.patchByteCount) && (file.patchByteCount as number) > 0
      && (file.patchByteCount as number) <= MAX_EXACT_HEAD_COMPARE_RESPONSE_BYTES
      && Array.isArray(file.headRanges) && file.headRanges.length > 0
      && file.headRanges.length <= MAX_EXACT_HEAD_PATCH_RANGES;
    if (!noPatch && !hasPatch) return null;
    const ranges = noPatch ? [] : file.headRanges!;
    if (ranges.some((range, index) => !Number.isSafeInteger(range.startLine)
      || !Number.isSafeInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine
      || range.endLine > MAX_EXACT_HEAD_PATCH_LINE
      || (index > 0 && ranges[index - 1]!.endLine >= range.startLine))) return null;
    files.push({
      path: file.path,
      status: file.status as AcceptanceContextPackCustodyOverlayManifestIdentity["files"][number]["status"],
      blobSha: file.blobSha?.toLowerCase() ?? null,
      previousPath: file.previousPath,
      patchSha256: noPatch ? null : file.patchSha256!.toLowerCase(),
      patchByteCount: noPatch ? null : file.patchByteCount!,
      headRanges: ranges.map(({ startLine, endLine }) => ({
        startLine,
        endLine,
        coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({
          path: file.path,
          patchSha256: file.patchSha256!,
          startLine,
          endLine,
        }),
      })),
    });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(files.map(({ path }) => path)).size !== files.length) return null;
  const core = {
    schemaVersion: 2 as const,
    baseSha: snapshot.baseSha.toLowerCase(),
    mergeBaseSha: snapshot.mergeBaseSha.toLowerCase(),
    headSha: snapshot.headSha.toLowerCase(),
    files,
  };
  return {
    ...core,
    manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(core),
  };
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

async function fetchGithubJson(url: string, token: string, maxBytes: number): Promise<GithubJsonRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: githubHeaders(token),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "github_rejected" };
    const value = await cappedJson(response, maxBytes);
    return value === null ? { ok: false, reason: "invalid_response" } : { ok: true, value };
  } catch {
    return { ok: false, reason: "github_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

async function cappedJson(response: Response, maxBytes: number): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) return null;
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
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* bounded failure remains invalid */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    // Transport/body aborts are retryable availability failures, not malformed
    // immutable Git data. The outer fixed-host reader collapses the error.
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

function parseHunkCoordinate(start: string, count: string | undefined): { start: number; count: number } | null {
  if (!/^\d+$/.test(start) || (count !== undefined && !/^\d+$/.test(count))) return null;
  const parsedStart = Number(start);
  const parsedCount = count === undefined ? 1 : Number(count);
  if (!Number.isSafeInteger(parsedStart) || !Number.isSafeInteger(parsedCount)
    || parsedCount < 0 || parsedCount > MAX_EXACT_HEAD_PATCH_LINE
    || (parsedCount === 0 ? parsedStart > MAX_EXACT_HEAD_PATCH_LINE : parsedStart < 1 || parsedStart > MAX_EXACT_HEAD_PATCH_LINE)
    || (parsedCount > 0 && parsedStart + parsedCount - 1 > MAX_EXACT_HEAD_PATCH_LINE)) return null;
  return { start: parsedStart, count: parsedCount };
}

function parseHeadRanges(rawPatch: unknown): {
  headRanges: Array<{ startLine: number; endLine: number }> | null;
  patchSha256: string | null;
  patchByteCount: number | null;
} | null {
  if (rawPatch === undefined || rawPatch === null) {
    return { headRanges: null, patchSha256: null, patchByteCount: null };
  }
  if (typeof rawPatch !== "string") return null;
  if (rawPatch.length === 0) return null;
  const patchSha256 = createHash("sha256").update(rawPatch, "utf8").digest("hex");
  const patchByteCount = Buffer.byteLength(rawPatch, "utf8");

  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let hunkCount = 0;
  for (const rawLine of rawPatch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("@@")) continue;
    hunkCount += 1;
    if (hunkCount > MAX_EXACT_HEAD_PATCH_RANGES) return null;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (!match) return null;
    const oldRange = parseHunkCoordinate(match[1]!, match[2]);
    const headRange = parseHunkCoordinate(match[3]!, match[4]);
    if (oldRange === null || headRange === null) return null;
    if (headRange.count > 0) ranges.push({ startLine: headRange.start, endLine: headRange.start + headRange.count - 1 });
  }
  ranges.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push(range);
  }
  if (merged.length === 0) return null;
  return { headRanges: merged, patchSha256, patchByteCount };
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
    const patch = status === "removed"
      ? { headRanges: null, patchSha256: null, patchByteCount: null }
      : parseHeadRanges(file["patch"]);
    if (patch === null) return null;
    parsed.push({
      path,
      status,
      blobSha,
      previousPath: status === "renamed" ? (rawPreviousPath as string) : null,
      ...patch,
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

  const prRead = await fetchGithubJson(
    `${GITHUB_API}/repos/${input.repo}/pulls/${input.prNumber}`,
    input.token,
    MAX_EXACT_HEAD_PR_RESPONSE_BYTES
  );
  if (!prRead.ok) return { ok: false, kind: "not_proven", reason: prRead.reason === "invalid_response" ? "invalid_pr_metadata" : prRead.reason };
  const pr = prRead.value;
  const actualHead = isRecord(pr) && isRecord(pr["head"]) ? pr["head"]["sha"] : null;
  const baseSha = isRecord(pr) && isRecord(pr["base"]) ? pr["base"]["sha"] : null;
  if (!isSha(actualHead) || !isSha(baseSha)) {
    return { ok: false, kind: "not_proven", reason: "invalid_pr_metadata" };
  }
  if (actualHead.toLowerCase() !== headSha) {
    return { ok: false, kind: "not_proven", reason: "head_mismatch" };
  }

  const commitRead = await fetchGithubJson(
    `${GITHUB_API}/repos/${input.repo}/git/commits/${headSha}`,
    input.token,
    MAX_EXACT_HEAD_COMMIT_RESPONSE_BYTES
  );
  if (!commitRead.ok) return { ok: false, kind: "not_proven", reason: commitRead.reason === "invalid_response" ? "invalid_head_commit" : commitRead.reason };
  const commit = commitRead.value;
  const commitSha = isRecord(commit) ? commit["sha"] : null;
  const headTreeSha = isRecord(commit) && isRecord(commit["tree"]) ? commit["tree"]["sha"] : null;
  if (!isSha(commitSha) || commitSha.toLowerCase() !== headSha || !isSha(headTreeSha)) {
    return { ok: false, kind: "not_proven", reason: "invalid_head_commit" };
  }

  const normalizedBaseSha = baseSha.toLowerCase();
  const compareRead = await fetchGithubJson(
    `${GITHUB_API}/repos/${input.repo}/compare/${normalizedBaseSha}...${headSha}`,
    input.token,
    MAX_EXACT_HEAD_COMPARE_RESPONSE_BYTES
  );
  if (!compareRead.ok) return { ok: false, kind: "not_proven", reason: compareRead.reason === "invalid_response" ? "invalid_compare_manifest" : compareRead.reason };
  const compareManifest = parseCompareManifest(compareRead.value, normalizedBaseSha);
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
        files: compareManifest.changedFiles.map(({ path, status, blobSha, previousPath }) => ({
          path,
          status: status as AcceptanceContextOverlayManifestIdentity["files"][number]["status"],
          blobSha,
          previousPath,
        })),
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
