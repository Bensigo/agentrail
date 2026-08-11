import { createHash } from "node:crypto";
import {
  isSecretFreeGitHubCorrectionText,
  validateStoredGitHubCorrectionPacketPayload,
  type GitHubCorrectionPacketPayload,
} from "./github-correction-dispatch-renderer.js";

export const ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_TITLE_BYTES = 256;
export const ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_BODY_BYTES = 24 * 1024;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_RENDER_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}]/u;
const ASCII_MENTION = /@/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("canonical JSON requires plain JSON values");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Neutralizes GitHub mentions plus Markdown and HTML syntax in packet-owned text. */
function neutralizedMarkdown(value: string): string {
  return value
    .replace(/@/gu, "＠")
    .replace(/&/gu, "＆")
    .replace(/</gu, "＜")
    .replace(/>/gu, "＞")
    .replace(/([\\`*_{}\[\]()#+\-.!|])/gu, "\\$1");
}

export type AcceptanceGatedGithubIssuePacketIdentity = {
  packetId: string;
  sha256: string;
};

export type AcceptanceGatedGithubIssueRenderBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  reviewJobId: string;
  authorityGeneration: number;
  acceptanceContract: { id: string; version: number; sha256: string };
  criterionOutcomeBundle: {
    id: string;
    eventId: string;
    sha256: string;
    postedAttestationEventId: string;
  };
  packets: AcceptanceGatedGithubIssuePacketIdentity[];
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
};

export type AcceptanceGatedGithubIssueRendering =
  | {
      ok: true;
      title: string;
      body: string;
      titleSha256: string;
      bodySha256: string;
      requestIdentitySha256: string;
    }
  | { ok: false; reason: "invalid_gated_issue_rendering" | "gated_issue_body_too_large" };

export function acceptanceGatedGithubIssueRequestIdentitySha256(input: {
  binding: AcceptanceGatedGithubIssueRenderBinding;
  titleSha256: string;
  bodySha256: string;
}): string {
  return sha256(canonicalJson({
    kind: "acceptance_gated_github_issue_request",
    version: 1,
    binding: input.binding,
    titleSha256: input.titleSha256,
    bodySha256: input.bodySha256,
  }));
}

function validBinding(binding: AcceptanceGatedGithubIssueRenderBinding): boolean {
  return UUID.test(binding.workspaceId) && UUID.test(binding.recordId)
    && REPO.test(binding.repo) && !binding.repo.split("/").some((segment) => segment === "." || segment === "..")
    && Number.isSafeInteger(binding.prNumber) && binding.prNumber > 0
    && SHA1.test(binding.headSha) && UUID.test(binding.headCycleId)
    && UUID.test(binding.reviewJobId) && binding.reviewJobId === binding.headCycleId
    && Number.isSafeInteger(binding.authorityGeneration) && binding.authorityGeneration >= 0
    && UUID.test(binding.acceptanceContract.id) && Number.isSafeInteger(binding.acceptanceContract.version)
    && binding.acceptanceContract.version > 0 && SHA256.test(binding.acceptanceContract.sha256)
    && UUID.test(binding.criterionOutcomeBundle.id) && UUID.test(binding.criterionOutcomeBundle.eventId)
    && UUID.test(binding.criterionOutcomeBundle.postedAttestationEventId)
    && SHA256.test(binding.criterionOutcomeBundle.sha256)
    && Array.isArray(binding.packets) && binding.packets.length > 0 && binding.packets.length <= 100
    && binding.packets.every((packet, index) => /^correction-[a-f0-9]{48}$/u.test(packet.packetId)
      && SHA256.test(packet.sha256)
      && (index === 0 || Buffer.compare(
        Buffer.from(binding.packets[index - 1]!.packetId, "utf8"),
        Buffer.from(packet.packetId, "utf8"),
      ) < 0))
    && SHA256.test(binding.packetSetSha256)
    && SHA256.test(binding.correctionPacketPayloadSetSha256);
}

function renderablePacket(value: unknown): value is GitHubCorrectionPacketPayload {
  if (!validateStoredGitHubCorrectionPacketPayload(value)) return false;
  const packet = value;
  const criterion = packet.criterion;
  const evidence = packet.evidence;
  const selected = [
    packet.packetId, packet.workspaceId, packet.repo, packet.recordId, packet.jobId,
    criterion?.id, criterion?.snapshot, packet.expected, packet.observed,
    packet.requiredCorrection, packet.reverification, evidence?.evidenceRef,
  ];
  return selected.every((item) => typeof item === "string" && item.length > 0
      && !CONTROL_OR_FORMAT.test(item) && isSecretFreeGitHubCorrectionText(item));
}

/**
 * Builds the sole server-issued GitHub issue request. It deliberately omits
 * labels, agent mentions, artifact/object keys, execution ids, preview ids,
 * and raw source coordinates.
 */
export function renderAcceptanceGatedGithubIssue(input: {
  binding: AcceptanceGatedGithubIssueRenderBinding;
  packets: readonly Record<string, unknown>[];
}): AcceptanceGatedGithubIssueRendering {
  const { binding } = input;
  if (!validBinding(binding) || !Array.isArray(input.packets)
    || input.packets.length !== binding.packets.length) {
    return { ok: false, reason: "invalid_gated_issue_rendering" };
  }
  const packets = input.packets as GitHubCorrectionPacketPayload[];
  if (!packets.every((packet, index) => renderablePacket(packet)
    && packet.packetId === binding.packets[index]!.packetId
    && sha256(canonicalJson(packet)) === binding.packets[index]!.sha256
    && packet.workspaceId === binding.workspaceId && packet.recordId === binding.recordId
    && packet.repo === binding.repo && packet.prNumber === binding.prNumber
    && packet.headSha.toLowerCase() === binding.headSha
    && packet.jobId === binding.reviewJobId
    && packet.acceptanceContract.id === binding.acceptanceContract.id
    && packet.acceptanceContract.version === binding.acceptanceContract.version)) {
    return { ok: false, reason: "invalid_gated_issue_rendering" };
  }

  const title = `Acceptance corrections for pull request #${binding.prNumber}`;
  const packetSections = packets.flatMap((packet, index) => [
    `## Correction ${index + 1} of ${packets.length}`,
    "",
    `- Packet ID: ${neutralizedMarkdown(packet.packetId)}`,
    `- Packet SHA-256: ${binding.packets[index]!.sha256}`,
    `- State: ${packet.state}`,
    `- Criterion ID: ${neutralizedMarkdown(packet.criterion.id)}`,
    "",
    "### Criterion snapshot",
    neutralizedMarkdown(packet.criterion.snapshot),
    "",
    "### Expected",
    neutralizedMarkdown(packet.expected),
    "",
    "### Observed",
    neutralizedMarkdown(packet.observed),
    "",
    "### Required correction",
    neutralizedMarkdown(packet.requiredCorrection),
    "",
    "### Reverification",
    neutralizedMarkdown(packet.reverification),
    "",
    "### Evidence reference",
    `SHA-256: ${sha256(packet.evidence.evidenceRef)}`,
    "",
  ]);
  const body = [
    "# Acceptance correction follow-up",
    "",
    `This human-gated issue is bound to pull request #${binding.prNumber} and its exact reviewed head occurrence.`,
    "It contains no automation trigger label and does not prove agent notification, acknowledgement, repair, merge, or delivery.",
    "",
    "## Exact custody",
    "",
    `- Workspace: ${binding.workspaceId}`,
    `- Acceptance Record: ${binding.recordId}`,
    `- Repository: ${binding.repo}`,
    `- Head SHA: ${binding.headSha}`,
    `- Head cycle: ${binding.headCycleId}`,
    `- Review job: ${binding.reviewJobId}`,
    `- Authority generation: ${binding.authorityGeneration}`,
    `- Acceptance Contract: ${binding.acceptanceContract.id} v${binding.acceptanceContract.version}`,
    `- Acceptance Contract SHA-256: ${binding.acceptanceContract.sha256}`,
    `- Criterion outcome bundle: ${binding.criterionOutcomeBundle.id}`,
    `- Criterion outcome bundle event: ${binding.criterionOutcomeBundle.eventId}`,
    `- Criterion outcome bundle SHA-256: ${binding.criterionOutcomeBundle.sha256}`,
    `- Posted attestation event: ${binding.criterionOutcomeBundle.postedAttestationEventId}`,
    `- Packet-set SHA-256: ${binding.packetSetSha256}`,
    `- Packet-payload-set SHA-256: ${binding.correctionPacketPayloadSetSha256}`,
    "",
    ...packetSections,
  ].join("\n").trimEnd();

  if (Buffer.byteLength(title, "utf8") > ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_TITLE_BYTES
    || UNSAFE_RENDER_CONTROL.test(title) || UNSAFE_RENDER_CONTROL.test(body)
    || ASCII_MENTION.test(title) || ASCII_MENTION.test(body)
    || /<\/?[A-Za-z][^>]*>/u.test(body)
    || !isSecretFreeGitHubCorrectionText(title) || !isSecretFreeGitHubCorrectionText(body)) {
    return { ok: false, reason: "invalid_gated_issue_rendering" };
  }
  if (Buffer.byteLength(body, "utf8") > ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_BODY_BYTES) {
    return { ok: false, reason: "gated_issue_body_too_large" };
  }
  const titleSha256 = sha256(title);
  const bodySha256 = sha256(body);
  return {
    ok: true,
    title,
    body,
    titleSha256,
    bodySha256,
    requestIdentitySha256: acceptanceGatedGithubIssueRequestIdentitySha256({
      binding, titleSha256, bodySha256,
    }),
  };
}
