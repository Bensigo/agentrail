import { createHash } from "node:crypto";
import { validateReviewJobCorrectionPacketPayload } from "@agentrail/db-postgres";
import { scanForSecrets } from "./secret-scan";
import type { CorrectionReproduction, ReviewJobCorrectionPacket } from "./review-job-correction-packet";

/** A deliberately small, server-attested binding for one GitHub finding write. */
export const GITHUB_CORRECTION_DISPATCH_BINDING_KIND = "github_correction_dispatch";
export const GITHUB_CORRECTION_DISPATCH_BINDING_VERSION = 1;
export const MAX_GITHUB_CORRECTION_FINDING_CHARS = 12_000;

export interface GitHubCorrectionDispatchBinding extends Record<string, unknown> {
  kind: typeof GITHUB_CORRECTION_DISPATCH_BINDING_KIND;
  version: typeof GITHUB_CORRECTION_DISPATCH_BINDING_VERSION;
  dispatchId: string;
  recordId: string;
  reviewJobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  packetId: string;
  acceptanceContract: { id: string; version: number };
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  contextPack: {
    id: string;
    sha256: string;
  };
}

export interface RenderedGitHubCorrectionFinding {
  /** Complete GitHub comment body, including the inert custody marker. */
  comment: string;
  /** Human-visible portion of the comment. The digest is computed over this exact value. */
  body: string;
  sha256: string;
}

const SHA1 = /^[a-f0-9]{40}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value) && safeText(value);
}

function safeText(value: string): boolean {
  return value.length > 0 && !CONTROL_OR_BIDI.test(value) && !URL_LIKE.test(value)
    && !RAW_SOURCE_LIKE.test(value) && scanForSecrets(value).clean;
}

function allStringsSafe(value: unknown): boolean {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.every(allStringsSafe);
  if (!isRecord(value)) return true;
  return Object.values(value).every(allStringsSafe);
}

/** Runtime guard for the closed server-derived dispatch binding. */
export function validateGitHubCorrectionDispatchBinding(value: unknown): value is GitHubCorrectionDispatchBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "version", "dispatchId", "recordId", "reviewJobId", "repo", "prNumber", "headSha", "packetId",
    "acceptanceContract", "packetSetSha256", "correctionPacketPayloadSetSha256", "contextPack",
  ]) || value.kind !== GITHUB_CORRECTION_DISPATCH_BINDING_KIND
    || value.version !== GITHUB_CORRECTION_DISPATCH_BINDING_VERSION
    || typeof value.dispatchId !== "string" || !UUID.test(value.dispatchId) || !safeText(value.dispatchId)
    || !safeOpaqueId(value.recordId) || !safeOpaqueId(value.reviewJobId)
    || typeof value.repo !== "string" || !REPO.test(value.repo)
    || typeof value.prNumber !== "number" || !Number.isInteger(value.prNumber) || value.prNumber <= 0
    || typeof value.headSha !== "string" || !SHA1.test(value.headSha)
    || !safeOpaqueId(value.packetId) || !isRecord(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version"])
    || !safeOpaqueId(value.acceptanceContract.id) || typeof value.acceptanceContract.version !== "number"
    || !Number.isInteger(value.acceptanceContract.version) || value.acceptanceContract.version <= 0
    || typeof value.packetSetSha256 !== "string" || !SHA256.test(value.packetSetSha256)
    || typeof value.correctionPacketPayloadSetSha256 !== "string" || !SHA256.test(value.correctionPacketPayloadSetSha256)
    || !isRecord(value.contextPack)
    || !hasExactKeys(value.contextPack, ["id", "sha256"])
    || !safeOpaqueId(value.contextPack.id) || typeof value.contextPack.sha256 !== "string"
    || !SHA256.test(value.contextPack.sha256)) return false;
  return allStringsSafe(value);
}

function bindingMatchesPacket(binding: GitHubCorrectionDispatchBinding, packet: ReviewJobCorrectionPacket): boolean {
  return binding.repo === packet.repo && binding.prNumber === packet.prNumber
    && binding.headSha.toLowerCase() === packet.headSha.toLowerCase()
    && binding.packetId === packet.packetId && binding.recordId === packet.recordId && binding.reviewJobId === packet.jobId
    && binding.acceptanceContract.id === packet.acceptanceContract.id
    && binding.acceptanceContract.version === packet.acceptanceContract.version;
}

/** Escape all untrusted Markdown punctuation, including GitHub mention syntax. */
function markdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1").replace(/@/gu, "＠");
}

function evidenceLines(packet: ReviewJobCorrectionPacket): string[] | null {
  const { evidence } = packet;
  if (!evidence.previewBootId) return null;
  return [
    `- Evidence reference: ${markdownText(evidence.evidenceRef)}`,
    ...(evidence.artifactKey ? [`- Artifact key: ${markdownText(evidence.artifactKey)}`] : []),
    ...(evidence.executionId ? [`- Execution ID: ${markdownText(evidence.executionId)}`] : []),
    `- Preview boot ID: ${markdownText(evidence.previewBootId)}`,
  ];
}

function reproductionLines(reproduction: CorrectionReproduction): string[] {
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function marker(digest: string): string {
  return `${MARKER_PREFIX}${digest}${MARKER_SUFFIX}`;
}

/**
 * Render one inert, human-visible GitHub finding from prevalidated custody.
 * This has no GitHub client, network, database, or agent-activation behavior.
 */
export function renderGitHubCorrectionFinding(input: {
  packet: ReviewJobCorrectionPacket;
  binding: GitHubCorrectionDispatchBinding;
}): RenderedGitHubCorrectionFinding | null {
  const { packet, binding } = input;
  if (!validateReviewJobCorrectionPacketPayload(packet) || !validateGitHubCorrectionDispatchBinding(binding)
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
    `- Acceptance Contract: ${markdownText(packet.acceptanceContract.id)} v${packet.acceptanceContract.version}`,
    `- GitHub dispatch: ${markdownText(binding.dispatchId)}`,
    `- Dispatch record: ${markdownText(binding.recordId)}`,
    `- Review job: ${markdownText(binding.reviewJobId)}`,
    `- Context Pack: ${markdownText(binding.contextPack.id)} (SHA-256: ${binding.contextPack.sha256.toLowerCase()})`,
    `- Packet-set SHA-256: ${binding.packetSetSha256.toLowerCase()}`,
    `- Correction-payload-set SHA-256: ${binding.correctionPacketPayloadSetSha256.toLowerCase()}`,
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
  return comment.length <= MAX_GITHUB_CORRECTION_FINDING_CHARS
    && !ASCII_MENTION.test(comment) && !URL_LIKE.test(comment) && scanForSecrets(comment).clean
    ? { comment, body, sha256: digest }
    : null;
}

/** Parse only the inert marker and verify the body digest; it never executes comment content. */
export function parseGitHubCorrectionFindingComment(comment: unknown): RenderedGitHubCorrectionFinding | null {
  if (typeof comment !== "string" || comment.length === 0 || comment.length > MAX_GITHUB_CORRECTION_FINDING_CHARS
    || COMMENT_CONTROL_OR_BIDI.test(comment) || ASCII_MENTION.test(comment) || URL_LIKE.test(comment)
    || RAW_SOURCE_LIKE.test(comment) || !scanForSecrets(comment).clean) return null;
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
  packet: ReviewJobCorrectionPacket;
  binding: GitHubCorrectionDispatchBinding;
}): boolean {
  const rendered = renderGitHubCorrectionFinding({ packet: input.packet, binding: input.binding });
  return rendered !== null && input.comment === rendered.comment;
}
