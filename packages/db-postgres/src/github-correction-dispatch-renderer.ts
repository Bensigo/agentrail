import { createHash } from "node:crypto";

/** A deliberately small, server-attested binding for one GitHub finding write. */
export const GITHUB_CORRECTION_DISPATCH_BINDING_KIND = "github_correction_dispatch";
export const GITHUB_CORRECTION_DISPATCH_BINDING_VERSION = 1;
export const MAX_GITHUB_CORRECTION_FINDING_BYTES = 12 * 1024;

/** Exact custody carried inside the one selected-recipient activation bundle. */
export const GITHUB_CORRECTION_ACTIVATION_BINDING_KIND = "github_correction_activation";
export const GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION = 1;
export const GITHUB_CORRECTION_ACTIVATION_BUNDLE_KIND = "github_correction_activation_packet_bundle";
export const GITHUB_CORRECTION_ACTIVATION_BUNDLE_VERSION = 1;
export const MAX_GITHUB_CORRECTION_ACTIVATION_BYTES = 60 * 1024;

export type GitHubCorrectionRecipient = "codex" | "claude";
export type GitHubCorrectionRouteAdapter = "github_codex" | "github_claude";

export type SafeUiCorrectionReproductionStep =
  | { action: "open"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: "[REDACTED_FILL]" }
  | { action: "press"; key: string }
  | { action: "expect_text"; text: string }
  | { action: "screenshot"; label: string };

export interface SafeDataCorrectionRequestDescriptor {
  method: "GET";
  path: string;
  expectedStatus: number;
  digestAlgorithm: "hmac-sha256-v1";
  digestKeyId: string;
  digestContext: string;
  expectedJson: Array<{
    pointer: string;
    equalsType: "null" | "boolean" | "number" | "string";
    equalsHmacSha256: string;
  }>;
}

export type GitHubCorrectionReproduction =
  | { modality: "ui"; steps: SafeUiCorrectionReproductionStep[] }
  | { modality: "api"; request: { method: "GET"; path: string; expectedStatus: number } }
  | { modality: "data"; request: SafeDataCorrectionRequestDescriptor }
  | {
      modality: "job";
      request: {
        trigger: { method: "POST"; path: string; expectedStatus: number };
        readback: SafeDataCorrectionRequestDescriptor;
      };
    };

/** Structural view of the immutable R8.1 packet consumed by this pure renderer. */
export interface GitHubCorrectionPacketPayload extends Record<string, unknown> {
  kind: "review_job_correction_packet";
  version: 1;
  packetId: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordId: string;
  jobId: string;
  acceptanceContract: { id: string; version: number };
  criterion: { id: string; snapshot: string };
  basis: "acceptance_contract";
  state: "failed" | "not_proven";
  expected: string;
  observed: string;
  affectedContext: {
    modality: "ui" | "api" | "data" | "job";
    environmentKind: "isolated_preview" | null;
    flow: string | null;
    reproduction: GitHubCorrectionReproduction | null;
  };
  evidence: {
    evidenceRef: string;
    artifactKey?: string;
    executionId?: string;
    previewBootId?: string;
  };
  scopeBoundary: string;
  impact: string;
  requiredCorrection: string;
  reverification: string;
}

export interface GitHubCorrectionDispatchBinding extends Record<string, unknown> {
  kind: typeof GITHUB_CORRECTION_DISPATCH_BINDING_KIND;
  version: typeof GITHUB_CORRECTION_DISPATCH_BINDING_VERSION;
  workspaceId: string;
  dispatchId: string;
  dispatchIdentitySha256: string;
  recordId: string;
  reviewJobId: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  packetId: string;
  packetPayloadSha256: string;
  acceptanceContract: { id: string; version: number; sha256: string };
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  contextPack: {
    id: string;
    sha256: string;
    sourceSnapshotId: string;
    sourceCustodyIdentitySha256: string;
  };
  route: {
    id: string;
    adapter: GitHubCorrectionRouteAdapter;
    configurationVersion: number;
  };
  capabilityProfile: {
    id: string;
    snapshotSha256: string;
    githubInstallationIdentitySha256: string;
  };
  readyPreflight: {
    id: string;
    identitySha256: string;
  };
}

export interface GitHubCorrectionActivationBinding extends Record<string, unknown> {
  kind: typeof GITHUB_CORRECTION_ACTIVATION_BINDING_KIND;
  version: typeof GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION;
  workspaceId: string;
  dispatchId: string;
  dispatchIdentitySha256: string;
  recordId: string;
  reviewJobId: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  acceptanceContract: {
    id: string;
    version: number;
    sha256: string;
  };
  contextPack: {
    id: string;
    sha256: string;
    sourceSnapshotId: string;
    sourceCustodyIdentitySha256: string;
  };
  packetIds: string[];
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  route: {
    id: string;
    adapter: GitHubCorrectionRouteAdapter;
    configurationVersion: number;
  };
  capabilityProfile: {
    id: string;
    snapshotSha256: string;
    githubInstallationIdentitySha256: string;
  };
  readyPreflight: {
    id: string;
    identitySha256: string;
  };
  findingCoverageSha256: string;
  recipient: GitHubCorrectionRecipient;
}

export interface RenderedGitHubCorrectionFinding {
  /** Complete GitHub comment body, including the inert custody marker. */
  comment: string;
  /** Human-visible portion of the comment. The digest is computed over this exact value. */
  body: string;
  sha256: string;
}

export interface RenderedGitHubCorrectionActivation {
  ok: true;
  body: string;
  bodySha256: string;
  packetBundleJson: string;
  packetBundleBase64url: string;
  packetBundleSha256: string;
}

export interface InvalidGitHubCorrectionActivationRendering {
  ok: false;
  reason: "invalid_binding" | "unsafe_packet";
}

export interface OversizeGitHubCorrectionActivationRendering {
  ok: false;
  reason: "activation_body_too_large";
  /** Safe digest of the canonical bundle; raw JSON/base64/body are withheld. */
  packetBundleSha256: string;
}

export type GitHubCorrectionActivationRendering =
  | RenderedGitHubCorrectionActivation
  | InvalidGitHubCorrectionActivationRendering
  | OversizeGitHubCorrectionActivationRendering;

const SHA1 = /^[a-f0-9]{40}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const CORRECTION_PACKET_ID = /^correction-[a-f0-9]{48}$/iu;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_OR_BIDI = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
const COMMENT_CONTROL_OR_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]{1,31}:\/\/|www\.|mailto:)|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|uk|test)\b/iu;
const RAW_SOURCE_LIKE = /```|\bimport\s+(?:type\s+)?[A-Za-z_$*{]|\bexport\s+(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+[A-Za-z_$][\w$]*|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|(?:^|[;{}])\s*(?:async\s+)?(?:function|class|interface|type)\s+[A-Za-z_$][\w$]*|=>\s*[({]/u;
const ASCII_MENTION = /@/u;
const MARKER_PREFIX = "<!-- agentrail-correction-dispatch:v1; non-activation-only; sha256=";
const MARKER_SUFFIX = " -->";
const REQUIRED_HEADINGS = [
  "## AgentRail correction finding", "## Trusted identity", "## Expected", "## Observed", "## Reproduction",
  "## Impact", "## Required correction", "## Scope boundary", "## Reverification", "## Evidence metadata",
] as const;

const SECRET_LIKE = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\baws.{0,20}(?:secret|access).{0,20}[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/iu,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u,
  /(?:^|[^A-Za-z0-9])(?:_authToken|_auth)\s*=\s*[^\s]{8,}/iu,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/iu,
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secretsClean(value: string): boolean {
  return SECRET_LIKE.every((pattern) => !pattern.test(value));
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value) && safeText(value);
}

function safeText(value: string): boolean {
  return value.length > 0 && !CONTROL_OR_BIDI.test(value) && !URL_LIKE.test(value)
    && !RAW_SOURCE_LIKE.test(value) && secretsClean(value);
}

function allStringsSafe(value: unknown): boolean {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.every(allStringsSafe);
  if (!isRecord(value)) return true;
  return Object.values(value).every(allStringsSafe);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("canonical JSON requires plain JSON values");
  }
  return `{${Object.keys(value).sort(compareUtf8).map((key) => {
    const nested = value[key];
    if (nested === undefined) throw new Error("canonical JSON cannot encode undefined");
    return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
  }).join(",")}}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isSha1(value: unknown): value is string {
  return typeof value === "string" && SHA1.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSortedUniqueOpaqueIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every(safeOpaqueId) && new Set(value).size === value.length
    && value.every((packetId, index) => index === 0 || compareUtf8(value[index - 1]!, packetId) < 0);
}

function expectedPacketSetSha256(packetIds: readonly string[]): string {
  return sha256(JSON.stringify({ kind: "acceptance_context_packet_set", version: 1, packetIds }));
}

function expectedPacketPayloadSetSha256(packets: readonly GitHubCorrectionPacketPayload[]): string {
  return sha256(canonicalJson({
    kind: "acceptance_correction_packet_payload_set",
    version: 1,
    packets,
  }));
}

function boundedSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && safeText(value);
}

function validExpectedStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function validateDataRequest(value: unknown): value is SafeDataCorrectionRequestDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, [
    "method", "path", "expectedStatus", "digestAlgorithm", "digestKeyId", "digestContext", "expectedJson",
  ]) || value.method !== "GET" || !boundedSafeText(value.path, 2_048) || !validExpectedStatus(value.expectedStatus)
    || value.digestAlgorithm !== "hmac-sha256-v1" || !boundedSafeText(value.digestKeyId, 64)
    || !isSha256(value.digestContext) || !Array.isArray(value.expectedJson)
    || value.expectedJson.length === 0 || value.expectedJson.length > 12) return false;
  return value.expectedJson.every((assertion) => isRecord(assertion)
    && hasExactKeys(assertion, ["pointer", "equalsType", "equalsHmacSha256"])
    && boundedSafeText(assertion.pointer, 1_024)
    && (assertion.equalsType === "null" || assertion.equalsType === "boolean"
      || assertion.equalsType === "number" || assertion.equalsType === "string")
    && isSha256(assertion.equalsHmacSha256));
}

function validateReproduction(value: unknown, modality: unknown): value is GitHubCorrectionReproduction {
  if (!isRecord(value) || value.modality !== modality) return false;
  if (modality === "api") {
    if (!hasExactKeys(value, ["modality", "request"]) || !isRecord(value.request)
      || !hasExactKeys(value.request, ["method", "path", "expectedStatus"])) return false;
    return value.request.method === "GET" && boundedSafeText(value.request.path, 2_048)
      && validExpectedStatus(value.request.expectedStatus);
  }
  if (modality === "data") {
    return hasExactKeys(value, ["modality", "request"]) && validateDataRequest(value.request);
  }
  if (modality === "job") {
    if (!hasExactKeys(value, ["modality", "request"]) || !isRecord(value.request)
      || !hasExactKeys(value.request, ["trigger", "readback"]) || !isRecord(value.request.trigger)
      || !hasExactKeys(value.request.trigger, ["method", "path", "expectedStatus"])) return false;
    return value.request.trigger.method === "POST" && boundedSafeText(value.request.trigger.path, 2_048)
      && validExpectedStatus(value.request.trigger.expectedStatus) && validateDataRequest(value.request.readback);
  }
  if (modality !== "ui" || !hasExactKeys(value, ["modality", "steps"])
    || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 12) return false;
  return value.steps.every((step) => {
    if (!isRecord(step) || typeof step.action !== "string") return false;
    switch (step.action) {
      case "open": return hasExactKeys(step, ["action", "path"]) && boundedSafeText(step.path, 2_048);
      case "click": return hasExactKeys(step, ["action", "selector"]) && boundedSafeText(step.selector, 2_048);
      case "fill": return hasExactKeys(step, ["action", "selector", "value"])
        && boundedSafeText(step.selector, 2_048) && step.value === "[REDACTED_FILL]";
      case "press": return hasExactKeys(step, ["action", "key"]) && boundedSafeText(step.key, 128);
      case "expect_text": return hasExactKeys(step, ["action", "text"]) && boundedSafeText(step.text, 2_048);
      case "screenshot": return hasExactKeys(step, ["action", "label"]) && boundedSafeText(step.label, 512);
      default: return false;
    }
  });
}

function expectedCorrectionPacketId(packet: GitHubCorrectionPacketPayload): string {
  return `correction-${sha256(JSON.stringify({
    jobId: packet.jobId,
    criterionId: packet.criterion.id,
    headSha: packet.headSha,
    recordId: packet.recordId,
    acceptanceContractId: packet.acceptanceContract.id,
    acceptanceContractVersion: packet.acceptanceContract.version,
  })).slice(0, 48)}`;
}

/** Self-contained packet guard so renderer and DB query modules remain acyclic. */
export function validateGitHubCorrectionPacketPayload(value: unknown): value is GitHubCorrectionPacketPayload {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "version", "packetId", "workspaceId", "repo", "prNumber", "headSha", "recordId", "jobId",
    "acceptanceContract", "criterion", "basis", "state", "expected", "observed", "affectedContext", "evidence",
    "scopeBoundary", "impact", "requiredCorrection", "reverification",
  ]) || value.kind !== "review_job_correction_packet" || value.version !== 1
    || !safeOpaqueId(value.workspaceId) || typeof value.repo !== "string" || !REPO.test(value.repo)
    || !isPositiveInteger(value.prNumber) || !isSha1(value.headSha) || !safeOpaqueId(value.recordId)
    || !safeOpaqueId(value.jobId) || typeof value.packetId !== "string" || !CORRECTION_PACKET_ID.test(value.packetId)
    || !isRecord(value.acceptanceContract) || !hasExactKeys(value.acceptanceContract, ["id", "version"])
    || !safeOpaqueId(value.acceptanceContract.id) || !isPositiveInteger(value.acceptanceContract.version)
    || !isRecord(value.criterion) || !hasExactKeys(value.criterion, ["id", "snapshot"])
    || !safeOpaqueId(value.criterion.id) || !boundedSafeText(value.criterion.snapshot, 2_000)
    || value.basis !== "acceptance_contract" || (value.state !== "failed" && value.state !== "not_proven")
    || value.expected !== value.criterion.snapshot || !boundedSafeText(value.expected, 2_000)
    || !boundedSafeText(value.observed, 2_000) || !isRecord(value.affectedContext)
    || !hasExactKeys(value.affectedContext, ["modality", "environmentKind", "flow", "reproduction"])
    || (value.affectedContext.modality !== "ui" && value.affectedContext.modality !== "api"
      && value.affectedContext.modality !== "data" && value.affectedContext.modality !== "job")
    || (value.affectedContext.environmentKind !== null && value.affectedContext.environmentKind !== "isolated_preview")
    || !boundedSafeText(value.affectedContext.flow, 2_000)
    || !validateReproduction(value.affectedContext.reproduction, value.affectedContext.modality)
    || !isRecord(value.evidence) || !hasExactKeys(value.evidence, [
      "evidenceRef",
      ...(Object.hasOwn(value.evidence, "artifactKey") ? ["artifactKey"] : []),
      ...(Object.hasOwn(value.evidence, "executionId") ? ["executionId"] : []),
      "previewBootId",
    ])
    || !boundedSafeText(value.evidence.evidenceRef, 2_000)
    || !boundedSafeText(value.evidence.previewBootId, 512)
    || (Object.hasOwn(value.evidence, "artifactKey") && !boundedSafeText(value.evidence.artifactKey, 2_000))
    || (Object.hasOwn(value.evidence, "executionId") && !boundedSafeText(value.evidence.executionId, 512))
    || !boundedSafeText(value.scopeBoundary, 2_000) || !boundedSafeText(value.impact, 2_000)
    || !boundedSafeText(value.requiredCorrection, 2_000) || !boundedSafeText(value.reverification, 2_000)) {
    return false;
  }
  return value.packetId === expectedCorrectionPacketId(value as GitHubCorrectionPacketPayload);
}

/** Canonical SHA-256 for one full validated R8.1 packet payload. */
export function githubCorrectionPacketPayloadSha256(packet: unknown): string | null {
  return validateGitHubCorrectionPacketPayload(packet) ? sha256(canonicalJson(packet)) : null;
}

/** Runtime guard for the closed server-derived dispatch binding. */
export function validateGitHubCorrectionDispatchBinding(value: unknown): value is GitHubCorrectionDispatchBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "version", "workspaceId", "dispatchId", "dispatchIdentitySha256", "recordId", "reviewJobId",
    "repo", "prNumber", "baseSha", "headSha", "headCycleId", "authorityGeneration", "packetId",
    "packetPayloadSha256", "acceptanceContract", "packetSetSha256", "correctionPacketPayloadSetSha256",
    "contextPack", "route", "capabilityProfile", "readyPreflight",
  ]) || value.kind !== GITHUB_CORRECTION_DISPATCH_BINDING_KIND
    || value.version !== GITHUB_CORRECTION_DISPATCH_BINDING_VERSION
    || !isUuid(value.workspaceId) || !isUuid(value.dispatchId) || !isSha256(value.dispatchIdentitySha256)
    || !safeOpaqueId(value.recordId) || !safeOpaqueId(value.reviewJobId)
    || typeof value.repo !== "string" || !REPO.test(value.repo)
    || !isPositiveInteger(value.prNumber) || !isSha1(value.baseSha) || !isSha1(value.headSha)
    || !isUuid(value.headCycleId) || typeof value.authorityGeneration !== "number"
    || !Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 0
    || !safeOpaqueId(value.packetId) || !isSha256(value.packetPayloadSha256) || !isRecord(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version", "sha256"])
    || !safeOpaqueId(value.acceptanceContract.id) || !isPositiveInteger(value.acceptanceContract.version)
    || !isSha256(value.acceptanceContract.sha256) || !isSha256(value.packetSetSha256)
    || !isSha256(value.correctionPacketPayloadSetSha256)
    || !isRecord(value.contextPack)
    || !hasExactKeys(value.contextPack, ["id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256"])
    || !safeOpaqueId(value.contextPack.id) || !isSha256(value.contextPack.sha256)
    || !safeOpaqueId(value.contextPack.sourceSnapshotId) || !isSha256(value.contextPack.sourceCustodyIdentitySha256)
    || !isRecord(value.route) || !hasExactKeys(value.route, ["id", "adapter", "configurationVersion"])
    || !isUuid(value.route.id) || (value.route.adapter !== "github_codex" && value.route.adapter !== "github_claude")
    || !isPositiveInteger(value.route.configurationVersion)
    || !isRecord(value.capabilityProfile)
    || !hasExactKeys(value.capabilityProfile, ["id", "snapshotSha256", "githubInstallationIdentitySha256"])
    || !isUuid(value.capabilityProfile.id) || !isSha256(value.capabilityProfile.snapshotSha256)
    || !isSha256(value.capabilityProfile.githubInstallationIdentitySha256)
    || !isRecord(value.readyPreflight) || !hasExactKeys(value.readyPreflight, ["id", "identitySha256"])
    || !isUuid(value.readyPreflight.id) || !isSha256(value.readyPreflight.identitySha256)) return false;
  return allStringsSafe(value);
}

/** Runtime guard for the exact activation custody embedded in the final bundle. */
export function validateGitHubCorrectionActivationBinding(value: unknown): value is GitHubCorrectionActivationBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "version", "workspaceId", "dispatchId", "dispatchIdentitySha256", "recordId", "reviewJobId",
    "repo", "prNumber", "baseSha", "headSha", "headCycleId", "authorityGeneration", "acceptanceContract",
    "contextPack", "packetIds", "packetSetSha256", "correctionPacketPayloadSetSha256", "route",
    "capabilityProfile", "readyPreflight", "findingCoverageSha256", "recipient",
  ]) || value.kind !== GITHUB_CORRECTION_ACTIVATION_BINDING_KIND
    || value.version !== GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION
    || !isUuid(value.workspaceId) || !isUuid(value.dispatchId) || !isSha256(value.dispatchIdentitySha256)
    || !safeOpaqueId(value.recordId) || !safeOpaqueId(value.reviewJobId)
    || typeof value.repo !== "string" || !REPO.test(value.repo)
    || !isPositiveInteger(value.prNumber) || !isSha1(value.baseSha) || !isSha1(value.headSha)
    || !isUuid(value.headCycleId) || typeof value.authorityGeneration !== "number"
    || !Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 0
    || !isRecord(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version", "sha256"])
    || !safeOpaqueId(value.acceptanceContract.id) || !isPositiveInteger(value.acceptanceContract.version)
    || !isSha256(value.acceptanceContract.sha256)
    || !isRecord(value.contextPack)
    || !hasExactKeys(value.contextPack, ["id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256"])
    || !safeOpaqueId(value.contextPack.id) || !isSha256(value.contextPack.sha256)
    || !safeOpaqueId(value.contextPack.sourceSnapshotId) || !isSha256(value.contextPack.sourceCustodyIdentitySha256)
    || !isSortedUniqueOpaqueIds(value.packetIds)
    || !isSha256(value.packetSetSha256) || !isSha256(value.correctionPacketPayloadSetSha256)
    || expectedPacketSetSha256(value.packetIds) !== value.packetSetSha256.toLowerCase()
    || !isRecord(value.route) || !hasExactKeys(value.route, ["id", "adapter", "configurationVersion"])
    || !isUuid(value.route.id) || (value.route.adapter !== "github_codex" && value.route.adapter !== "github_claude")
    || !isPositiveInteger(value.route.configurationVersion)
    || !isRecord(value.capabilityProfile)
    || !hasExactKeys(value.capabilityProfile, ["id", "snapshotSha256", "githubInstallationIdentitySha256"])
    || !isUuid(value.capabilityProfile.id) || !isSha256(value.capabilityProfile.snapshotSha256)
    || !isSha256(value.capabilityProfile.githubInstallationIdentitySha256)
    || !isRecord(value.readyPreflight) || !hasExactKeys(value.readyPreflight, ["id", "identitySha256"])
    || !isUuid(value.readyPreflight.id) || !isSha256(value.readyPreflight.identitySha256)
    || !isSha256(value.findingCoverageSha256)
    || (value.recipient !== "codex" && value.recipient !== "claude")
    || (value.route.adapter === "github_codex" ? value.recipient !== "codex" : value.recipient !== "claude")) {
    return false;
  }
  return allStringsSafe(value);
}

function bindingMatchesPacket(binding: GitHubCorrectionDispatchBinding, packet: GitHubCorrectionPacketPayload): boolean {
  return binding.workspaceId === packet.workspaceId && binding.repo === packet.repo && binding.prNumber === packet.prNumber
    && binding.headSha.toLowerCase() === packet.headSha.toLowerCase()
    && binding.packetId === packet.packetId && binding.recordId === packet.recordId && binding.reviewJobId === packet.jobId
    && binding.acceptanceContract.id === packet.acceptanceContract.id
    && binding.acceptanceContract.version === packet.acceptanceContract.version
    && binding.packetPayloadSha256.toLowerCase() === githubCorrectionPacketPayloadSha256(packet);
}

function activationBindingMatchesPackets(
  binding: GitHubCorrectionActivationBinding,
  packets: readonly GitHubCorrectionPacketPayload[]
): boolean {
  if (packets.length !== binding.packetIds.length
    || expectedPacketPayloadSetSha256(packets) !== binding.correctionPacketPayloadSetSha256.toLowerCase()) return false;
  const criterionIds = new Set<string>();
  return packets.every((packet, index) => {
    if (packet.packetId !== binding.packetIds[index] || criterionIds.has(packet.criterion.id)) return false;
    criterionIds.add(packet.criterion.id);
    return packet.workspaceId === binding.workspaceId && packet.recordId === binding.recordId
      && packet.jobId === binding.reviewJobId && packet.repo === binding.repo && packet.prNumber === binding.prNumber
      && packet.headSha.toLowerCase() === binding.headSha.toLowerCase()
      && packet.acceptanceContract.id === binding.acceptanceContract.id
      && packet.acceptanceContract.version === binding.acceptanceContract.version;
  });
}

/** Escape all untrusted Markdown punctuation, including GitHub mention syntax. */
function markdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1").replace(/@/gu, "＠");
}

function evidenceLines(packet: GitHubCorrectionPacketPayload): string[] | null {
  const { evidence } = packet;
  if (!evidence.previewBootId) return null;
  return [
    `- Evidence reference: ${markdownText(evidence.evidenceRef)}`,
    ...(evidence.artifactKey ? [`- Artifact key: ${markdownText(evidence.artifactKey)}`] : []),
    ...(evidence.executionId ? [`- Execution ID: ${markdownText(evidence.executionId)}`] : []),
    `- Preview boot ID: ${markdownText(evidence.previewBootId)}`,
  ];
}

function reproductionLines(reproduction: GitHubCorrectionReproduction): string[] {
  switch (reproduction.modality) {
    case "ui":
      return reproduction.steps.map((step, index) => {
        const detail = step.action === "open" ? step.path
          : step.action === "click" || step.action === "fill" ? step.selector
          : step.action === "press" ? step.key
          : step.action === "expect_text" ? step.text
          : step.label;
        const suffix = step.action === "fill" ? " (input redacted)" : "";
        return `${index + 1}. ${markdownText(step.action)}: ${markdownText(detail)}${suffix}`;
      });
    case "api":
      return [`1. ${reproduction.request.method} ${markdownText(reproduction.request.path)}; expected HTTP ${reproduction.request.expectedStatus}.`];
    case "data":
      return [
        `1. ${reproduction.request.method} ${markdownText(reproduction.request.path)}; expected HTTP ${reproduction.request.expectedStatus}.`,
        `2. Verify ${reproduction.request.expectedJson.length} HMAC-bound assertion(s) without disclosing scalar values.`,
      ];
    case "job":
      return [
        `1. ${reproduction.request.trigger.method} ${markdownText(reproduction.request.trigger.path)}; expected HTTP ${reproduction.request.trigger.expectedStatus}.`,
        `2. ${reproduction.request.readback.method} ${markdownText(reproduction.request.readback.path)}; expected HTTP ${reproduction.request.readback.expectedStatus}.`,
        `3. Verify ${reproduction.request.readback.expectedJson.length} HMAC-bound readback assertion(s) without disclosing scalar values.`,
      ];
  }
}

function marker(digest: string): string {
  return `${MARKER_PREFIX}${digest}${MARKER_SUFFIX}`;
}

/**
 * Render one inert, human-visible GitHub finding from prevalidated custody.
 * This has no GitHub client, network, database, or agent-activation behavior.
 */
export function renderGitHubCorrectionFinding(input: {
  packet: GitHubCorrectionPacketPayload;
  binding: GitHubCorrectionDispatchBinding;
}): RenderedGitHubCorrectionFinding | null {
  const { packet, binding } = input;
  if (!validateGitHubCorrectionPacketPayload(packet) || !validateGitHubCorrectionDispatchBinding(binding)
    || !bindingMatchesPacket(binding, packet) || !allStringsSafe(packet)) return null;

  const reproduction = packet.affectedContext.reproduction;
  const evidence = evidenceLines(packet);
  if (!reproduction || !evidence) return null;
  const body = [
    "## AgentRail correction finding",
    "",
    "This is a human-visible correction finding. It does not activate, assign, or instruct an agent account.",
    "",
    "## Trusted identity",
    `- Packet ID: ${markdownText(packet.packetId)}`,
    `- Criterion: ${markdownText(packet.criterion.id)}`,
    `- Original exact head: ${markdownText(packet.headSha)}`,
    `- Admitted base: ${markdownText(binding.baseSha)}`,
    `- Head cycle: ${markdownText(binding.headCycleId)}`,
    `- Authority generation: ${binding.authorityGeneration}`,
    `- Acceptance Contract: ${markdownText(packet.acceptanceContract.id)} v${packet.acceptanceContract.version}`,
    `- Acceptance Contract SHA-256: ${binding.acceptanceContract.sha256.toLowerCase()}`,
    `- GitHub dispatch: ${markdownText(binding.dispatchId)}`,
    `- Dispatch identity SHA-256: ${binding.dispatchIdentitySha256.toLowerCase()}`,
    `- Dispatch record: ${markdownText(binding.recordId)}`,
    `- Review job: ${markdownText(binding.reviewJobId)}`,
    `- Context Pack: ${markdownText(binding.contextPack.id)} (SHA-256: ${binding.contextPack.sha256.toLowerCase()})`,
    `- Context custody SHA-256: ${binding.contextPack.sourceCustodyIdentitySha256.toLowerCase()}`,
    `- Packet payload SHA-256: ${binding.packetPayloadSha256.toLowerCase()}`,
    `- Packet-set SHA-256: ${binding.packetSetSha256.toLowerCase()}`,
    `- Correction-payload-set SHA-256: ${binding.correctionPacketPayloadSetSha256.toLowerCase()}`,
    `- Builder route: ${binding.route.adapter} (${markdownText(binding.route.id)} v${binding.route.configurationVersion})`,
    `- Capability profile: ${markdownText(binding.capabilityProfile.id)} (SHA-256: ${binding.capabilityProfile.snapshotSha256.toLowerCase()})`,
    `- GitHub installation identity SHA-256: ${binding.capabilityProfile.githubInstallationIdentitySha256.toLowerCase()}`,
    `- Ready preflight: ${markdownText(binding.readyPreflight.id)} (SHA-256: ${binding.readyPreflight.identitySha256.toLowerCase()})`,
    "",
    "## Expected",
    markdownText(packet.expected),
    "",
    "## Observed",
    markdownText(packet.observed),
    "",
    "## Reproduction",
    ...reproductionLines(reproduction),
    "",
    "## Impact",
    markdownText(packet.impact),
    "",
    "## Required correction",
    markdownText(packet.requiredCorrection),
    "",
    "## Scope boundary",
    markdownText(packet.scopeBoundary),
    "",
    "## Reverification",
    markdownText(packet.reverification),
    "",
    "## Evidence metadata",
    ...evidence,
  ].join("\n");
  const digest = sha256(body);
  const comment = `${body}\n\n${marker(digest)}`;
  return Buffer.byteLength(comment, "utf8") <= MAX_GITHUB_CORRECTION_FINDING_BYTES
    && !ASCII_MENTION.test(comment) && !URL_LIKE.test(comment) && secretsClean(comment)
    ? { comment, body, sha256: digest }
    : null;
}

/** Parse only the inert marker and verify the body digest; it never executes comment content. */
export function parseGitHubCorrectionFindingComment(comment: unknown): RenderedGitHubCorrectionFinding | null {
  if (typeof comment !== "string" || Buffer.byteLength(comment, "utf8") === 0
    || Buffer.byteLength(comment, "utf8") > MAX_GITHUB_CORRECTION_FINDING_BYTES
    || COMMENT_CONTROL_OR_BIDI.test(comment) || ASCII_MENTION.test(comment) || URL_LIKE.test(comment)
    || RAW_SOURCE_LIKE.test(comment) || !secretsClean(comment)) return null;
  const boundary = comment.lastIndexOf("\n\n<!--");
  if (boundary <= 0) return null;
  const body = comment.slice(0, boundary);
  const suppliedMarker = comment.slice(boundary + 2);
  const digest = sha256(body);
  return REQUIRED_HEADINGS.every((heading) => body.includes(heading)) && suppliedMarker === marker(digest)
    ? { comment, body, sha256: digest }
    : null;
}

/** Strict receipt seam: accept a comment only when it is exactly this packet and binding's rendering. */
export function isExactGitHubCorrectionFindingComment(input: {
  comment: unknown;
  packet: GitHubCorrectionPacketPayload;
  binding: GitHubCorrectionDispatchBinding;
}): boolean {
  const rendered = renderGitHubCorrectionFinding({ packet: input.packet, binding: input.binding });
  return rendered !== null && input.comment === rendered.comment;
}

/**
 * Render the sole selected-recipient activation from full immutable packet
 * custody. The bundle is canonical UTF-8 JSON encoded as unpadded base64url so
 * packet text cannot accidentally create GitHub mentions or Markdown links.
 */
export function renderGitHubCorrectionActivation(input: {
  binding: GitHubCorrectionActivationBinding;
  packets: readonly GitHubCorrectionPacketPayload[];
}): GitHubCorrectionActivationRendering {
  if (!validateGitHubCorrectionActivationBinding(input.binding)) {
    return { ok: false, reason: "invalid_binding" };
  }
  if (!Array.isArray(input.packets) || input.packets.length === 0 || input.packets.length > 100
    || input.packets.some((packet) => !validateGitHubCorrectionPacketPayload(packet) || !allStringsSafe(packet))) {
    return { ok: false, reason: "unsafe_packet" };
  }
  if (!activationBindingMatchesPackets(input.binding, input.packets)) {
    return { ok: false, reason: "invalid_binding" };
  }

  let packetBundleJson: string;
  try {
    packetBundleJson = canonicalJson({
      kind: GITHUB_CORRECTION_ACTIVATION_BUNDLE_KIND,
      version: GITHUB_CORRECTION_ACTIVATION_BUNDLE_VERSION,
      binding: input.binding,
      packets: input.packets,
    });
  } catch {
    return { ok: false, reason: "unsafe_packet" };
  }
  const packetBundleBytes = Buffer.from(packetBundleJson, "utf8");
  const packetBundleBase64url = packetBundleBytes.toString("base64url");
  const packetBundleSha256 = sha256(packetBundleBytes);
  const body = [
    "## AgentRail correction dispatch",
    "",
    `@${input.binding.recipient} consume the complete immutable correction bundle below and repair only this pull request at its next head.`,
    "Do not change this packet set or claim acknowledgement or repair until a verifiable receipt and a new repair head exist.",
    "",
    "## Exact dispatch custody",
    `- Dispatch ID: ${input.binding.dispatchId}`,
    `- Repository and PR: ${input.binding.repo} #${input.binding.prNumber}`,
    `- Original exact head: ${input.binding.headSha.toLowerCase()}`,
    `- Finding coverage SHA-256: ${input.binding.findingCoverageSha256.toLowerCase()}`,
    `- Packet bundle SHA-256: ${packetBundleSha256}`,
    "- Packet bundle encoding: unpadded base64url of canonical UTF-8 JSON",
    "",
    "## Complete immutable correction bundle",
    packetBundleBase64url,
  ].join("\n");

  const mentions = body.match(/@[A-Za-z0-9_-]+/gu) ?? [];
  if (Buffer.byteLength(body, "utf8") > MAX_GITHUB_CORRECTION_ACTIVATION_BYTES) {
    return { ok: false, reason: "activation_body_too_large", packetBundleSha256 };
  }
  if (COMMENT_CONTROL_OR_BIDI.test(body) || URL_LIKE.test(body) || RAW_SOURCE_LIKE.test(body)
    || !secretsClean(body) || body.split("@").length !== 2
    || mentions.length !== 1 || mentions[0] !== `@${input.binding.recipient}`
    || body.split(packetBundleBase64url).length !== 2 || body.split(packetBundleSha256).length !== 2) {
    return { ok: false, reason: "unsafe_packet" };
  }
  return {
    ok: true,
    body,
    bodySha256: sha256(body),
    packetBundleJson,
    packetBundleBase64url,
    packetBundleSha256,
  };
}
