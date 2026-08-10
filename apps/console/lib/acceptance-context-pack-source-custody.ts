import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  acceptanceContextOverlayManifestSha256,
  type AcceptanceContextPackCustodyOverlayManifestIdentity,
} from "@agentrail/db-postgres";
import { scanForSecrets } from "./secret-scan";
import {
  exactHeadContentMaterializationIdentity,
  MAX_EXACT_HEAD_DIRECT_PATH_READS,
  MAX_EXACT_HEAD_DIRECT_PATH_BYTES,
  MAX_EXACT_HEAD_FILE_BYTES,
  MAX_EXACT_HEAD_SOURCE_FILES,
  MAX_EXACT_HEAD_SOURCE_BYTES,
  type ExactHeadContentExclusion,
  type ExactHeadContentReadResult,
  type ExactHeadContentRecord,
} from "./github-exact-head-content";
import {
  exactHeadContextCustodyOverlay,
  type ExactHeadGithubContextSnapshot,
} from "./github-exact-head-context";

/**
 * A source-only, serializable boundary between ephemeral Git bytes and a
 * Context Pack. Nothing returned here contains source text, credentials, or
 * GitHub URLs. Callers must capture every direct read they use in the Pack.
 */
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed"]);
const MAX_SECRET_KINDS = 16;
const MAX_SECRET_FINDINGS = 1024;
const MAX_CHANGED_MANIFEST_FILES = 299;

export interface ExactHeadDirectReadReceiptInput {
  /** The compiler candidate passed to the path-only exact-head resolver. */
  requestedPath: string;
  /** Captured at resolver invocation, not inferred from the returned record. */
  headSha: string;
  headTreeSha: string;
  result: ExactHeadContentReadResult;
}

export interface ExactHeadSourceCustodyInput {
  snapshot: ExactHeadGithubContextSnapshot;
  /** V2 overlay resolved from the immutable DB source snapshot. */
  admittedOverlay: AcceptanceContextPackCustodyOverlayManifestIdentity;
  materialization: {
    content: {
      identitySha256: string;
      headTreeSha: string;
      records: readonly ExactHeadContentRecord[];
      exclusions: readonly ExactHeadContentExclusion[];
    };
  };
  /** Every dependency/direct resolver result that contributed to this Pack. */
  directReadReceipts: readonly ExactHeadDirectReadReceiptInput[];
  /** Exact dependency source paths selected into the rendered Pack. */
  selectedDependencyPaths: readonly string[];
}

export interface ExactHeadSourceCustodyRecord {
  path: string;
  blobSha: string;
  previousPath: string | null;
  contentSha256: string;
  byteCount: number;
  lineCount: number;
  source: ExactHeadContentRecord["source"];
  reason: ExactHeadContentRecord["reason"];
}

export interface ExactHeadSourceCustodyExclusion {
  path: string;
  source: ExactHeadContentExclusion["source"];
  blobSha: string | null;
  byteCount: number | null;
  reason: ExactHeadContentExclusion["reason"];
  secretKinds: string[];
  findingCount: number;
}

export type ExactHeadSourceCustodyDirectReadReceipt =
  | {
      requestedPath: string;
      headSha: string;
      headTreeSha: string;
      outcome: "record";
      record: ExactHeadSourceCustodyRecord;
    }
  | {
      requestedPath: string;
      headSha: string;
      headTreeSha: string;
      outcome: "not_proven";
      reason: Exclude<ExactHeadContentReadResult, { ok: true }>["reason"];
      exclusion?: ExactHeadSourceCustodyExclusion;
    };

export interface ExactHeadSourceCustodyReceipt {
  kind: "exact_head_source_custody";
  schemaVersion: 1;
  repo: string;
  prNumber: number;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  headTreeSha: string;
  manifestSha256: string;
  /** These retain the patch/range binding without retaining a raw patch. */
  changedManifest: Array<{
    path: string;
    status: string;
    blobSha: string | null;
    previousPath: string | null;
    headRanges: Array<{ startLine: number; endLine: number }> | null;
    patchSha256: string | null;
    patchByteCount: number | null;
  }>;
  records: ExactHeadSourceCustodyRecord[];
  exclusions: ExactHeadSourceCustodyExclusion[];
  directReadReceipts: ExactHeadSourceCustodyDirectReadReceipt[];
  identitySha256: string;
}

export type ExactHeadSourceCustodyResult =
  | { ok: true; receipt: ExactHeadSourceCustodyReceipt }
  | { ok: false; kind: "not_proven"; reason: ExactHeadSourceCustodyFailureReason };

export type ExactHeadSourceCustodyFailureReason =
  | "invalid_input"
  | "snapshot_manifest_mismatch"
  | "head_tree_mismatch"
  | "changed_record_mismatch"
  | "record_identity_mismatch"
  | "materialization_identity_mismatch"
  | "secret_policy_mismatch"
  | "source_limit"
  | "direct_read_mismatch";

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The Git object ID, not merely a SHA-1 of content bytes. */
export function exactHeadGitBlobSha1(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isSecretPath(path: string): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  return basename === ".env" || basename.startsWith(".env.")
    || new Set([".npmrc", ".yarnrc", ".pypirc", ".netrc", ".git-credentials", "auth.json", "auth.toml"]).has(basename)
    || /\.(?:pem|key|p12|pfx|kdbx)$/iu.test(basename)
    || basename === "id_rsa" || basename === "id_ed25519"
    || lower.includes("credential") || /(?:^|\/)(?:secrets?|private)(?:\/|$)/u.test(lower)
    || /(?:^|\/)(?:\.aws\/(?:credentials|config)|\.docker\/config\.json|\.kube\/config|\.config\/gcloud\/application_default_credentials\.json)$/u.test(lower);
}

function canonicalRanges(value: ExactHeadGithubContextSnapshot["changedFiles"][number]): Array<{ startLine: number; endLine: number }> | null | undefined {
  if (value.headRanges === undefined) return undefined;
  if (value.headRanges === null) return null;
  const ranges = value.headRanges.map(({ startLine, endLine }) => ({ startLine, endLine }));
  if (ranges.some((range) => !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)
    || range.startLine < 1 || range.endLine < range.startLine)) return undefined;
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  if (JSON.stringify(sorted) !== JSON.stringify(ranges)
    || sorted.some((range, index) => index > 0 && range.startLine <= sorted[index - 1]!.endLine)) return undefined;
  return ranges;
}

function recordIdentity(record: ExactHeadContentRecord): ExactHeadSourceCustodyRecord | null {
  if (!safePath(record.path) || !SHA1.test(record.blobSha) || !SHA256.test(record.contentSha256)
    || !Number.isSafeInteger(record.byteCount) || record.byteCount < 0
    || record.byteCount > MAX_EXACT_HEAD_FILE_BYTES
    || typeof record.content !== "string" || record.content.length > MAX_EXACT_HEAD_FILE_BYTES
    || !Number.isSafeInteger(record.lineCount) || record.lineCount < 1
    || !["exact_head_overlay", "exact_head_tree_fallback"].includes(record.source)
    || !["exact_base_to_head_compare", "exact_head_tree_path"].includes(record.reason)
    || (record.source === "exact_head_overlay") !== (record.reason === "exact_base_to_head_compare")
    || (record.previousPath !== null && !safePath(record.previousPath))) return null;
  const bytes = Buffer.from(record.content, "utf8");
  if (record.blobSha.toLowerCase() !== exactHeadGitBlobSha1(record.content)
    || record.contentSha256.toLowerCase() !== sha256(bytes)
    || record.byteCount !== bytes.byteLength || record.lineCount !== record.content.split("\n").length) return null;
  if (isSecretPath(record.path) || (record.previousPath !== null && isSecretPath(record.previousPath)) || !scanForSecrets(record.content).clean) return null;
  return {
    path: record.path,
    blobSha: record.blobSha.toLowerCase(),
    previousPath: record.previousPath,
    contentSha256: record.contentSha256.toLowerCase(),
    byteCount: record.byteCount,
    lineCount: record.lineCount,
    source: record.source,
    reason: record.reason,
  };
}

function exclusionIdentity(value: ExactHeadContentExclusion): ExactHeadSourceCustodyExclusion | null {
  if (!safePath(value.path) || !["exact_head_overlay", "exact_head_tree_fallback"].includes(value.source)
    || !["removed_at_exact_head", "secret_path_policy", "secret_content_policy"].includes(value.reason)
    || (value.blobSha !== null && !SHA1.test(value.blobSha))
    || (value.byteCount !== null && (!Number.isSafeInteger(value.byteCount) || value.byteCount < 0))
    || !Array.isArray(value.secretKinds) || !Number.isSafeInteger(value.findingCount)
    || value.findingCount < 0 || value.findingCount > MAX_SECRET_FINDINGS) return null;
  const secretKinds = [...value.secretKinds];
  if (secretKinds.length > MAX_SECRET_KINDS || secretKinds.some((kind) => typeof kind !== "string" || !kind || kind.length > 128)
    || new Set(secretKinds).size !== secretKinds.length || JSON.stringify(secretKinds) !== JSON.stringify([...secretKinds].sort(compareText))) return null;
  if (value.reason === "removed_at_exact_head" && (value.source !== "exact_head_overlay" || value.byteCount !== null || secretKinds.length !== 0 || value.findingCount !== 0)) return null;
  if (value.reason === "secret_path_policy" && (!isSecretPath(value.path) || value.byteCount !== null || secretKinds.length !== 0 || value.findingCount !== 0)) return null;
  if (value.reason === "secret_content_policy" && (isSecretPath(value.path) || value.blobSha === null || value.byteCount === null || secretKinds.length === 0 || value.findingCount < 1)) return null;
  return {
    path: value.path,
    source: value.source,
    blobSha: value.blobSha?.toLowerCase() ?? null,
    byteCount: value.byteCount,
    reason: value.reason,
    secretKinds,
    findingCount: value.findingCount,
  };
}

function canonicalizeExclusions(values: readonly ExactHeadContentExclusion[]): ExactHeadSourceCustodyExclusion[] | null {
  const normalized = values.map(exclusionIdentity);
  if (normalized.some((value) => value === null)) return null;
  const result = normalized as ExactHeadSourceCustodyExclusion[];
  const key = (value: ExactHeadSourceCustodyExclusion) => `${value.source}\u0000${value.path}\u0000${value.reason}\u0000${value.blobSha ?? ""}`;
  const keys = result.map(key);
  if (new Set(keys).size !== keys.length) return null;
  return [...result].sort((left, right) => compareText(key(left), key(right)));
}

function snapshotIsAdmitted(snapshot: ExactHeadGithubContextSnapshot): boolean {
  if (!safePath(snapshot.repo.replace("/", "/")) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(snapshot.repo)
    || !Number.isInteger(snapshot.prNumber) || snapshot.prNumber < 1
    || !SHA1.test(snapshot.baseSha) || !SHA1.test(snapshot.mergeBaseSha) || !SHA1.test(snapshot.headSha) || !SHA1.test(snapshot.headTreeSha)
    || !SHA256.test(snapshot.manifestSha256) || !Array.isArray(snapshot.changedFiles)) return false;
  const seen = new Set<string>();
  for (const file of snapshot.changedFiles) {
    const ranges = canonicalRanges(file);
    const noPatch = ranges === null && file.patchSha256 === null && file.patchByteCount === null;
    const hasPatch = Array.isArray(ranges) && ranges.length > 0 && ranges.length <= 128
      && typeof file.patchSha256 === "string" && SHA256.test(file.patchSha256)
      && Number.isSafeInteger(file.patchByteCount) && (file.patchByteCount as number) > 0
      && (file.patchByteCount as number) <= 2 * 1024 * 1024;
    if (!safePath(file.path) || seen.has(file.path) || !STATUSES.has(file.status)
      || ranges === undefined || (!noPatch && !hasPatch)
      || (file.status === "removed" ? file.blobSha !== null : !SHA1.test(file.blobSha ?? ""))
      || (file.status === "renamed" ? !safePath(file.previousPath) || file.previousPath === file.path : file.previousPath !== null)) return false;
    seen.add(file.path);
  }
  const manifestFiles = snapshot.changedFiles.map(({ path, status, blobSha, previousPath }) => ({
    path, status: status as "added", blobSha: blobSha?.toLowerCase() ?? null, previousPath,
  }));
  return snapshot.manifestSha256.toLowerCase() === acceptanceContextOverlayManifestSha256({
    schemaVersion: 1,
    baseSha: snapshot.baseSha.toLowerCase(),
    mergeBaseSha: snapshot.mergeBaseSha.toLowerCase(),
    headSha: snapshot.headSha.toLowerCase(),
    files: manifestFiles,
  });
}

function changedRecordsAreExact(input: ExactHeadSourceCustodyInput, records: readonly ExactHeadSourceCustodyRecord[], exclusions: readonly ExactHeadSourceCustodyExclusion[]): boolean {
  const expected = input.snapshot.changedFiles.filter((file) => file.status !== "removed");
  const overlays = records.filter(({ source }) => source === "exact_head_overlay");
  if (records.length !== overlays.length || expected.length !== overlays.length) return false;
  const byPath = new Map(overlays.map((record) => [record.path, record]));
  if (byPath.size !== overlays.length) return false;
  for (const file of expected) {
    const record = byPath.get(file.path);
    if (!record || record.blobSha !== file.blobSha!.toLowerCase() || record.previousPath !== file.previousPath
      || record.reason !== "exact_base_to_head_compare") return false;
  }
  const removed = input.snapshot.changedFiles.filter((file) => file.status === "removed");
  const removedExclusions = exclusions.filter(({ reason }) => reason === "removed_at_exact_head");
  if (removed.length !== removedExclusions.length) return false;
  return removed.every((file) => removedExclusions.some((item) => item.path === file.path && item.source === "exact_head_overlay"
    && item.blobSha === null));
}

function directReadReceipt(input: ExactHeadDirectReadReceiptInput, snapshot: ExactHeadGithubContextSnapshot): ExactHeadSourceCustodyDirectReadReceipt | null {
  if (!safePath(input.requestedPath) || !SHA1.test(input.headSha) || !SHA1.test(input.headTreeSha)
    || input.headSha.toLowerCase() !== snapshot.headSha.toLowerCase()
    || input.headTreeSha.toLowerCase() !== snapshot.headTreeSha.toLowerCase()) return null;
  if (input.result.ok === true) {
    const record = recordIdentity(input.result.record);
    if (!record || record.path !== input.requestedPath || record.source !== "exact_head_tree_fallback"
      || record.reason !== "exact_head_tree_path" || record.previousPath !== null) return null;
    return { requestedPath: input.requestedPath, headSha: snapshot.headSha.toLowerCase(), headTreeSha: snapshot.headTreeSha.toLowerCase(), outcome: "record", record };
  }
  if (input.result.ok !== false) return null;
  const exclusion = input.result.exclusion === undefined ? undefined : exclusionIdentity(input.result.exclusion);
  if (input.result.exclusion !== undefined && (!exclusion || exclusion.path !== input.requestedPath || exclusion.source !== "exact_head_tree_fallback")) return null;
  return {
    requestedPath: input.requestedPath,
    headSha: snapshot.headSha.toLowerCase(),
    headTreeSha: snapshot.headTreeSha.toLowerCase(),
    outcome: "not_proven",
    reason: input.result.reason,
    ...(exclusion ? { exclusion } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("receipt identity cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("receipt identity contains an unsupported value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function receiptIdentity(receipt: Omit<ExactHeadSourceCustodyReceipt, "identitySha256">): string {
  return sha256(canonicalJson(receipt));
}

/**
 * Revalidates ephemeral bytes before projection. Any ambiguity is
 * `not_proven`; no partial receipt is emitted.
 */
export function projectExactHeadSourceCustody(input: ExactHeadSourceCustodyInput): ExactHeadSourceCustodyResult {
  if (!input || !input.snapshot || !input.materialization || !input.materialization.content
    || !input.admittedOverlay
    || !Array.isArray(input.materialization.content.records) || !Array.isArray(input.materialization.content.exclusions)
    || !Array.isArray(input.directReadReceipts) || !Array.isArray(input.selectedDependencyPaths)
    || input.snapshot.changedFiles.length < 1 || input.snapshot.changedFiles.length > MAX_CHANGED_MANIFEST_FILES
    || input.materialization.content.records.length > MAX_EXACT_HEAD_SOURCE_FILES
    || input.materialization.content.exclusions.length > MAX_CHANGED_MANIFEST_FILES
    || input.directReadReceipts.length > MAX_EXACT_HEAD_DIRECT_PATH_READS
    || input.selectedDependencyPaths.length > MAX_EXACT_HEAD_DIRECT_PATH_READS
    || !snapshotIsAdmitted(input.snapshot)) {
    return { ok: false, kind: "not_proven", reason: "invalid_input" };
  }
  if (input.materialization.content.headTreeSha.toLowerCase() !== input.snapshot.headTreeSha.toLowerCase()) {
    return { ok: false, kind: "not_proven", reason: "head_tree_mismatch" };
  }
  const projectedOverlay = exactHeadContextCustodyOverlay(input.snapshot);
  if (!projectedOverlay || !isDeepStrictEqual(projectedOverlay, input.admittedOverlay)) {
    return { ok: false, kind: "not_proven", reason: "snapshot_manifest_mismatch" };
  }
  const records = input.materialization.content.records.map(recordIdentity);
  if (records.some((record) => record === null)) return { ok: false, kind: "not_proven", reason: "record_identity_mismatch" };
  const canonicalRecords = [...(records as ExactHeadSourceCustodyRecord[])].sort((left, right) => compareText(left.path, right.path));
  if (new Set(canonicalRecords.map(({ path }) => path)).size !== canonicalRecords.length) return { ok: false, kind: "not_proven", reason: "changed_record_mismatch" };
  if (canonicalRecords.reduce((total, record) => total + record.byteCount, 0) > MAX_EXACT_HEAD_SOURCE_BYTES) {
    return { ok: false, kind: "not_proven", reason: "source_limit" };
  }
  const exclusions = canonicalizeExclusions(input.materialization.content.exclusions);
  if (!exclusions) return { ok: false, kind: "not_proven", reason: "secret_policy_mismatch" };
  if (!changedRecordsAreExact(input, canonicalRecords, exclusions)) return { ok: false, kind: "not_proven", reason: "changed_record_mismatch" };
  if (!SHA256.test(input.materialization.content.identitySha256)
    || input.materialization.content.identitySha256.toLowerCase() !== exactHeadContentMaterializationIdentity({
      snapshot: input.snapshot,
      records: [...input.materialization.content.records],
      exclusions: [...input.materialization.content.exclusions],
    })) {
    return { ok: false, kind: "not_proven", reason: "materialization_identity_mismatch" };
  }
  const directReadReceipts = input.directReadReceipts.map((receipt) => directReadReceipt(receipt, input.snapshot));
  if (directReadReceipts.some((receipt) => receipt === null)) return { ok: false, kind: "not_proven", reason: "direct_read_mismatch" };
  const canonicalReads = [...(directReadReceipts as ExactHeadSourceCustodyDirectReadReceipt[])].sort((left, right) => {
    const leftKey = `${left.requestedPath}\u0000${left.outcome}\u0000${left.outcome === "record" ? left.record.blobSha : left.reason}`;
    const rightKey = `${right.requestedPath}\u0000${right.outcome}\u0000${right.outcome === "record" ? right.record.blobSha : right.reason}`;
    return compareText(leftKey, rightKey);
  });
  if (new Set(canonicalReads.map(({ requestedPath }) => requestedPath)).size !== canonicalReads.length) {
    return { ok: false, kind: "not_proven", reason: "direct_read_mismatch" };
  }
  if (canonicalReads.reduce((total, read) => total + (read.outcome === "record" ? read.record.byteCount : 0), 0)
    > MAX_EXACT_HEAD_DIRECT_PATH_BYTES) {
    return { ok: false, kind: "not_proven", reason: "source_limit" };
  }
  if (input.selectedDependencyPaths.some((value) => !safePath(value))
    || new Set(input.selectedDependencyPaths).size !== input.selectedDependencyPaths.length) {
    return { ok: false, kind: "not_proven", reason: "direct_read_mismatch" };
  }
  const successfulReads = new Set(canonicalReads.flatMap((read) => read.outcome === "record" ? [read.requestedPath] : []));
  if (input.selectedDependencyPaths.some((selectedPath) => !successfulReads.has(selectedPath))) {
    return { ok: false, kind: "not_proven", reason: "direct_read_mismatch" };
  }
  const changedManifest = input.snapshot.changedFiles.map((file) => {
    const ranges = canonicalRanges(file);
    if (ranges === undefined) throw new Error("validated ranges became invalid");
    return {
      path: file.path,
      status: file.status,
      blobSha: file.blobSha?.toLowerCase() ?? null,
      previousPath: file.previousPath,
      headRanges: ranges,
      patchSha256: file.patchSha256?.toLowerCase() ?? null,
      patchByteCount: file.patchByteCount ?? null,
    };
  }).sort((left, right) => compareText(left.path, right.path));
  const core: Omit<ExactHeadSourceCustodyReceipt, "identitySha256"> = {
    kind: "exact_head_source_custody",
    schemaVersion: 1,
    repo: input.snapshot.repo,
    prNumber: input.snapshot.prNumber,
    baseSha: input.snapshot.baseSha.toLowerCase(),
    mergeBaseSha: input.snapshot.mergeBaseSha.toLowerCase(),
    headSha: input.snapshot.headSha.toLowerCase(),
    headTreeSha: input.snapshot.headTreeSha.toLowerCase(),
    manifestSha256: input.snapshot.manifestSha256.toLowerCase(),
    changedManifest,
    records: canonicalRecords,
    exclusions,
    directReadReceipts: canonicalReads,
  };
  return { ok: true, receipt: { ...core, identitySha256: receiptIdentity(core) } };
}
