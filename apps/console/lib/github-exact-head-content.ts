import { createHash } from "node:crypto";
import { acceptanceContextOverlayManifestSha256 } from "@agentrail/db-postgres";
import { scanForSecrets } from "./secret-scan";
import type { ExactHeadGithubContextSnapshot } from "./github-exact-head-context";

/** This module is deliberately an ephemeral read boundary: it never persists a Pack. */
const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 8_000;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_MODE = new Set(["100644", "100755"]);
const CHANGED_STATUSES = ["added", "modified", "removed", "renamed", "copied", "changed"] as const;
type ChangedStatus = (typeof CHANGED_STATUSES)[number];

/** Smaller than GitHub's 100,000-entry / 7MiB recursive-tree ceiling. */
export const MAX_EXACT_HEAD_TREE_ENTRIES = 10_000;
export const MAX_EXACT_HEAD_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_EXACT_HEAD_SOURCE_FILES = 128;
export const MAX_EXACT_HEAD_FILE_BYTES = 256 * 1024;
export const MAX_EXACT_HEAD_SOURCE_BYTES = 1024 * 1024;
export const MAX_EXACT_HEAD_DIRECT_PATH_READS = 16;
export const MAX_EXACT_HEAD_DIRECT_PATH_BYTES = 512 * 1024;
export const MAX_EXACT_HEAD_SECRET_FINDINGS = 1024;
export const MAX_EXACT_HEAD_GITHUB_CALLS =
  1 + MAX_EXACT_HEAD_SOURCE_FILES + MAX_EXACT_HEAD_DIRECT_PATH_READS;
/** Includes bounded JSON framing around a canonical base64 blob. */
export const MAX_EXACT_HEAD_BLOB_RESPONSE_BYTES = Math.ceil(MAX_EXACT_HEAD_FILE_BYTES / 3) * 4 + 16 * 1024;

export interface ExactHeadContentRecord {
  path: string;
  blobSha: string;
  previousPath: string | null;
  /** SHA-256 of the returned byte-exact UTF-8 content. */
  contentSha256: string;
  /** Byte length of the verified raw Git blob. */
  byteCount: number;
  lineCount: number;
  content: string;
  source: "exact_head_overlay" | "exact_head_tree_fallback";
  reason: "exact_base_to_head_compare" | "exact_head_tree_path";
}

export interface ExactHeadContentExclusion {
  path: string;
  source: "exact_head_overlay" | "exact_head_tree_fallback";
  blobSha: string | null;
  byteCount: number | null;
  reason: "removed_at_exact_head" | "secret_path_policy" | "secret_content_policy";
  secretKinds: string[];
  findingCount: number;
}

export type ExactHeadContentReadResult =
  | { ok: true; record: ExactHeadContentRecord }
  | { ok: false; kind: "not_proven"; reason: ExactHeadContentFailureReason; exclusion?: ExactHeadContentExclusion };

export type ExactHeadContentFailureReason =
  | "invalid_input"
  | "github_unavailable"
  | "github_rejected"
  | "invalid_tree"
  | "tree_limit"
  | "call_limit"
  | "invalid_blob"
  | "content_limit"
  | "unsafe_content"
  | "unsafe_path";

export type ExactHeadContentMaterializationResult =
  | {
      ok: true;
      materialization: {
        /** Ephemeral full-file content plus deterministic custody data. Only identity/provenance may later persist. */
        content: {
          /** Persistable identity only: never a closure, token, or raw/redacted full-file content. */
          identitySha256: string;
          headTreeSha: string;
          records: ExactHeadContentRecord[];
          exclusions: ExactHeadContentExclusion[];
        };
        /** A path-only, exact-head resolver; it accepts neither a ref nor a SHA. */
        readExactPath: (path: string) => Promise<ExactHeadContentReadResult>;
      };
    }
  | { ok: false; kind: "not_proven"; reason: ExactHeadContentFailureReason; exclusions: ExactHeadContentExclusion[] };

interface VerifiedTreeEntry {
  path: string;
  sha: string;
  size: number;
  mode: string;
  type: string;
}

interface VerifiedTree {
  byPath: Map<string, VerifiedTreeEntry>;
}

interface ReadState {
  calls: number;
  fallbackReads: number;
  fallbackBytes: number;
}

type GithubJsonRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: "github_unavailable" | "github_rejected" | "invalid_response" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function pathKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isSecretPath(path: string): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  return basename === ".env" || basename.startsWith(".env.")
    || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(basename)
    || basename === "id_rsa" || basename === "id_ed25519"
    || lower.includes("credential") || /(?:^|\/)(?:secrets?|private)(?:\/|$)/.test(lower);
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agentrail-console",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGithubJson(url: string, token: string, maxBytes: number): Promise<GithubJsonRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: headers(token), redirect: "error", signal: controller.signal });
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
    return null;
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

function invalidInput(snapshot: ExactHeadGithubContextSnapshot): boolean {
  if (!REPO.test(snapshot.repo) || snapshot.repo.split("/").some((part) => part === "." || part === "..")
    || !Number.isInteger(snapshot.prNumber) || snapshot.prNumber <= 0
    || !isSha(snapshot.headSha) || !isSha(snapshot.headTreeSha) || !isSha(snapshot.baseSha) || !isSha(snapshot.mergeBaseSha)) return true;
  const seen = new Set<string>();
  let previousPath: string | null = null;
  for (const file of snapshot.changedFiles) {
    if (!isSafePath(file.path) || seen.has(pathKey(file.path)) || !(CHANGED_STATUSES as readonly string[]).includes(file.status)) return true;
    if (previousPath !== null && previousPath >= file.path) return true;
    previousPath = file.path;
    seen.add(pathKey(file.path));
    if (file.status === "removed") {
      if ((file.blobSha !== null && !isSha(file.blobSha)) || file.previousPath !== null) return true;
    } else if (!isSha(file.blobSha) || (file.status === "renamed" && (!isSafePath(file.previousPath) || file.previousPath === file.path))
      || (file.status !== "renamed" && file.previousPath !== null)) return true;
  }
  return false;
}

function hasValidManifest(snapshot: ExactHeadGithubContextSnapshot): boolean {
  const files = [...snapshot.changedFiles]
    .map((file) => ({
      path: file.path,
      status: file.status as ChangedStatus,
      blobSha: file.blobSha === null ? null : file.blobSha.toLowerCase(),
      previousPath: file.previousPath,
    }));
  return snapshot.manifestSha256 === acceptanceContextOverlayManifestSha256({
    schemaVersion: 1,
    baseSha: snapshot.baseSha.toLowerCase(),
    mergeBaseSha: snapshot.mergeBaseSha.toLowerCase(),
    headSha: snapshot.headSha.toLowerCase(),
    files,
  });
}

function parseVerifiedTree(value: unknown, snapshot: ExactHeadGithubContextSnapshot): VerifiedTree | "tree_limit" | null {
  if (!isRecord(value) || value["truncated"] !== false || !isSha(value["sha"])
    || value["sha"].toLowerCase() !== snapshot.headTreeSha.toLowerCase() || !Array.isArray(value["tree"])) return null;
  if (value["tree"].length > MAX_EXACT_HEAD_TREE_ENTRIES) return "tree_limit";
  const byPath = new Map<string, VerifiedTreeEntry>();
  const normalized = new Set<string>();
  for (const item of value["tree"]) {
    if (!isRecord(item) || !isSafePath(item["path"]) || !isSha(item["sha"])
      || typeof item["mode"] !== "string" || typeof item["type"] !== "string") return null;
    const path = item["path"];
    const key = pathKey(path);
    if (byPath.has(path) || normalized.has(key)) return null;
    normalized.add(key);
    const type = item["type"];
    const mode = item["mode"];
    const size = item["size"];
    if (type === "blob") {
      if (SAFE_MODE.has(mode) && (!Number.isSafeInteger(size) || (size as number) < 0)) return null;
      if (!SAFE_MODE.has(mode)) {
        // Unsafe blob modes are never admissible source material.
        byPath.set(path, { path, sha: item["sha"].toLowerCase(), size: -1, mode, type });
      } else {
        byPath.set(path, { path, sha: item["sha"].toLowerCase(), size: size as number, mode, type });
      }
    } else if (type === "tree" || type === "commit") {
      byPath.set(path, { path, sha: item["sha"].toLowerCase(), size: -1, mode, type });
    } else return null;
  }
  return { byPath };
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function decodeCanonicalBase64(content: unknown, declaredSize: unknown): Uint8Array | null {
  if (typeof content !== "string" || !Number.isSafeInteger(declaredSize) || (declaredSize as number) < 0) return null;
  // GitHub can wrap base64 in CR/LF. No spaces, tabs, lone CR, leading/repeated breaks, or mixed wrap widths are accepted.
  if (content.includes("\r") && !content.includes("\r\n")) return null;
  if (content === "") return declaredSize === 0 ? new Uint8Array() : null;
  const wrapped = content.endsWith("\r\n") ? content.slice(0, -2) : content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = wrapped.split(/\r?\n/);
  if (lines.some((line) => line.length === 0) || lines.some((line) => !/^[A-Za-z0-9+/=]+$/.test(line))) return null;
  if (lines.length > 1) {
    const width = lines[0]!.length;
    if (width < 4 || width > 76 || width % 4 !== 0 || lines.slice(0, -1).some((line) => line.length !== width)) return null;
  }
  const normalized = wrapped.replace(/\r?\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) return null;
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.byteLength !== declaredSize || bytes.toString("base64") !== normalized) return null;
  return bytes;
}

function safeDecodedText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return Buffer.from(content, "utf8").equals(Buffer.from(bytes)) ? content : null;
  } catch {
    return null;
  }
}

function exactRecord(input: {
  path: string;
  blobSha: string;
  previousPath: string | null;
  bytes: Uint8Array;
  content: string;
  source: ExactHeadContentRecord["source"];
  reason: ExactHeadContentRecord["reason"];
}): ExactHeadContentRecord {
  return {
    path: input.path,
    blobSha: input.blobSha,
    previousPath: input.previousPath,
    contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
    byteCount: input.bytes.byteLength,
    lineCount: input.content.split("\n").length,
    content: input.content,
    source: input.source,
    reason: input.reason,
  };
}

function secretExclusion(input: {
  path: string;
  source: ExactHeadContentExclusion["source"];
  blobSha: string | null;
  byteCount: number | null;
  reason: "secret_path_policy" | "secret_content_policy";
  secretKinds?: string[];
  findingCount?: number;
}): ExactHeadContentExclusion {
  return {
    path: input.path,
    source: input.source,
    blobSha: input.blobSha,
    byteCount: input.byteCount,
    reason: input.reason,
    secretKinds: Array.from(new Set(input.secretKinds ?? [])).sort().slice(0, 16),
    findingCount: Math.min(input.findingCount ?? 0, MAX_EXACT_HEAD_SECRET_FINDINGS),
  };
}

async function readBlob(input: {
  token: string;
  repo: string;
  entry: VerifiedTreeEntry;
  previousPath: string | null;
  state: ReadState;
  source: ExactHeadContentRecord["source"];
  reason: ExactHeadContentRecord["reason"];
}): Promise<ExactHeadContentReadResult> {
  if (input.state.calls >= MAX_EXACT_HEAD_GITHUB_CALLS) return { ok: false, kind: "not_proven", reason: "call_limit" };
  if (!SAFE_MODE.has(input.entry.mode) || input.entry.type !== "blob" || input.entry.size > MAX_EXACT_HEAD_FILE_BYTES) {
    return { ok: false, kind: "not_proven", reason: input.entry.size > MAX_EXACT_HEAD_FILE_BYTES ? "content_limit" : "unsafe_content" };
  }
  input.state.calls += 1;
  const fetched = await fetchGithubJson(`${GITHUB_API}/repos/${input.repo}/git/blobs/${input.entry.sha}`, input.token, MAX_EXACT_HEAD_BLOB_RESPONSE_BYTES);
  if (!fetched.ok) return { ok: false, kind: "not_proven", reason: fetched.reason === "invalid_response" ? "invalid_blob" : fetched.reason };
  const value = fetched.value;
  if (!isRecord(value) || !isSha(value["sha"]) || value["sha"].toLowerCase() !== input.entry.sha
    || value["encoding"] !== "base64" || value["size"] !== input.entry.size) {
    return { ok: false, kind: "not_proven", reason: "invalid_blob" };
  }
  const bytes = decodeCanonicalBase64(value["content"], value["size"]);
  if (bytes === null || gitBlobSha(bytes) !== input.entry.sha) return { ok: false, kind: "not_proven", reason: "invalid_blob" };
  const content = safeDecodedText(bytes);
  if (content === null) return { ok: false, kind: "not_proven", reason: "unsafe_content" };
  const scan = scanForSecrets(content);
  if (!scan.clean) {
    return {
      ok: false,
      kind: "not_proven",
      reason: "unsafe_content",
      exclusion: secretExclusion({
        path: input.entry.path,
        source: input.source,
        blobSha: input.entry.sha,
        byteCount: bytes.byteLength,
        reason: "secret_content_policy",
        secretKinds: Array.from(new Set(scan.findings.map((finding) => finding.kind))),
        findingCount: scan.findings.length,
      }),
    };
  }
  return { ok: true, record: exactRecord({ path: input.entry.path, blobSha: input.entry.sha, previousPath: input.previousPath, bytes, content, source: input.source, reason: input.reason }) };
}

function materializationIdentity(input: {
  snapshot: ExactHeadGithubContextSnapshot;
  records: ExactHeadContentRecord[];
  exclusions: ExactHeadContentExclusion[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "exact_head_content_materialization",
    schemaVersion: 1,
    policy: {
      treeEntries: MAX_EXACT_HEAD_TREE_ENTRIES,
      treeResponseBytes: MAX_EXACT_HEAD_TREE_RESPONSE_BYTES,
      sourceFiles: MAX_EXACT_HEAD_SOURCE_FILES,
      fileBytes: MAX_EXACT_HEAD_FILE_BYTES,
      sourceBytes: MAX_EXACT_HEAD_SOURCE_BYTES,
      directPathReads: MAX_EXACT_HEAD_DIRECT_PATH_READS,
      directPathBytes: MAX_EXACT_HEAD_DIRECT_PATH_BYTES,
      secretFindings: MAX_EXACT_HEAD_SECRET_FINDINGS,
      githubCalls: MAX_EXACT_HEAD_GITHUB_CALLS,
    },
    repo: input.snapshot.repo,
    headSha: input.snapshot.headSha.toLowerCase(),
    headTreeSha: input.snapshot.headTreeSha.toLowerCase(),
    manifestSha256: input.snapshot.manifestSha256,
    records: input.records.map(({ path, blobSha, previousPath, contentSha256, byteCount, lineCount, source, reason }) => ({ path, blobSha, previousPath, contentSha256, byteCount, lineCount, source, reason })),
    exclusions: input.exclusions,
  })).digest("hex");
}

/**
 * Fetches and materializes only a prior-admitted snapshot's changed exact-head blobs.
 * A failure has no Wiki/default-ref fallback: it is always `not_proven`.
 */
export async function materializeExactHeadGithubContent(input: {
  token: string;
  snapshot: ExactHeadGithubContextSnapshot;
}): Promise<ExactHeadContentMaterializationResult> {
  const exclusions: ExactHeadContentExclusion[] = [];
  if (!input || typeof input.token !== "string" || !input.token.trim() || !input.snapshot || invalidInput(input.snapshot) || !hasValidManifest(input.snapshot)) {
    return { ok: false, kind: "not_proven", reason: "invalid_input", exclusions };
  }
  const { snapshot } = input;
  const current = snapshot.changedFiles.filter((file) => file.status !== "removed");
  for (const file of snapshot.changedFiles) if (file.status === "removed") exclusions.push({
    path: file.path,
    source: "exact_head_overlay",
    blobSha: file.blobSha,
    byteCount: null,
    reason: "removed_at_exact_head",
    secretKinds: [],
    findingCount: 0,
  });
  if (current.length > MAX_EXACT_HEAD_SOURCE_FILES) return { ok: false, kind: "not_proven", reason: "content_limit", exclusions };
  const secretPathFile = current.find((file) => isSecretPath(file.path) || (file.status === "renamed" && isSecretPath(file.previousPath!)));
  if (secretPathFile) {
    return {
      ok: false,
      kind: "not_proven",
      reason: "unsafe_path",
      exclusions: [...exclusions, secretExclusion({
        path: secretPathFile.path,
        source: "exact_head_overlay",
        blobSha: secretPathFile.blobSha,
        byteCount: null,
        reason: "secret_path_policy",
      })].sort((left, right) => comparePath(left.path, right.path)),
    };
  }

  const state: ReadState = { calls: 0, fallbackReads: 0, fallbackBytes: 0 };
  state.calls += 1;
  const fetchedTree = await fetchGithubJson(`${GITHUB_API}/repos/${snapshot.repo}/git/trees/${snapshot.headTreeSha.toLowerCase()}?recursive=1`, input.token, MAX_EXACT_HEAD_TREE_RESPONSE_BYTES);
  if (!fetchedTree.ok) return { ok: false, kind: "not_proven", reason: fetchedTree.reason === "invalid_response" ? "invalid_tree" : fetchedTree.reason, exclusions };
  const tree = parseVerifiedTree(fetchedTree.value, snapshot);
  if (tree === "tree_limit") return { ok: false, kind: "not_proven", reason: "tree_limit", exclusions };
  if (tree === null) return { ok: false, kind: "not_proven", reason: "invalid_tree", exclusions };

  const entries: Array<{ entry: VerifiedTreeEntry; previousPath: string | null }> = [];
  for (const file of current) {
    const entry = tree.byPath.get(file.path);
    if (!entry || entry.sha !== file.blobSha!.toLowerCase() || entry.type !== "blob" || !SAFE_MODE.has(entry.mode)) {
      return { ok: false, kind: "not_proven", reason: "invalid_tree", exclusions };
    }
    entries.push({ entry, previousPath: file.previousPath });
  }
  for (const removed of snapshot.changedFiles.filter((file) => file.status === "removed")) {
    if (tree.byPath.has(removed.path)) return { ok: false, kind: "not_proven", reason: "invalid_tree", exclusions };
  }
  if (entries.some(({ entry }) => entry.size > MAX_EXACT_HEAD_FILE_BYTES)
    || entries.reduce((total, { entry }) => total + entry.size, 0) > MAX_EXACT_HEAD_SOURCE_BYTES) {
    return { ok: false, kind: "not_proven", reason: "content_limit", exclusions };
  }

  const records: ExactHeadContentRecord[] = [];
  for (const { entry, previousPath } of entries.sort((left, right) => comparePath(left.entry.path, right.entry.path))) {
    const read = await readBlob({ token: input.token, repo: snapshot.repo, entry, previousPath, state, source: "exact_head_overlay", reason: "exact_base_to_head_compare" });
    if (!read.ok) return {
      ok: false,
      kind: "not_proven",
      reason: read.reason,
      exclusions: read.exclusion
        ? [...exclusions, read.exclusion].sort((left, right) => comparePath(left.path, right.path))
        : exclusions,
    };
    records.push(read.record);
  }

  const cachedRecords = new Map(records.map((record) => [record.path, record]));
  const readExactPath = async (path: string): Promise<ExactHeadContentReadResult> => {
    if (!isSafePath(path)) return { ok: false, kind: "not_proven", reason: "unsafe_path" };
    if (isSecretPath(path)) {
      const deniedEntry = tree.byPath.get(path);
      return {
        ok: false,
        kind: "not_proven",
        reason: "unsafe_path",
        exclusion: secretExclusion({
          path,
          source: "exact_head_tree_fallback",
          blobSha: deniedEntry?.type === "blob" ? deniedEntry.sha : null,
          byteCount: null,
          reason: "secret_path_policy",
        }),
      };
    }
    const cached = cachedRecords.get(path);
    if (cached) return { ok: true, record: cached };
    const entry = tree.byPath.get(path);
    if (!entry || entry.type !== "blob" || !SAFE_MODE.has(entry.mode)) return { ok: false, kind: "not_proven", reason: "invalid_tree" };
    if (state.fallbackReads >= MAX_EXACT_HEAD_DIRECT_PATH_READS) return { ok: false, kind: "not_proven", reason: "call_limit" };
    if (entry.size > MAX_EXACT_HEAD_FILE_BYTES || state.fallbackBytes + entry.size > MAX_EXACT_HEAD_DIRECT_PATH_BYTES) {
      return { ok: false, kind: "not_proven", reason: "content_limit" };
    }
    state.fallbackReads += 1;
    const read = await readBlob({ token: input.token, repo: snapshot.repo, entry, previousPath: null, state, source: "exact_head_tree_fallback", reason: "exact_head_tree_path" });
    if (read.ok) {
      state.fallbackBytes += read.record.byteCount;
      cachedRecords.set(path, read.record);
    }
    return read;
  };
  const sortedExclusions = exclusions.sort((left, right) => comparePath(left.path, right.path));
  return {
    ok: true,
    materialization: {
      content: {
        identitySha256: materializationIdentity({ snapshot, records, exclusions: sortedExclusions }),
        headTreeSha: snapshot.headTreeSha.toLowerCase(),
        records,
        exclusions: sortedExclusions,
      },
      readExactPath,
    },
  };
}
