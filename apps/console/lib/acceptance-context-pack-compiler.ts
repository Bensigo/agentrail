import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  acceptanceContextPacketSetSha256,
  acceptanceContextPackCanonicalJson as canonicalJson,
  acceptanceContextPackCanonicalSha256,
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  exactGitTreeInclusionProofIdentity,
  recordAcceptanceCompiledContextPack,
  verifyExactGitTreeInclusionProof,
  validateReviewJobCorrectionPacketPayload,
  wikiPageBodySha256,
  type AcceptanceConfirmedContractProjection,
  type AcceptanceCompiledContextPackDependencyTreeProof,
  type AcceptanceCompiledContextPackExactSourceProof,
  type AcceptanceContextPackCustodyBaseIndexIdentity,
  type AcceptanceContextPackCustodyResolution,
  type ExactGitTreeInclusionProof,
} from "@agentrail/db-postgres";
import {
  MAX_SELECTED_EXACT_RANGE_BYTES,
  projectExactHeadSourceCustody,
  type ExactHeadDirectReadReceiptInput,
  type ExactHeadSelectedExactRangeInput,
  type ExactHeadSourceCustodyReceipt,
} from "./acceptance-context-pack-source-custody";
import {
  MAX_EXACT_HEAD_DIRECT_PATH_READS,
  type ExactHeadContentMaterializationResult,
  type ExactHeadContentReadResult,
  type ExactHeadContentRecord,
} from "./github-exact-head-content";
import {
  exactHeadContextCustodyOverlay,
  type ExactHeadGithubContextSnapshot,
} from "./github-exact-head-context";
import type { ReviewJobCorrectionPacket } from "./review-job-correction-packet";
import { scanForSecrets } from "./secret-scan";

/**
 * Deterministic, in-memory Context Pack compiler for one admitted correction
 * head. It consumes only server-resolved custody, retains source text only in
 * the returned delivery view, and performs no persistence or network writes.
 */
export const ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION = "exact-head-correction-pack-v6";
export const ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION = "bounded-exact-ranges-v4";
export const ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER = "utf8_byte_upper_bound_v1";
export const ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET = 65_536;

const MAX_CHANGED_FILES = 32;
const MAX_RANGES_PER_FILE = 8;
const MAX_LINES_PER_CHANGED_FILE = 160;
const MAX_DEPENDENCY_CANDIDATES = 16;
const MAX_DEPENDENCY_FILES = 8;
const MAX_LINES_PER_DEPENDENCY = 80;
const MAX_WIKI_PAGES = 4;
const MAX_LINES_PER_WIKI_PAGE = 60;
const MAX_WIKI_PAGE_BYTES = 256 * 1024;
const MAX_WIKI_TOTAL_BYTES = 512 * 1024;
const MAX_PACK_SOURCES = 64;
const YARN_CONFIGURATION_PATH = ".yarnrc.yml";
const CARGO_MANIFEST_PATH = "Cargo.toml";
const CARGO_LOCKFILE_PATH = "Cargo.lock";
const CARGO_CONFIGURATION_PATHS = [".cargo/config", ".cargo/config.toml"] as const;
const METADATA_ONLY_CONFIGURATION_PATHS = new Set<string>([
  YARN_CONFIGURATION_PATH,
  ...CARGO_CONFIGURATION_PATHS,
]);
const SHA1 = /^[a-f0-9]{40}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Range = { startLine: number; endLine: number };

export type AcceptanceContextPackExactSource = {
  kind: "exact_head_overlay" | "exact_head_dependency";
  path: string;
  blobSha: string;
  fullContentSha256: string;
  startLine: number;
  endLine: number;
  rangeSha256: string;
  byteCount: number;
  reason: string;
  citation: string;
};

export type AcceptanceContextPackWikiSource = {
  kind: "base_index_background";
  pageId: string;
  slug: string;
  commitSha: string;
  inputsHashSha256: string;
  pageBodySha256: string;
  stale: false;
  startLine: number;
  endLine: number;
  rangeSha256: string;
  byteCount: number;
  reason: "background_only";
  citation: string;
};

export type AcceptanceContextPackSource =
  | AcceptanceContextPackExactSource
  | AcceptanceContextPackWikiSource;

export type AcceptanceContextPackExclusion = {
  source: AcceptanceContextPackSource["kind"];
  path: string | null;
  reason: string;
  identitySha256?: string;
};

export type AcceptanceContextPackManifest = {
  version: 1;
  acceptanceCriterionIds: string[];
  unresolvedQuestionIds: string[];
  packetIds: string[];
  sources: AcceptanceContextPackSource[];
  architectureBoundaries: string[];
  tests: string[];
  decisions: string[];
  exclusions: AcceptanceContextPackExclusion[];
  sourceCustody: {
    kind: "exact_head_source_custody";
    schemaVersion: 2;
    identitySha256: string;
  };
  budget: {
    counter: typeof ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER;
    limitBytes: typeof ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET;
  };
  custody: {
    fullSourceUploadAllowed: false;
    rawSourcePersisted: false;
    snippetsPersisted: false;
  };
};

export type AcceptanceContextPackBinding = {
  sourceSnapshotId: string;
  workspaceId: string;
  recordId: string;
  reviewJobId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  acceptanceContractSha256: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  headTreeSha: string;
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  sourceSnapshotCompilerVersion: string;
  baseIndexRevisionSha256: string;
  overlayManifestSha256: string;
};

type SourceWithText = { source: AcceptanceContextPackSource; content: string };

export type CompiledAcceptanceContextPack = {
  kind: "compiled_acceptance_context_pack";
  version: 1;
  binding: AcceptanceContextPackBinding;
  compiler: {
    version: typeof ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION;
    policyVersion: typeof ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION;
    byteCounter: typeof ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER;
    byteBudget: typeof ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET;
  };
  manifest: AcceptanceContextPackManifest;
  exactHeadDependencyTreeProofs: AcceptanceCompiledContextPackDependencyTreeProof[];
  sourceCustodyReceipt: ExactHeadSourceCustodyReceipt;
  representations: { jsonSha256: string; markdownSha256: string };
  renderedByteCount: number;
  packSha256: string;
};

export type CompileAcceptanceContextPackFailureReason =
  | "invalid_input"
  | "source_snapshot_mismatch"
  | "contract_mismatch"
  | "correction_packet_mismatch"
  | "materialization_mismatch"
  | "source_custody_mismatch"
  | "changed_file_limit"
  | "no_exact_head_context"
  | "pack_budget";

export type CompileAcceptanceContextPackResult =
  | {
      ok: true;
      compiled: CompiledAcceptanceContextPack;
      /** Authorized ephemeral delivery payload. No source text is persisted here. */
      rendered: {
        manifest: AcceptanceContextPackManifest;
        contract: AcceptanceConfirmedContractProjection;
        correctionPackets: ReviewJobCorrectionPacket[];
        sources: SourceWithText[];
        json: string;
        markdown: string;
      };
    }
  | { ok: false; kind: "not_proven"; reason: CompileAcceptanceContextPackFailureReason };

export type CompileAndRecordAcceptanceContextPackResult =
  | Extract<CompileAcceptanceContextPackResult, { ok: false }>
  | (Extract<CompileAcceptanceContextPackResult, { ok: true }> & {
      persistence: Awaited<ReturnType<typeof recordAcceptanceCompiledContextPack>>;
    });

export type CompileAcceptanceContextPackInput = {
  custody: AcceptanceContextPackCustodyResolution;
  snapshot: ExactHeadGithubContextSnapshot;
  materialization: Extract<ExactHeadContentMaterializationResult, { ok: true }>["materialization"];
};

type InternalCompileAcceptanceContextPackResult =
  | Extract<CompileAcceptanceContextPackResult, { ok: false }>
  | (Extract<CompileAcceptanceContextPackResult, { ok: true }> & {
      exactSourceProofs: AcceptanceCompiledContextPackExactSourceProof[];
      exactGitTreeInclusionProofs: ExactGitTreeInclusionProof[];
    });

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safePath(value: unknown): value is string {
  return safeText(value, 4096) && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function exactArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalValue(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function canonicalPrettyJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value), null, 2);
}

function contractRecord(contract: AcceptanceConfirmedContractProjection): Record<string, unknown> {
  return {
    originalRequest: contract.originalRequest,
    normalizedRequirements: [...contract.normalizedRequirements],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      userVisible: criterion.userVisible,
      ...(criterion.modality === undefined ? {} : { modality: criterion.modality }),
    })),
    nonGoals: [...contract.nonGoals],
    risks: [...contract.risks],
    stops: [...contract.stops],
    environment: canonicalValue(contract.environment) as Record<string, unknown>,
    unresolvedQuestions: contract.unresolvedQuestions.map((question) => ({ ...question })),
  };
}

function normalizedContract(input: AcceptanceContextPackCustodyResolution): AcceptanceConfirmedContractProjection | null {
  try {
    const value = contractRecord(input.contract);
    const digest = acceptanceContractSha256({
      acceptanceContractId: input.sourceSnapshot.acceptanceContractId,
      acceptanceContractVersion: input.sourceSnapshot.acceptanceContractVersion,
      contract: value,
    });
    if (digest !== input.acceptanceContractSha256.toLowerCase()
      || !scanForSecrets(canonicalJson(value)).clean
      || input.contract.acceptanceCriteria.length === 0
      || input.contract.acceptanceCriteria.length > 100) return null;
    const ids = input.contract.acceptanceCriteria.map(({ id }) => id);
    if (ids.some((id) => !safeText(id, 512)) || new Set(ids).size !== ids.length) return null;
    return canonicalValue(value) as AcceptanceConfirmedContractProjection;
  } catch {
    return null;
  }
}

type BoundSourceSnapshot = AcceptanceContextPackCustodyResolution["sourceSnapshot"] & {
  baseSha: string;
  mergeBaseSha: string;
  headTreeSha: string;
  baseIndex: AcceptanceContextPackCustodyBaseIndexIdentity;
  overlay: NonNullable<AcceptanceContextPackCustodyResolution["sourceSnapshot"]["overlay"]>;
};

function boundSourceSnapshot(input: AcceptanceContextPackCustodyResolution): BoundSourceSnapshot | null {
  const source = input.sourceSnapshot;
  if (!UUID.test(source.id) || !UUID.test(source.workspaceId) || !UUID.test(source.recordId)
    || !UUID.test(source.reviewJobId) || !UUID.test(source.acceptanceContractId)
    || !Number.isInteger(source.acceptanceContractVersion) || source.acceptanceContractVersion < 1
    || !safeText(source.repo, 512) || !Number.isInteger(source.prNumber) || source.prNumber < 1
    || !SHA1.test(source.expectedHeadSha) || !SHA1.test(source.baseSha ?? "")
    || !SHA1.test(source.mergeBaseSha ?? "") || !SHA1.test(source.headTreeSha ?? "")
    || !SHA256.test(source.packetSetSha256) || !SHA256.test(source.correctionPacketPayloadSetSha256)
    || !safeText(source.compilerVersion, 128) || source.baseIndex?.schemaVersion !== 2
    || source.overlay?.schemaVersion !== 2) return null;
  const base = source.baseIndex;
  try {
    if (base.revisionSha256 !== acceptanceContextPackCustodyBaseIndexRevisionSha256({
      schemaVersion: 2,
      backgroundOnly: base.backgroundOnly,
      pages: base.pages,
      gaps: base.gaps,
    })) return null;
  } catch {
    return null;
  }
  return source as BoundSourceSnapshot;
}

function snapshotMatches(source: BoundSourceSnapshot, snapshot: ExactHeadGithubContextSnapshot): boolean {
  const projected = exactHeadContextCustodyOverlay(snapshot);
  return projected !== null && isDeepStrictEqual(projected, source.overlay)
    && source.repo === snapshot.repo && source.prNumber === snapshot.prNumber
    && source.expectedHeadSha.toLowerCase() === snapshot.headSha.toLowerCase()
    && source.baseSha.toLowerCase() === snapshot.baseSha.toLowerCase()
    && source.mergeBaseSha.toLowerCase() === snapshot.mergeBaseSha.toLowerCase()
    && source.headTreeSha.toLowerCase() === snapshot.headTreeSha.toLowerCase();
}

function normalizedPackets(input: {
  custody: AcceptanceContextPackCustodyResolution;
  source: BoundSourceSnapshot;
  contract: AcceptanceConfirmedContractProjection;
}): ReviewJobCorrectionPacket[] | null {
  if (!Array.isArray(input.custody.correctionPackets) || input.custody.correctionPackets.length === 0
    || input.custody.correctionPackets.length > 100
    || !input.custody.correctionPackets.every(validateReviewJobCorrectionPacketPayload)) return null;
  const packets = ([...input.custody.correctionPackets]
    .sort((left, right) => compareText(String(left["packetId"]), String(right["packetId"])))) as unknown as ReviewJobCorrectionPacket[];
  if (new Set(packets.map(({ packetId }) => packetId)).size !== packets.length) return null;
  const packetIds = packets.map(({ packetId }) => packetId);
  try {
    if (!exactArrayEqual(packetIds, [...input.source.packetIds].sort(compareText))
      || input.source.packetSetSha256 !== acceptanceContextPacketSetSha256({ packetIds })
      || input.source.correctionPacketPayloadSetSha256 !== input.custody.correctionPacketPayloadSetSha256
      || input.custody.correctionPacketPayloadSetSha256 !== acceptanceCorrectionPacketPayloadSetSha256({
        packets: input.custody.correctionPackets,
      })) return null;
  } catch {
    return null;
  }
  const criteria = new Map(input.contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
  for (const packet of packets) {
    if (packet.workspaceId !== input.source.workspaceId || packet.recordId !== input.source.recordId
      || packet.jobId !== input.source.reviewJobId || packet.repo !== input.source.repo
      || packet.prNumber !== input.source.prNumber
      || packet.headSha.toLowerCase() !== input.source.expectedHeadSha.toLowerCase()
      || packet.acceptanceContract.id !== input.source.acceptanceContractId
      || packet.acceptanceContract.version !== input.source.acceptanceContractVersion
      || criteria.get(packet.criterion.id) !== packet.criterion.snapshot) return null;
  }
  return packets.map((packet) => canonicalValue(packet) as ReviewJobCorrectionPacket);
}

function lines(content: string): string[] {
  return content.split("\n");
}

function rangeContent(content: string, range: Range): string {
  return lines(content).slice(range.startLine - 1, range.endLine).join("\n");
}

function boundedPatchRanges(ranges: readonly Range[], lineCount: number): Range[] {
  const normalized = ranges
    .filter((range) => Number.isInteger(range.startLine) && Number.isInteger(range.endLine)
      && range.startLine > 0 && range.endLine >= range.startLine && range.endLine <= lineCount)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const selected: Range[] = [];
  let remaining = MAX_LINES_PER_CHANGED_FILE;
  for (const range of normalized.slice(0, MAX_RANGES_PER_FILE)) {
    if (remaining <= 0) break;
    const count = Math.min(remaining, range.endLine - range.startLine + 1);
    selected.push({ startLine: range.startLine, endLine: range.startLine + count - 1 });
    remaining -= count;
  }
  return selected;
}

function exactSource(input: {
  kind: "exact_head_overlay" | "exact_head_dependency";
  record: ExactHeadContentRecord;
  range: Range;
  reason: string;
}): SourceWithText | null {
  if (input.range.startLine < 1 || input.range.endLine < input.range.startLine
    || input.range.endLine > input.record.lineCount) return null;
  const content = rangeContent(input.record.content, input.range);
  const byteCount = Buffer.byteLength(content, "utf8");
  if (byteCount === 0 || byteCount > MAX_SELECTED_EXACT_RANGE_BYTES || !scanForSecrets(content).clean) return null;
  return {
    source: {
      kind: input.kind,
      path: input.record.path,
      blobSha: input.record.blobSha.toLowerCase(),
      fullContentSha256: input.record.contentSha256.toLowerCase(),
      startLine: input.range.startLine,
      endLine: input.range.endLine,
      rangeSha256: sha256(content),
      byteCount,
      reason: input.reason,
      citation: `${input.record.path}@${input.record.blobSha.toLowerCase()}#L${input.range.startLine}-L${input.range.endLine}`,
    },
    content,
  };
}

function sourceKey(source: AcceptanceContextPackSource): string {
  const identifier = source.kind === "base_index_background" ? source.slug : source.path;
  return `${source.kind}\u0000${identifier}\u0000${String(source.startLine).padStart(10, "0")}\u0000${String(source.endLine).padStart(10, "0")}`;
}

function exclusion(
  source: AcceptanceContextPackSource["kind"],
  filePath: string | null,
  reason: string,
  identitySha256?: string,
): AcceptanceContextPackExclusion {
  return identitySha256 === undefined
    ? { source, path: filePath, reason }
    : { source, path: filePath, reason, identitySha256 };
}

function exclusionKey(value: AcceptanceContextPackExclusion): string {
  return `${value.source}\u0000${value.path ?? ""}\u0000${value.reason}\u0000${value.identitySha256 ?? ""}`;
}

function changedSources(input: {
  snapshot: ExactHeadGithubContextSnapshot;
  records: readonly ExactHeadContentRecord[];
}): { sources: SourceWithText[]; exclusions: AcceptanceContextPackExclusion[] } | null {
  const changed = input.snapshot.changedFiles.filter((file) => file.status !== "removed");
  if (changed.length > MAX_CHANGED_FILES) return null;
  const byPath = new Map(input.records.map((record) => [record.path, record]));
  if (byPath.size !== input.records.length) return null;
  const sources: SourceWithText[] = [];
  const exclusions: AcceptanceContextPackExclusion[] = [];
  for (const file of input.snapshot.changedFiles) {
    if (file.status === "removed") {
      exclusions.push(exclusion("exact_head_overlay", file.path, "removed_at_exact_head"));
      continue;
    }
    const record = byPath.get(file.path);
    if (!record || record.source !== "exact_head_overlay" || record.blobSha.toLowerCase() !== file.blobSha?.toLowerCase()) return null;
    if (METADATA_ONLY_CONFIGURATION_PATHS.has(record.path)) {
      exclusions.push(exclusion(
        "exact_head_overlay",
        record.path,
        "metadata_only_configuration_path",
        record.contentSha256,
      ));
      continue;
    }
    if (!Array.isArray(file.headRanges) || file.headRanges.length === 0 || !file.patchSha256) {
      exclusions.push(exclusion("exact_head_overlay", file.path, "missing_patch_ranges", record.contentSha256));
      continue;
    }
    const ranges = boundedPatchRanges(file.headRanges, record.lineCount);
    if (ranges.length === 0) return null;
    for (const range of ranges) {
      const selected = exactSource({ kind: "exact_head_overlay", record, range, reason: "exact_patch_head_range" });
      if (selected) sources.push(selected);
      else exclusions.push(exclusion("exact_head_overlay", file.path, "range_byte_or_secret_limit", record.contentSha256));
    }
  }
  return { sources, exclusions };
}

function dependencyKeywords(packets: readonly ReviewJobCorrectionPacket[]): string[] {
  const stop = new Set(["this", "that", "with", "from", "when", "then", "only", "exact", "head", "criterion", "review", "should", "must"]);
  const values = packets.flatMap((packet) => [
    packet.criterion.snapshot, packet.expected, packet.observed, packet.affectedContext.flow ?? "",
  ]);
  return sortedUnique(values.flatMap((value) => value.toLocaleLowerCase("en-US").match(/[a-z_][a-z0-9_-]{2,}/gu) ?? [])
    .filter((value) => !stop.has(value))).slice(0, 64);
}

type DependencyCandidate = { importer: string; specifier: string; candidates: string[]; reason: string };

function safeJoinedPath(importer: string, specifier: string): string | null {
  if (!specifier || specifier.startsWith("/") || specifier.includes("\\") || /[\u0000-\u001f\u007f]/u.test(specifier)) return null;
  const joined = path.normalize(path.join(path.dirname(importer), specifier));
  return safePath(joined) && !joined.startsWith("../") ? joined : null;
}

function jsCandidates(importer: string, specifier: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const joined = safeJoinedPath(importer, specifier);
  if (!joined) return [];
  if (path.extname(joined)) return [joined];
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  return [...extensions.map((suffix) => `${joined}${suffix}`), ...extensions.map((suffix) => `${joined}/index${suffix}`)];
}

function pythonCandidates(importer: string, specifier: string): string[] {
  let joined: string | null = null;
  if (specifier.startsWith(".")) {
    const dots = specifier.match(/^\.+/u)?.[0].length ?? 0;
    let base = path.dirname(importer);
    for (let index = 1; index < dots; index += 1) base = path.dirname(base);
    joined = path.normalize(path.join(base, specifier.slice(dots).replaceAll(".", "/")));
  } else if (specifier === "agentrail" || specifier.startsWith("agentrail.")) {
    joined = specifier.replaceAll(".", "/");
  }
  return joined && safePath(joined) ? [`${joined}.py`, `${joined}/__init__.py`] : [];
}

function shellCandidates(importer: string, specifier: string): string[] {
  const joined = safeJoinedPath(importer, specifier);
  if (!joined) return [];
  return path.extname(joined) ? [joined] : [joined, `${joined}.sh`];
}

function discoverDependencies(record: ExactHeadContentRecord): { candidates: DependencyCandidate[]; unsupported: boolean } {
  const extension = path.extname(record.path).toLocaleLowerCase("en-US");
  const found: DependencyCandidate[] = [];
  let unsupported = false;
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const literal = /(?:\bimport\s*(?:[^"'`]*?\s+from\s*)?|\bexport\s+[^"'`]*?\s+from\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/gu;
    for (const match of record.content.matchAll(literal)) {
      const specifier = match[1]!;
      const candidates = jsCandidates(record.path, specifier);
      if (candidates.length) found.push({ importer: record.path, specifier, candidates, reason: "static_relative_import" });
      else unsupported = true;
    }
    if (/\b(?:import|require)\s*\(\s*(?!["'])/u.test(record.content)) unsupported = true;
  } else if (extension === ".py") {
    for (const match of record.content.matchAll(/^\s*from\s+([.A-Za-z_][.A-Za-z0-9_]*)\s+import\s+/gmu)) {
      const specifier = match[1]!;
      const candidates = pythonCandidates(record.path, specifier);
      if (candidates.length) found.push({ importer: record.path, specifier, candidates, reason: "static_python_import" });
      else unsupported = true;
    }
    for (const match of record.content.matchAll(/^\s*import\s+(agentrail(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/gmu)) {
      const specifier = match[1]!;
      found.push({ importer: record.path, specifier, candidates: pythonCandidates(record.path, specifier), reason: "static_python_import" });
    }
  } else if (extension === ".sh" || !extension) {
    for (const match of record.content.matchAll(/^\s*(?:source|\.)\s+([^\s#;]+)\s*(?:#.*)?$/gmu)) {
      const specifier = match[1]!;
      if (/[\s$*?`{}\[\]]/u.test(specifier)) unsupported = true;
      else {
        const candidates = shellCandidates(record.path, specifier);
        if (candidates.length) found.push({ importer: record.path, specifier, candidates, reason: "static_shell_source" });
        else unsupported = true;
      }
    }
  }
  const deduped = new Map<string, DependencyCandidate>();
  for (const item of found) deduped.set(`${item.importer}\u0000${item.specifier}`, item);
  return {
    candidates: [...deduped.values()].sort((left, right) => compareText(
      `${left.importer}\u0000${left.specifier}`,
      `${right.importer}\u0000${right.specifier}`,
    )),
    unsupported,
  };
}

function focusedRanges(content: string, keywords: readonly string[], maxLines: number): Range[] {
  const all = lines(content);
  if (all.length === 0) return [];
  const matches: number[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index]!;
    const lower = line.toLocaleLowerCase("en-US");
    if (keywords.some((keyword) => lower.includes(keyword))
      || /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def)\b/u.test(line)) matches.push(index + 1);
  }
  if (matches.length === 0) return [{ startLine: 1, endLine: Math.min(all.length, Math.min(40, maxLines)) }];
  const windows = matches.slice(0, 6).map((line) => ({
    startLine: Math.max(1, line - 5), endLine: Math.min(all.length, line + 8),
  })).sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: Range[] = [];
  for (const range of windows) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push({ ...range });
  }
  let remaining = maxLines;
  return merged.flatMap((range) => {
    if (remaining <= 0) return [];
    const count = Math.min(remaining, range.endLine - range.startLine + 1);
    remaining -= count;
    return [{ startLine: range.startLine, endLine: range.startLine + count - 1 }];
  });
}

async function dependencySources(input: {
  changedRecords: readonly ExactHeadContentRecord[];
  readExactPath: (candidate: string) => Promise<ExactHeadContentReadResult>;
  keywords: readonly string[];
}): Promise<{ sources: SourceWithText[]; exclusions: AcceptanceContextPackExclusion[] }> {
  const discovered = input.changedRecords.flatMap((record) => {
    const result = discoverDependencies(record);
    return result.unsupported
      ? [{ record, item: null as DependencyCandidate | null }, ...result.candidates.map((item) => ({ record, item }))]
      : result.candidates.map((item) => ({ record, item }));
  });
  const exclusions: AcceptanceContextPackExclusion[] = discovered.flatMap(({ record, item }) => item === null
    ? [exclusion("exact_head_dependency", record.path, "unsupported_dependency_expression", record.contentSha256)]
    : []);
  const candidates = discovered.flatMap(({ item }) => item ? [item] : []);
  const changedPaths = new Set(input.changedRecords.map(({ path: filePath }) => filePath));
  const resolvedPaths = new Set<string>();
  const sources: SourceWithText[] = [];
  let attempted = 0;
  for (const item of candidates) {
    if (resolvedPaths.size >= MAX_DEPENDENCY_FILES || attempted >= MAX_DEPENDENCY_CANDIDATES) {
      exclusions.push(exclusion("exact_head_dependency", item.importer, "dependency_limit", sha256(item.specifier)));
      continue;
    }
    let record: ExactHeadContentRecord | null = null;
    for (const candidate of item.candidates) {
      if (attempted >= MAX_DEPENDENCY_CANDIDATES) break;
      if (changedPaths.has(candidate) || resolvedPaths.has(candidate)) break;
      if (METADATA_ONLY_CONFIGURATION_PATHS.has(candidate)) {
        exclusions.push(exclusion(
          "exact_head_dependency",
          candidate,
          "metadata_only_configuration_path",
          sha256(`${item.importer}\u0000${item.specifier}`),
        ));
        break;
      }
      attempted += 1;
      const read = await input.readExactPath(candidate);
      if (read.ok) {
        record = read.record;
        break;
      }
      if (read.reason !== "path_not_found") {
        exclusions.push(exclusion("exact_head_dependency", candidate, `dependency_${read.reason}`, sha256(`${item.importer}\u0000${item.specifier}`)));
        break;
      }
    }
    if (!record) {
      if (!item.candidates.some((candidate) => changedPaths.has(candidate) || resolvedPaths.has(candidate))) {
        exclusions.push(exclusion("exact_head_dependency", item.importer, "dependency_not_found", sha256(item.specifier)));
      }
      continue;
    }
    resolvedPaths.add(record.path);
    const name = path.basename(record.path, path.extname(record.path)).toLocaleLowerCase("en-US");
    for (const range of focusedRanges(record.content, [...input.keywords, name], MAX_LINES_PER_DEPENDENCY)) {
      const selected = exactSource({ kind: "exact_head_dependency", record, range, reason: item.reason });
      if (selected) sources.push(selected);
      else exclusions.push(exclusion("exact_head_dependency", record.path, "range_byte_or_secret_limit", record.contentSha256));
    }
  }
  return { sources, exclusions };
}

function wikiSources(input: {
  baseIndex: AcceptanceContextPackCustodyBaseIndexIdentity;
  wikiPages: AcceptanceContextPackCustodyResolution["wikiPages"];
  keywords: readonly string[];
}): { sources: SourceWithText[]; exclusions: AcceptanceContextPackExclusion[] } | null {
  const pagesById = new Map(input.wikiPages.map((page) => [page.id, page]));
  if (pagesById.size !== input.wikiPages.length
    || pagesById.size !== input.baseIndex.pages.length
    || input.baseIndex.pages.some((identity) => {
      const page = pagesById.get(identity.id);
      return !page || page.repositoryId !== identity.repositoryId || page.slug !== identity.slug
        || page.commitSha.toLowerCase() !== identity.commitSha.toLowerCase()
        || page.inputsHashSha256.toLowerCase() !== identity.inputsHashSha256.toLowerCase()
        || page.pageBodySha256.toLowerCase() !== identity.pageBodySha256.toLowerCase()
        || wikiPageBodySha256(page.bodyMd) !== identity.pageBodySha256.toLowerCase()
        || page.stale !== identity.stale;
    })) return null;
  const exclusions: AcceptanceContextPackExclusion[] = input.baseIndex.gaps.map((gap) =>
    exclusion("base_index_background", null, "base_index_gap", sha256(gap))
  );
  const sources: SourceWithText[] = [];
  let totalBytes = 0;
  const identities = [...input.baseIndex.pages].sort((left, right) => {
    if (left.slug === "wiki/overview" && right.slug !== "wiki/overview") return -1;
    if (right.slug === "wiki/overview" && left.slug !== "wiki/overview") return 1;
    return compareText(`${left.slug}\u0000${left.id}`, `${right.slug}\u0000${right.id}`);
  });
  for (const identity of identities) {
    const page = pagesById.get(identity.id)!;
    if (identity.stale || page.stale) {
      exclusions.push(exclusion("base_index_background", identity.slug, "base_index_stale", identity.pageBodySha256));
      continue;
    }
    const bytes = Buffer.byteLength(page.bodyMd, "utf8");
    if (bytes === 0 || bytes > MAX_WIKI_PAGE_BYTES || totalBytes + bytes > MAX_WIKI_TOTAL_BYTES) {
      exclusions.push(exclusion("base_index_background", identity.slug, "base_index_content_limit", identity.pageBodySha256));
      continue;
    }
    totalBytes += bytes;
    if (!scanForSecrets(page.bodyMd).clean) {
      exclusions.push(exclusion("base_index_background", identity.slug, "base_index_secret_policy", identity.pageBodySha256));
      continue;
    }
    if (sources.filter(({ source }) => source.kind === "base_index_background").length >= MAX_WIKI_PAGES) {
      exclusions.push(exclusion("base_index_background", identity.slug, "base_index_page_limit", identity.pageBodySha256));
      continue;
    }
    for (const range of focusedRanges(page.bodyMd, input.keywords, MAX_LINES_PER_WIKI_PAGE)) {
      const content = rangeContent(page.bodyMd, range);
      const byteCount = Buffer.byteLength(content, "utf8");
      if (byteCount === 0 || byteCount > MAX_SELECTED_EXACT_RANGE_BYTES) {
        exclusions.push(exclusion("base_index_background", identity.slug, "range_byte_limit", identity.pageBodySha256));
        continue;
      }
      sources.push({
        source: {
          kind: "base_index_background",
          pageId: identity.id,
          slug: identity.slug,
          commitSha: identity.commitSha.toLowerCase(),
          inputsHashSha256: identity.inputsHashSha256.toLowerCase(),
          pageBodySha256: identity.pageBodySha256.toLowerCase(),
          stale: false,
          startLine: range.startLine,
          endLine: range.endLine,
          rangeSha256: sha256(content),
          byteCount,
          reason: "background_only",
          citation: `wiki:${identity.slug}@${identity.commitSha.toLowerCase()}#L${range.startLine}-L${range.endLine}`,
        },
        content,
      });
    }
  }
  return { sources, exclusions };
}

function canonicalSources(values: readonly SourceWithText[]): SourceWithText[] {
  const unique = new Map<string, SourceWithText>();
  for (const value of values) unique.set(sourceKey(value.source), value);
  return [...unique.values()].sort((left, right) => compareText(sourceKey(left.source), sourceKey(right.source)));
}

function canonicalExclusions(values: readonly AcceptanceContextPackExclusion[]): AcceptanceContextPackExclusion[] {
  const unique = new Map<string, AcceptanceContextPackExclusion>();
  for (const value of values) unique.set(exclusionKey(value), value);
  return [...unique.values()].sort((left, right) => compareText(exclusionKey(left), exclusionKey(right)));
}

function isTestPath(filePath: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^.]+$/u.test(filePath);
}

function buildManifest(input: {
  contract: AcceptanceConfirmedContractProjection;
  packets: readonly ReviewJobCorrectionPacket[];
  sources: readonly SourceWithText[];
  exclusions: readonly AcceptanceContextPackExclusion[];
  sourceCustodyIdentitySha256: string;
}): AcceptanceContextPackManifest {
  const sources = canonicalSources(input.sources);
  return {
    version: 1,
    acceptanceCriterionIds: sortedUnique(input.contract.acceptanceCriteria.map(({ id }) => id)),
    unresolvedQuestionIds: sortedUnique(input.contract.unresolvedQuestions.map(({ id }) => id)),
    packetIds: input.packets.map(({ packetId }) => packetId),
    sources: sources.map(({ source }) => source),
    architectureBoundaries: sortedUnique([
      ...input.contract.nonGoals.map((value) => `non_goal:${value}`),
      ...input.contract.stops.map((value) => `stop:${value}`),
    ]),
    tests: sortedUnique(sources.flatMap(({ source }) =>
      source.kind !== "base_index_background" && isTestPath(source.path) ? [source.citation] : []
    )),
    decisions: [],
    exclusions: canonicalExclusions(input.exclusions),
    sourceCustody: {
      kind: "exact_head_source_custody",
      schemaVersion: 2,
      identitySha256: input.sourceCustodyIdentitySha256,
    },
    budget: {
      counter: ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER,
      limitBytes: ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET,
    },
    custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false },
  };
}

function representationPayload(input: {
  binding: AcceptanceContextPackBinding;
  contract: AcceptanceConfirmedContractProjection;
  packets: readonly ReviewJobCorrectionPacket[];
  manifest: AcceptanceContextPackManifest;
  sources: readonly SourceWithText[];
}) {
  return {
    kind: "acceptance_context_pack",
    version: 1,
    binding: input.binding,
    compiler: {
      version: ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION,
      policyVersion: ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION,
      byteCounter: ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER,
      byteBudget: ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET,
    },
    acceptanceContract: input.contract,
    correctionPackets: input.packets,
    manifest: input.manifest,
    sources: input.sources.map(({ source, content }) => ({ source, content })),
  };
}

function markdownFence(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/gu) ?? []).map((value) => value.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function renderRepresentations(input: {
  binding: AcceptanceContextPackBinding;
  contract: AcceptanceConfirmedContractProjection;
  packets: readonly ReviewJobCorrectionPacket[];
  manifest: AcceptanceContextPackManifest;
  sources: readonly SourceWithText[];
}): { json: string; markdown: string } | null {
  try {
    const json = canonicalPrettyJson(representationPayload(input));
    const contractJson = canonicalPrettyJson(input.contract);
    const contractFence = markdownFence(contractJson);
    const sections = [
      "# Acceptance Context Pack",
      "",
      `- Repository: ${input.binding.repo}`,
      `- Pull request: #${input.binding.prNumber}`,
      `- Exact head: ${input.binding.headSha}`,
      `- Base / merge base: ${input.binding.baseSha} / ${input.binding.mergeBaseSha}`,
      `- Acceptance Contract: ${input.binding.acceptanceContractId} v${input.binding.acceptanceContractVersion}`,
      `- Packet set: ${input.binding.packetSetSha256}`,
      `- Exact-source custody: ${input.manifest.sourceCustody.identitySha256}`,
      "",
      "## Confirmed Acceptance Contract",
      "",
      `${contractFence}json`, contractJson, contractFence, "",
      "## Immutable correction packets",
      "",
      ...input.packets.flatMap((packet) => {
        const value = canonicalPrettyJson(packet);
        const fence = markdownFence(value);
        return [`### ${packet.packetId}`, "", `${fence}json`, value, fence, ""];
      }),
      "## Exact sources and background",
      "",
      ...input.sources.flatMap(({ source, content }) => {
        const fence = markdownFence(content);
        return [`### ${source.citation}`, "", `${fence}text`, content, fence, ""];
      }),
      "## Explicit exclusions and gaps",
      "",
      ...(input.manifest.exclusions.length
        ? input.manifest.exclusions.map((item) => `- ${item.source}:${item.path ?? "(none)"} — ${item.reason}`)
        : ["- None"]),
      "",
    ];
    const markdown = sections.join("\n");
    return scanForSecrets(json).clean && scanForSecrets(markdown).clean ? { json, markdown } : null;
  } catch {
    return null;
  }
}

function fitBudget(input: {
  binding: AcceptanceContextPackBinding;
  contract: AcceptanceConfirmedContractProjection;
  packets: readonly ReviewJobCorrectionPacket[];
  sources: readonly SourceWithText[];
  exclusions: readonly AcceptanceContextPackExclusion[];
}): { sources: SourceWithText[]; exclusions: AcceptanceContextPackExclusion[] } | null {
  const selected: SourceWithText[] = [];
  const exclusions = [...input.exclusions];
  const placeholder = "0".repeat(64);
  const priority = [...input.sources].sort((left, right) => {
    const rank = (source: AcceptanceContextPackSource) =>
      source.kind === "exact_head_overlay" ? 0 : source.kind === "exact_head_dependency" ? 1 : 2;
    return rank(left.source) - rank(right.source) || compareText(sourceKey(left.source), sourceKey(right.source));
  });
  const render = () => {
    const sources = canonicalSources(selected);
    const manifest = buildManifest({
      contract: input.contract,
      packets: input.packets,
      sources,
      exclusions,
      sourceCustodyIdentitySha256: placeholder,
    });
    return renderRepresentations({ binding: input.binding, contract: input.contract, packets: input.packets, manifest, sources });
  };
  const base = render();
  if (!base || Math.max(Buffer.byteLength(base.json), Buffer.byteLength(base.markdown)) > ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET) return null;
  for (const candidate of priority) {
    selected.push(candidate);
    const rendered = render();
    const bytes = rendered
      ? Math.max(Buffer.byteLength(rendered.json), Buffer.byteLength(rendered.markdown))
      : Number.POSITIVE_INFINITY;
    if (bytes > ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET || selected.length > MAX_PACK_SOURCES) {
      selected.pop();
      const sourcePath = candidate.source.kind === "base_index_background" ? candidate.source.slug : candidate.source.path;
      exclusions.push(exclusion(candidate.source.kind, sourcePath, "pack_budget", candidate.source.rangeSha256));
    }
  }
  const sources = canonicalSources(selected);
  return sources.some(({ source }) => source.kind === "exact_head_overlay")
    ? { sources, exclusions: canonicalExclusions(exclusions) }
    : null;
}

function memoizedExactReads(input: {
  snapshot: ExactHeadGithubContextSnapshot;
  readExactPath: (candidate: string) => Promise<ExactHeadContentReadResult>;
}) {
  const pending = new Map<string, Promise<ExactHeadContentReadResult>>();
  const completed = new Map<string, ExactHeadDirectReadReceiptInput>();
  const read = async (candidate: string): Promise<ExactHeadContentReadResult> => {
    let promise = pending.get(candidate);
    if (!promise) {
      promise = Promise.resolve().then(() => input.readExactPath(candidate)).catch(() => ({
        ok: false as const,
        kind: "not_proven" as const,
        reason: "github_unavailable" as const,
      }));
      pending.set(candidate, promise);
    }
    const result = await promise;
    completed.set(candidate, {
      requestedPath: candidate,
      headSha: input.snapshot.headSha,
      headTreeSha: input.snapshot.headTreeSha,
      result,
    });
    return result;
  };
  return {
    read,
    hasReceipt: (candidate: string) => completed.has(candidate),
    receiptCount: () => completed.size,
    receipts: () => [...completed.values()].sort((left, right) => compareText(left.requestedPath, right.requestedPath)),
  };
}

function selectedDependencyTreeProofs(input: {
  selectedSources: readonly SourceWithText[];
  directReads: readonly ExactHeadDirectReadReceiptInput[];
  headTreeSha: string;
}): {
  identities: CompiledAcceptanceContextPack["exactHeadDependencyTreeProofs"];
  transientProofs: ExactGitTreeInclusionProof[];
} | null {
  const required = new Map<string, string>();
  for (const { source } of input.selectedSources) {
    if (source.kind !== "exact_head_dependency") continue;
    const existing = required.get(source.path);
    if (existing !== undefined && existing !== source.blobSha) return null;
    required.set(source.path, source.blobSha);
  }
  const identities: CompiledAcceptanceContextPack["exactHeadDependencyTreeProofs"] = [];
  const transientProofs: ExactGitTreeInclusionProof[] = [];
  for (const [sourcePath, blobSha] of [...required].sort(([left], [right]) => compareText(left, right))) {
    const read = input.directReads.find((candidate) => candidate.requestedPath === sourcePath);
    if (!read?.result.ok || read.result.record.blobSha !== blobSha || !read.result.treeInclusionProof) return null;
    const proof = read.result.treeInclusionProof;
    if (!verifyExactGitTreeInclusionProof(proof)
      || proof.headTreeSha !== input.headTreeSha
      || proof.paths.length !== 1
      || proof.paths[0]?.path !== sourcePath
      || proof.paths[0]?.blobSha !== blobSha) return null;
    identities.push({ path: sourcePath, blobSha, proofIdentitySha256: exactGitTreeInclusionProofIdentity(proof) });
    transientProofs.push(proof);
  }
  return { identities, transientProofs };
}

function packIdentity(input: Omit<CompiledAcceptanceContextPack, "packSha256" | "sourceCustodyReceipt"> & {
  sourceCustodyReceipt: Pick<ExactHeadSourceCustodyReceipt, "kind" | "schemaVersion" | "identitySha256">;
}): string {
  return acceptanceContextPackCanonicalSha256(input);
}

async function compileAcceptanceContextPackInternal(
  input: CompileAcceptanceContextPackInput,
): Promise<InternalCompileAcceptanceContextPackResult> {
  if (!input || !input.custody || !input.snapshot || !input.materialization) {
    return { ok: false, kind: "not_proven", reason: "invalid_input" };
  }
  const source = boundSourceSnapshot(input.custody);
  if (!source || !snapshotMatches(source, input.snapshot)) {
    return { ok: false, kind: "not_proven", reason: "source_snapshot_mismatch" };
  }
  const contract = normalizedContract(input.custody);
  if (!contract) return { ok: false, kind: "not_proven", reason: "contract_mismatch" };
  const packets = normalizedPackets({ custody: input.custody, source, contract });
  if (!packets) return { ok: false, kind: "not_proven", reason: "correction_packet_mismatch" };

  const preliminaryCustody = projectExactHeadSourceCustody({
    snapshot: input.snapshot,
    admittedOverlay: source.overlay,
    materialization: input.materialization,
    directReadReceipts: [],
    selectedExactRanges: [],
  });
  if (!preliminaryCustody.ok) {
    return { ok: false, kind: "not_proven", reason: "materialization_mismatch" };
  }
  const changed = changedSources({ snapshot: input.snapshot, records: input.materialization.content.records });
  if (!changed) {
    const nonRemoved = input.snapshot.changedFiles.filter((file) => file.status !== "removed").length;
    return { ok: false, kind: "not_proven", reason: nonRemoved > MAX_CHANGED_FILES ? "changed_file_limit" : "materialization_mismatch" };
  }

  const reads = memoizedExactReads({ snapshot: input.snapshot, readExactPath: input.materialization.readExactPath });
  const keywords = dependencyKeywords(packets);
  const dependencies = await dependencySources({
    changedRecords: input.materialization.content.records,
    readExactPath: reads.read,
    keywords,
  });
  // Safe Yarn and Cargo root profiles require independently derived proof that
  // repository-local configuration files are absent. A changed config is
  // already present in exact overlay metadata and must not be re-read as a fallback.
  // Otherwise probe only after dependencies have used their bounded budget. Cargo
  // probes are admitted atomically only for exact root Cargo manifest+lockfile
  // custody, so an unrelated Pack or a single remaining slot cannot gain a
  // misleading half-proof. The custody projection persists only hashes/counts/
  // outcome metadata, never the configuration body.
  const changedConfigurationPaths = new Set(input.materialization.content.records
    .filter((record) => METADATA_ONLY_CONFIGURATION_PATHS.has(record.path))
    .map((record) => record.path));
  if (!changedConfigurationPaths.has(YARN_CONFIGURATION_PATH) && (reads.hasReceipt(YARN_CONFIGURATION_PATH)
    || reads.receiptCount() < MAX_EXACT_HEAD_DIRECT_PATH_READS)) {
    await reads.read(YARN_CONFIGURATION_PATH);
  }
  const exactRootPathIsPresent = (requestedPath: string) =>
    input.materialization.content.records.some((record) => record.path === requestedPath)
    || reads.receipts().some((receipt) => receipt.requestedPath === requestedPath
      && receipt.result.ok && receipt.result.record.path === requestedPath);
  if (exactRootPathIsPresent(CARGO_MANIFEST_PATH) && exactRootPathIsPresent(CARGO_LOCKFILE_PATH)) {
    const cargoConfigurationPathsToProbe = CARGO_CONFIGURATION_PATHS.filter(
      (configurationPath) => !changedConfigurationPaths.has(configurationPath)
        && !reads.hasReceipt(configurationPath),
    );
    if (reads.receiptCount() + cargoConfigurationPathsToProbe.length <= MAX_EXACT_HEAD_DIRECT_PATH_READS) {
      for (const configurationPath of cargoConfigurationPathsToProbe) {
        await reads.read(configurationPath);
      }
    }
  }
  const background = wikiSources({ baseIndex: source.baseIndex, wikiPages: input.custody.wikiPages, keywords });
  if (!background) return { ok: false, kind: "not_proven", reason: "source_snapshot_mismatch" };
  const binding: AcceptanceContextPackBinding = {
    sourceSnapshotId: source.id,
    workspaceId: source.workspaceId,
    recordId: source.recordId,
    reviewJobId: source.reviewJobId,
    acceptanceContractId: source.acceptanceContractId,
    acceptanceContractVersion: source.acceptanceContractVersion,
    acceptanceContractSha256: input.custody.acceptanceContractSha256,
    repo: source.repo,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    mergeBaseSha: source.mergeBaseSha,
    headSha: source.expectedHeadSha,
    headTreeSha: source.headTreeSha,
    packetSetSha256: source.packetSetSha256,
    correctionPacketPayloadSetSha256: source.correctionPacketPayloadSetSha256,
    sourceSnapshotCompilerVersion: source.compilerVersion,
    baseIndexRevisionSha256: source.baseIndex.revisionSha256,
    overlayManifestSha256: source.overlay.manifestSha256,
  };
  const fitted = fitBudget({
    binding,
    contract,
    packets,
    sources: [...changed.sources, ...dependencies.sources, ...background.sources],
    exclusions: [...changed.exclusions, ...dependencies.exclusions, ...background.exclusions],
  });
  if (!fitted) {
    return { ok: false, kind: "not_proven", reason: changed.sources.length === 0 ? "no_exact_head_context" : "pack_budget" };
  }
  const selectedExactRanges: ExactHeadSelectedExactRangeInput[] = fitted.sources.flatMap(({ source: item }) =>
    item.kind === "base_index_background" ? [] : [{
      kind: item.kind,
      path: item.path,
      blobSha: item.blobSha,
      fullContentSha256: item.fullContentSha256,
      startLine: item.startLine,
      endLine: item.endLine,
      rangeSha256: item.rangeSha256,
      byteCount: item.byteCount,
    }]
  );
  const directReadReceipts = reads.receipts();
  const sourceCustody = projectExactHeadSourceCustody({
    snapshot: input.snapshot,
    admittedOverlay: source.overlay,
    materialization: input.materialization,
    directReadReceipts,
    selectedExactRanges,
  });
  if (!sourceCustody.ok) {
    return { ok: false, kind: "not_proven", reason: "source_custody_mismatch" };
  }
  const directRecords = new Map(directReadReceipts.flatMap((read) =>
    read.result.ok ? [[read.requestedPath, read.result.record] as const] : []
  ));
  const proofMap = new Map<string, AcceptanceCompiledContextPackExactSourceProof>();
  for (const { source: selected } of fitted.sources) {
    if (selected.kind === "base_index_background") continue;
    const record = selected.kind === "exact_head_overlay"
      ? input.materialization.content.records.find((candidate) => candidate.path === selected.path)
      : directRecords.get(selected.path);
    if (!record) return { ok: false, kind: "not_proven", reason: "source_custody_mismatch" };
    proofMap.set(`${selected.kind}\u0000${selected.path}`, {
      kind: selected.kind,
      path: selected.path,
      content: record.content,
    });
  }
  const exactSourceProofs = [...proofMap.values()].sort((left, right) =>
    compareText(`${left.kind}\u0000${left.path}`, `${right.kind}\u0000${right.path}`)
  );
  const dependencyTreeProofs = selectedDependencyTreeProofs({
    selectedSources: fitted.sources,
    directReads: directReadReceipts,
    headTreeSha: binding.headTreeSha,
  });
  if (!dependencyTreeProofs) {
    return { ok: false, kind: "not_proven", reason: "source_custody_mismatch" };
  }
  const manifest = buildManifest({
    contract,
    packets,
    sources: fitted.sources,
    exclusions: fitted.exclusions,
    sourceCustodyIdentitySha256: sourceCustody.receipt.identitySha256,
  });
  const representations = renderRepresentations({ binding, contract, packets, manifest, sources: fitted.sources });
  if (!representations) return { ok: false, kind: "not_proven", reason: "pack_budget" };
  const renderedByteCount = Math.max(
    Buffer.byteLength(representations.json, "utf8"),
    Buffer.byteLength(representations.markdown, "utf8"),
  );
  if (renderedByteCount > ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET) {
    return { ok: false, kind: "not_proven", reason: "pack_budget" };
  }
  const compiler = {
    version: ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION,
    policyVersion: ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION,
    byteCounter: ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER,
    byteBudget: ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET,
  } as const;
  const representationsCustody = {
    jsonSha256: sha256(representations.json),
    markdownSha256: sha256(representations.markdown),
  };
  const identityCore = {
    kind: "compiled_acceptance_context_pack" as const,
    version: 1 as const,
    binding,
    compiler,
    manifest,
    exactHeadDependencyTreeProofs: dependencyTreeProofs.identities,
    sourceCustodyReceipt: {
      kind: sourceCustody.receipt.kind,
      schemaVersion: sourceCustody.receipt.schemaVersion,
      identitySha256: sourceCustody.receipt.identitySha256,
    },
    representations: representationsCustody,
    renderedByteCount,
  };
  const compiled: CompiledAcceptanceContextPack = {
    ...identityCore,
    sourceCustodyReceipt: sourceCustody.receipt,
    packSha256: packIdentity(identityCore),
  };
  return {
    ok: true,
    compiled,
    rendered: {
      manifest,
      contract,
      correctionPackets: packets,
      sources: fitted.sources,
      ...representations,
    },
    exactSourceProofs,
    exactGitTreeInclusionProofs: dependencyTreeProofs.transientProofs,
  };
}

/** Compile a bounded exact-head correction Pack without persisting it. */
export async function compileAcceptanceContextPack(
  input: CompileAcceptanceContextPackInput,
): Promise<CompileAcceptanceContextPackResult> {
  const result = await compileAcceptanceContextPackInternal(input);
  if (!result.ok) return result;
  const {
    exactSourceProofs,
    exactGitTreeInclusionProofs,
    ...publicResult
  } = result;
  void exactSourceProofs;
  void exactGitTreeInclusionProofs;
  return publicResult;
}

/**
 * Trusted write path: compile from verified ephemeral Git bytes, rederive the
 * same bytes again at the DB boundary, and persist metadata only.
 */
export async function compileAndRecordAcceptanceContextPack(
  input: CompileAcceptanceContextPackInput,
): Promise<CompileAndRecordAcceptanceContextPackResult> {
  const result = await compileAcceptanceContextPackInternal(input);
  if (!result.ok) return result;
  const { exactSourceProofs, exactGitTreeInclusionProofs, ...publicResult } = result;
  const persistence = await recordAcceptanceCompiledContextPack({
    workspaceId: input.custody.sourceSnapshot.workspaceId,
    sourceSnapshotId: input.custody.sourceSnapshot.id,
    compiled: publicResult.compiled,
    exactSourceProofs,
    exactGitTreeInclusionProofs,
  });
  return { ...publicResult, persistence };
}

/** Bounded exact-head search over the already-authorized ephemeral Pack only. */
export function searchAcceptanceContextPackSources(input: {
  rendered: Extract<CompileAcceptanceContextPackResult, { ok: true }>["rendered"];
  query: string;
  limit?: number;
}): Array<{ citation: string; startLine: number; endLine: number; matchingLines: number[] }> {
  if (!safeText(input.query, 256) || !scanForSecrets(input.query).clean) return [];
  const query = input.query.toLocaleLowerCase("en-US");
  const limit = Math.min(20, Math.max(1, Math.trunc(input.limit ?? 10)));
  const results: Array<{ citation: string; startLine: number; endLine: number; matchingLines: number[] }> = [];
  for (const { source, content } of input.rendered.sources) {
    const matchingLines = lines(content).flatMap((line, index) =>
      line.toLocaleLowerCase("en-US").includes(query) ? [source.startLine + index] : []
    );
    if (matchingLines.length) results.push({
      citation: source.citation,
      startLine: source.startLine,
      endLine: source.endLine,
      matchingLines: matchingLines.slice(0, 20),
    });
    if (results.length >= limit) break;
  }
  return results;
}
