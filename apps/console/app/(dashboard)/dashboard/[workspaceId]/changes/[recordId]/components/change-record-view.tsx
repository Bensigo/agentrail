"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CopyId } from "../../../../../../components/copy-id";
import { PageHeader } from "../../../../../../components/page-header";

export type ChangeRecord = {
  id: string;
  workspaceId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  headShas: string[];
  mergedSha: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
};

export type ChangeRecordEvent = {
  id: string;
  recordId: string;
  eventKey: string;
  stage: string;
  actor: string;
  payloadRef: Record<string, unknown>;
  at: string;
  createdAt: string;
};

type SafeDataRequestDescriptor = {
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
};

type CorrectionReproduction =
  | {
      modality: "ui";
      steps: Array<
        | { action: "open"; path: string }
        | { action: "click"; selector: string }
        | { action: "fill"; selector: string; value: "[REDACTED_FILL]" }
        | { action: "press"; key: string }
        | { action: "expect_text"; text: string }
        | { action: "screenshot"; label: string }
      >;
    }
  | { modality: "api"; request: { method: "GET"; path: string; expectedStatus: number } }
  | { modality: "data"; request: SafeDataRequestDescriptor }
  | {
      modality: "job";
      request: {
        trigger: { method: "POST"; path: string; expectedStatus: number };
        readback: SafeDataRequestDescriptor;
      };
    };

export type AcceptanceCorrectionPacket = {
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
    flow: string;
    reproduction: CorrectionReproduction;
  };
  evidence: {
    evidenceRef: string;
    artifactKey?: string;
    executionId?: string;
    previewBootId: string;
  };
  scopeBoundary: string;
  impact: string;
  requiredCorrection: string;
  reverification: string;
};

export type AcceptanceCorrectionPacketsEnvelope =
  | {
      kind: "current";
      binding: {
        workspaceId: string;
        recordId: string;
        reviewJobId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      packetIds: string[];
      packetSetSha256: string;
      correctionPacketPayloadSetSha256: string;
      packets: AcceptanceCorrectionPacket[];
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "no_correction_packets"
        | "invalid_packet_custody";
    };

export type AcceptancePrDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "approved_with_exception";

export type AcceptanceFinalDecisionEnvelope =
  | {
      kind: "current";
      binding: {
        bindingId: string;
        workspaceId: string;
        recordId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        reviewJobId: string;
        reviewVerdict: "proven" | "failed" | "not_proven" | "not_testable";
        postedReviewUrl: string;
        postedAttestationEventId: string;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      decision: null | {
        eventId: string;
        eventKey: string;
        decision: AcceptancePrDecision;
        rationale: string | null;
        decidedBy: string;
        decidedRole: "owner" | "admin";
        decidedAt: string;
      };
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "posted_attestation_unavailable"
        | "invalid_review_custody"
        | "invalid_decision_custody";
    };

type ChangeRecordResponse = {
  record: ChangeRecord;
  events: ChangeRecordEvent[];
  correctionPackets: AcceptanceCorrectionPacketsEnvelope;
  finalDecision: AcceptanceFinalDecisionEnvelope;
  canRecordFinalDecision: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const CORRECTION_PACKET_ID = /^correction-[a-f0-9]{48}$/i;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !SECRET_LIKE.test(value);
}

function isSafeRepo(value: unknown): value is string {
  return typeof value === "string" && SAFE_REPO.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalSafeText(value: Record<string, unknown>, key: string, max: number): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || isSafeText(value[key], max);
}

function isSafeDataRequestDescriptor(value: unknown): value is SafeDataRequestDescriptor {
  if (!isObject(value) || !hasExactKeys(value, [
    "method", "path", "expectedStatus", "digestAlgorithm", "digestKeyId", "digestContext", "expectedJson",
  ]) || value.method !== "GET" || !isSafeText(value.path, 2_048)
    || !isHttpStatus(value.expectedStatus) || value.digestAlgorithm !== "hmac-sha256-v1"
    || !isSafeText(value.digestKeyId, 64) || typeof value.digestContext !== "string"
    || !SHA256.test(value.digestContext) || !Array.isArray(value.expectedJson)
    || value.expectedJson.length === 0 || value.expectedJson.length > 12) return false;
  return value.expectedJson.every((assertion) => isObject(assertion)
    && hasExactKeys(assertion, ["pointer", "equalsType", "equalsHmacSha256"])
    && isSafeText(assertion.pointer, 1_024)
    && (assertion.equalsType === "null" || assertion.equalsType === "boolean"
      || assertion.equalsType === "number" || assertion.equalsType === "string")
    && typeof assertion.equalsHmacSha256 === "string" && SHA256.test(assertion.equalsHmacSha256));
}

function isUiReproductionStep(value: unknown): boolean {
  if (!isObject(value) || typeof value.action !== "string") return false;
  switch (value.action) {
    case "open":
      return hasExactKeys(value, ["action", "path"]) && isSafeText(value.path, 2_048);
    case "click":
      return hasExactKeys(value, ["action", "selector"]) && isSafeText(value.selector, 2_048);
    case "fill":
      return hasExactKeys(value, ["action", "selector", "value"])
        && isSafeText(value.selector, 2_048) && value.value === "[REDACTED_FILL]";
    case "press":
      return hasExactKeys(value, ["action", "key"]) && isSafeText(value.key, 128);
    case "expect_text":
      return hasExactKeys(value, ["action", "text"]) && isSafeText(value.text, 2_048);
    case "screenshot":
      return hasExactKeys(value, ["action", "label"]) && isSafeText(value.label, 512);
    default:
      return false;
  }
}

function isCorrectionReproduction(value: unknown, modality: unknown): value is CorrectionReproduction {
  if (!isObject(value) || value.modality !== modality) return false;
  if (modality === "ui") {
    return hasExactKeys(value, ["modality", "steps"])
      && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 12
      && value.steps.every(isUiReproductionStep);
  }
  if (modality === "api") {
    return hasExactKeys(value, ["modality", "request"])
      && isObject(value.request)
      && hasExactKeys(value.request, ["method", "path", "expectedStatus"])
      && value.request.method === "GET"
      && isSafeText(value.request.path, 2_048)
      && isHttpStatus(value.request.expectedStatus);
  }
  if (modality === "data") {
    return hasExactKeys(value, ["modality", "request"])
      && isSafeDataRequestDescriptor(value.request);
  }
  if (modality === "job") {
    return hasExactKeys(value, ["modality", "request"])
      && isObject(value.request)
      && hasExactKeys(value.request, ["trigger", "readback"])
      && isObject(value.request.trigger)
      && hasExactKeys(value.request.trigger, ["method", "path", "expectedStatus"])
      && value.request.trigger.method === "POST"
      && isSafeText(value.request.trigger.path, 2_048)
      && isHttpStatus(value.request.trigger.expectedStatus)
      && isSafeDataRequestDescriptor(value.request.readback);
  }
  return false;
}

function isAcceptanceCorrectionPacket(value: unknown): value is AcceptanceCorrectionPacket {
  if (!isObject(value) || !hasExactKeys(value, [
    "kind", "version", "packetId", "workspaceId", "repo", "prNumber", "headSha", "recordId", "jobId",
    "acceptanceContract", "criterion", "basis", "state", "expected", "observed", "affectedContext", "evidence",
    "scopeBoundary", "impact", "requiredCorrection", "reverification",
  ])) return false;
  if (!isObject(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version"])
    || typeof value.acceptanceContract.id !== "string" || !UUID.test(value.acceptanceContract.id)
    || !isPositiveInteger(value.acceptanceContract.version)
    || !isObject(value.criterion)
    || !hasExactKeys(value.criterion, ["id", "snapshot"])
    || !isSafeText(value.criterion.id, 512)
    || !isSafeText(value.criterion.snapshot, 2_000)
    || !isObject(value.affectedContext)
    || !hasExactKeys(value.affectedContext, ["modality", "environmentKind", "flow", "reproduction"])
    || (value.affectedContext.modality !== "ui" && value.affectedContext.modality !== "api"
      && value.affectedContext.modality !== "data" && value.affectedContext.modality !== "job")
    || (value.affectedContext.environmentKind !== null
      && value.affectedContext.environmentKind !== "isolated_preview")
    || !isSafeText(value.affectedContext.flow, 2_000)
    || !isCorrectionReproduction(value.affectedContext.reproduction, value.affectedContext.modality)
    || !isObject(value.evidence)
    || !Object.keys(value.evidence).every((key) =>
      key === "evidenceRef" || key === "artifactKey" || key === "executionId" || key === "previewBootId")
    || !Object.prototype.hasOwnProperty.call(value.evidence, "evidenceRef")
    || !Object.prototype.hasOwnProperty.call(value.evidence, "previewBootId")
    || !isSafeText(value.evidence.evidenceRef, 2_000)
    || !isOptionalSafeText(value.evidence, "artifactKey", 2_000)
    || !isOptionalSafeText(value.evidence, "executionId", 512)
    || !isSafeText(value.evidence.previewBootId, 512)) return false;
  return value.kind === "review_job_correction_packet"
    && value.version === 1
    && typeof value.packetId === "string" && CORRECTION_PACKET_ID.test(value.packetId)
    && typeof value.workspaceId === "string" && UUID.test(value.workspaceId)
    && isSafeRepo(value.repo)
    && isPositiveInteger(value.prNumber)
    && typeof value.headSha === "string" && SHA1.test(value.headSha)
    && typeof value.recordId === "string" && UUID.test(value.recordId)
    && typeof value.jobId === "string" && UUID.test(value.jobId)
    && value.basis === "acceptance_contract"
    && (value.state === "failed" || value.state === "not_proven")
    && isSafeText(value.expected, 2_000)
    && value.expected === value.criterion.snapshot
    && isSafeText(value.observed, 2_000)
    && isSafeText(value.scopeBoundary, 2_000)
    && isSafeText(value.impact, 2_000)
    && isSafeText(value.requiredCorrection, 2_000)
    && isSafeText(value.reverification, 2_000);
}

export function isCorrectionPacketsEnvelope(value: unknown): value is AcceptanceCorrectionPacketsEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "review_job_unavailable"
      || value.reason === "confirmed_contract_unavailable"
      || value.reason === "no_correction_packets"
      || value.reason === "invalid_packet_custody"
    );
  }
  if (value.kind !== "current" || !hasExactKeys(value, [
    "kind", "binding", "packetIds", "packetSetSha256", "correctionPacketPayloadSetSha256", "packets",
  ]) || !isObject(value.binding) || !hasExactKeys(value.binding, [
    "workspaceId", "recordId", "reviewJobId", "repo", "prNumber", "headSha", "headCycleId",
    "authorityGeneration", "acceptanceContract",
  ])) return false;
  if (!(typeof value.binding.workspaceId === "string" && UUID.test(value.binding.workspaceId)
    && typeof value.binding.recordId === "string" && UUID.test(value.binding.recordId)
    && typeof value.binding.reviewJobId === "string" && UUID.test(value.binding.reviewJobId)
    && isSafeRepo(value.binding.repo)
    && isPositiveInteger(value.binding.prNumber)
    && typeof value.binding.headSha === "string" && SHA1.test(value.binding.headSha)
    && typeof value.binding.headCycleId === "string" && UUID.test(value.binding.headCycleId)
    && value.binding.headCycleId === value.binding.reviewJobId
    && isNonNegativeInteger(value.binding.authorityGeneration)
    && isObject(value.binding.acceptanceContract)
    && hasExactKeys(value.binding.acceptanceContract, ["id", "version", "sha256"])
    && typeof value.binding.acceptanceContract.id === "string" && UUID.test(value.binding.acceptanceContract.id)
    && isPositiveInteger(value.binding.acceptanceContract.version)
    && typeof value.binding.acceptanceContract.sha256 === "string"
    && SHA256.test(value.binding.acceptanceContract.sha256)
    && Array.isArray(value.packetIds)
    && value.packetIds.length > 0 && value.packetIds.length <= 100
    && value.packetIds.every((packetId) => typeof packetId === "string" && CORRECTION_PACKET_ID.test(packetId))
    && typeof value.packetSetSha256 === "string" && SHA256.test(value.packetSetSha256)
    && typeof value.correctionPacketPayloadSetSha256 === "string"
    && SHA256.test(value.correctionPacketPayloadSetSha256)
    && Array.isArray(value.packets)
    && value.packets.length > 0
    && value.packetIds.length === value.packets.length
    && new Set(value.packetIds).size === value.packetIds.length)) return false;
  const packets = value.packets;
  const packetIds = value.packetIds;
  const binding = value.binding;
  if (!isObject(binding.acceptanceContract)) return false;
  const acceptanceContract = binding.acceptanceContract;
  return packetIds.every((packetId, index) => index === 0 || packetIds[index - 1]! < packetId)
    && packets.every((packet, index) => isAcceptanceCorrectionPacket(packet)
    && packet.packetId === packetIds[index]
    && packet.workspaceId === binding.workspaceId
    && packet.recordId === binding.recordId
    && packet.jobId === binding.reviewJobId
    && packet.repo === binding.repo
    && packet.prNumber === binding.prNumber
    && packet.headSha === binding.headSha
    && packet.acceptanceContract.id === acceptanceContract.id
    && packet.acceptanceContract.version === acceptanceContract.version);
}

function isAcceptancePrDecision(value: unknown): value is AcceptancePrDecision {
  return value === "approved" || value === "changes_requested"
    || value === "rejected" || value === "approved_with_exception";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isGithubReviewUrl(value: unknown, repo: unknown, prNumber: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) return false;
  if (!isSafeRepo(repo) || !isPositiveInteger(prNumber)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      && url.port === "" && url.username === "" && url.password === ""
      && url.search === ""
      && url.pathname === `/${repo}/pull/${prNumber}`
      && /^#pullrequestreview-[1-9][0-9]*$/u.test(url.hash);
  } catch {
    return false;
  }
}

function isDecisionRationale(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0
    && value.length <= 4_000 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && !SECRET_LIKE.test(value));
}

export function isFinalDecisionEnvelope(value: unknown): value is AcceptanceFinalDecisionEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "review_job_unavailable"
      || value.reason === "confirmed_contract_unavailable"
      || value.reason === "posted_attestation_unavailable"
      || value.reason === "invalid_review_custody"
      || value.reason === "invalid_decision_custody"
    );
  }
  if (value.kind !== "current" || !hasExactKeys(value, ["kind", "binding", "decision"])
    || !isObject(value.binding) || !hasExactKeys(value.binding, [
      "bindingId", "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
      "authorityGeneration", "reviewJobId", "reviewVerdict", "postedReviewUrl",
      "postedAttestationEventId", "acceptanceContract",
    ])) return false;
  const binding = value.binding;
  if (!(typeof binding.bindingId === "string" && UUID.test(binding.bindingId)
    && typeof binding.workspaceId === "string" && UUID.test(binding.workspaceId)
    && typeof binding.recordId === "string" && UUID.test(binding.recordId)
    && isSafeRepo(binding.repo)
    && isPositiveInteger(binding.prNumber)
    && typeof binding.headSha === "string" && SHA1.test(binding.headSha)
    && typeof binding.headCycleId === "string" && UUID.test(binding.headCycleId)
    && isNonNegativeInteger(binding.authorityGeneration)
    && typeof binding.reviewJobId === "string" && UUID.test(binding.reviewJobId)
    && binding.headCycleId === binding.reviewJobId
    && (binding.reviewVerdict === "proven" || binding.reviewVerdict === "failed"
      || binding.reviewVerdict === "not_proven" || binding.reviewVerdict === "not_testable")
    && isGithubReviewUrl(binding.postedReviewUrl, binding.repo, binding.prNumber)
    && typeof binding.postedAttestationEventId === "string"
    && UUID.test(binding.postedAttestationEventId)
    && isObject(binding.acceptanceContract)
    && hasExactKeys(binding.acceptanceContract, ["id", "version", "sha256"])
    && typeof binding.acceptanceContract.id === "string" && UUID.test(binding.acceptanceContract.id)
    && isPositiveInteger(binding.acceptanceContract.version)
    && typeof binding.acceptanceContract.sha256 === "string"
    && SHA256.test(binding.acceptanceContract.sha256))) return false;
  if (value.decision === null) return true;
  if (!isObject(value.decision) || !hasExactKeys(value.decision, [
    "eventId", "eventKey", "decision", "rationale", "decidedBy", "decidedRole", "decidedAt",
  ])) return false;
  const decision = value.decision;
  return typeof decision.eventId === "string" && UUID.test(decision.eventId)
    && decision.eventKey === `acceptance-pr-decision:${binding.reviewJobId}`
    && isAcceptancePrDecision(decision.decision)
    && (decision.decision !== "approved" || binding.reviewVerdict === "proven")
    && isDecisionRationale(decision.rationale)
    && (decision.decision !== "approved_with_exception" || decision.rationale !== null)
    && typeof decision.decidedBy === "string"
    && /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decision.decidedBy)
    && (decision.decidedRole === "owner" || decision.decidedRole === "admin")
    && isIsoTimestamp(decision.decidedAt);
}

export function changeRecordApiPath(workspaceId: string, recordId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-records/${encodeURIComponent(recordId)}`;
}

export function finalDecisionPatchBody(
  bindingId: string,
  decision: AcceptancePrDecision,
  rationale?: string,
): {
  action: "record_pr_decision";
  bindingId: string;
  decision: AcceptancePrDecision;
  rationale?: string;
} {
  return {
    action: "record_pr_decision",
    bindingId,
    decision,
    ...(rationale === undefined ? {} : { rationale: rationale.trim() }),
  };
}

export function formatChangeRecordDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function githubUrl(repo: string, kind: "issues" | "pull", number: number): string {
  return `https://github.com/${repo}/${kind}/${number}`;
}

export function ChangeRecordAnchors({ record }: { record: ChangeRecord }) {
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Change anchors
        </h2>
      </div>
      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[var(--gray-09)]">Repository</dt>
          <dd className="mt-1 font-mono text-[var(--gray-12)]">{record.repo}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">State</dt>
          <dd className="mt-1 capitalize text-[var(--gray-12)]">{record.state}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Issue</dt>
          <dd className="mt-1">
            {record.issueNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "issues", record.issueNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.issueNumber}
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Pull request</dt>
          <dd className="mt-1">
            {record.prNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "pull", record.prNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.prNumber}
              </a>
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Head commits</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {record.headShas.length === 0 ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              record.headShas.map((sha) => (
                <code key={sha} title={sha} className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-[var(--gray-11)]">
                  {sha.slice(0, 12)}
                </code>
              ))
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Merged commit</dt>
          <dd className="mt-1">
            {record.mergedSha ? (
              <code title={record.mergedSha} className="font-mono text-[var(--gray-11)]">
                {record.mergedSha.slice(0, 12)}
              </code>
            ) : (
              <span className="text-[var(--gray-08)]">Not attached</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CorrectionDatum({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--gray-09)]">{label}</dt>
      <dd className={`mt-1 break-words text-[var(--gray-12)]${mono ? " font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

function CorrectionPacketCard({ packet }: { packet: AcceptanceCorrectionPacket }) {
  return (
    <article className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-[var(--gray-09)]">{packet.criterion.id}</p>
          <h3 className="mt-1 text-sm font-medium text-[var(--gray-12)]">
            {packet.criterion.snapshot}
          </h3>
        </div>
        <span className="rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-1 text-xs font-medium text-[var(--gray-11)]">
          {packet.state === "not_proven" ? "Not proven" : "Failed"}
        </span>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <CorrectionDatum label="Expected">{packet.expected}</CorrectionDatum>
        <CorrectionDatum label="Observed">{packet.observed}</CorrectionDatum>
        <CorrectionDatum label="Impact">{packet.impact}</CorrectionDatum>
        <CorrectionDatum label="Required correction">{packet.requiredCorrection}</CorrectionDatum>
        <CorrectionDatum label="Scope boundary">{packet.scopeBoundary}</CorrectionDatum>
        <CorrectionDatum label="Re-verification">{packet.reverification}</CorrectionDatum>
      </dl>

      <div className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Affected context and reproduction
        </h4>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
          <CorrectionDatum label="Modality" mono>{packet.affectedContext.modality}</CorrectionDatum>
          <CorrectionDatum label="Environment" mono>
            {packet.affectedContext.environmentKind ?? "Not recorded"}
          </CorrectionDatum>
          <CorrectionDatum label="Flow" mono>{packet.affectedContext.flow ?? "Not recorded"}</CorrectionDatum>
        </dl>
        {packet.affectedContext.reproduction == null ? (
          <p className="mt-3 text-xs text-[var(--gray-09)]">No bounded reproduction was recorded.</p>
        ) : (
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
            {JSON.stringify(packet.affectedContext.reproduction, null, 2)}
          </pre>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Evidence custody
        </h4>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Evidence reference" mono>{packet.evidence.evidenceRef}</CorrectionDatum>
          <CorrectionDatum label="Artifact key" mono>{packet.evidence.artifactKey ?? "Not recorded"}</CorrectionDatum>
          <CorrectionDatum label="Execution ID" mono>{packet.evidence.executionId ?? "Not recorded"}</CorrectionDatum>
          <CorrectionDatum label="Preview boot ID" mono>{packet.evidence.previewBootId ?? "Not recorded"}</CorrectionDatum>
        </dl>
      </div>

      <details className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
          Packet identity
        </summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Packet ID" mono>{packet.packetId}</CorrectionDatum>
          <CorrectionDatum label="Format" mono>{packet.kind} v{packet.version}</CorrectionDatum>
          <CorrectionDatum label="Workspace ID" mono>{packet.workspaceId}</CorrectionDatum>
          <CorrectionDatum label="Record ID" mono>{packet.recordId}</CorrectionDatum>
          <CorrectionDatum label="Repository / PR" mono>{packet.repo}#{packet.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{packet.headSha}</CorrectionDatum>
          <CorrectionDatum label="Review job ID" mono>{packet.jobId}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {packet.acceptanceContract.id} v{packet.acceptanceContract.version}
          </CorrectionDatum>
          <CorrectionDatum label="Basis" mono>{packet.basis}</CorrectionDatum>
        </dl>
      </details>
    </article>
  );
}

function correctionUnavailableCopy(
  correctionPackets: Exclude<AcceptanceCorrectionPacketsEnvelope, { kind: "current" }>
): { label: string; message: string } {
  if (correctionPackets.kind === "not_found") {
    return {
      label: "Unavailable",
      message: "Correction custody was not found for this Change Record.",
    };
  }
  if (correctionPackets.kind === "not_current") {
    return {
      label: "Unavailable for the current head",
      message: "A stable authoritative current PR head and head cycle could not be read. Historical packet events remain in the lifecycle timeline.",
    };
  }
  switch (correctionPackets.reason) {
    case "no_correction_packets":
      return {
        label: "No current corrections",
        message: "No failed or not-proven correction packet is recorded for the current exact head and head cycle.",
      };
    case "review_job_unavailable":
      return {
        label: "Not ready",
        message: "The current exact-head cycle does not have a matching review job yet.",
      };
    case "confirmed_contract_unavailable":
      return {
        label: "Not ready",
        message: "The required single confirmed Acceptance Contract is unavailable for the current head cycle.",
      };
    case "invalid_packet_custody":
      return {
        label: "Unavailable",
        message: "Stored correction packet custody could not be validated, so no current packet set is presented.",
      };
  }
}

export function CorrectionsSection({
  correctionPackets,
}: {
  correctionPackets: AcceptanceCorrectionPacketsEnvelope;
}) {
  if (correctionPackets.kind !== "current") {
    const state = correctionUnavailableCopy(correctionPackets);
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Corrections</h2>
        <p className="mt-3 text-sm font-medium text-[var(--gray-12)]">{state.label}</p>
        <p className="mt-1 text-xs text-[var(--gray-09)]">{state.message}</p>
      </section>
    );
  }

  const { binding } = correctionPackets;
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
            Corrections ({correctionPackets.packets.length})
          </h2>
          <span className="rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-1 text-xs font-medium text-[var(--gray-11)]">
            Current exact head and cycle
          </span>
        </div>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          Validated immutable packets for the Change Record&apos;s authoritative current PR head and head cycle.
        </p>
      </div>

      <div className="px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <CorrectionDatum label="Repository / PR" mono>{binding.repo}#{binding.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{binding.headSha}</CorrectionDatum>
          <CorrectionDatum label="Head cycle ID" mono>{binding.headCycleId}</CorrectionDatum>
          <CorrectionDatum label="Authority generation" mono>{binding.authorityGeneration}</CorrectionDatum>
          <CorrectionDatum label="Review job ID" mono>{binding.reviewJobId}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {binding.acceptanceContract.id} v{binding.acceptanceContract.version}
          </CorrectionDatum>
        </dl>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
            Set custody identity
          </summary>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <CorrectionDatum label="Workspace ID" mono>{binding.workspaceId}</CorrectionDatum>
            <CorrectionDatum label="Record ID" mono>{binding.recordId}</CorrectionDatum>
            <CorrectionDatum label="Contract SHA-256" mono>{binding.acceptanceContract.sha256}</CorrectionDatum>
            <CorrectionDatum label="Packet set SHA-256" mono>{correctionPackets.packetSetSha256}</CorrectionDatum>
            <CorrectionDatum label="Packet payload set SHA-256" mono>
              {correctionPackets.correctionPacketPayloadSetSha256}
            </CorrectionDatum>
            <CorrectionDatum label="Packet IDs" mono>{correctionPackets.packetIds.join(", ")}</CorrectionDatum>
          </dl>
        </details>

        <div className="mt-5 flex flex-col gap-3">
          {correctionPackets.packets.map((packet) => (
            <CorrectionPacketCard key={packet.packetId} packet={packet} />
          ))}
        </div>
      </div>
    </section>
  );
}

function finalDecisionLabel(decision: AcceptancePrDecision): string {
  switch (decision) {
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "rejected": return "Rejected";
    case "approved_with_exception": return "Approved with exception";
  }
}

export function FinalDecisionPanel({
  finalDecision,
  canRecordFinalDecision,
  onDecide,
  deciding,
  decisionError,
  exceptionRationale,
  onExceptionRationaleChange,
}: {
  finalDecision: AcceptanceFinalDecisionEnvelope;
  canRecordFinalDecision: boolean;
  onDecide: (decision: AcceptancePrDecision, rationale?: string) => void;
  deciding: boolean;
  decisionError: string | null;
  exceptionRationale: string;
  onExceptionRationaleChange: (value: string) => void;
}) {
  if (finalDecision.kind !== "current") {
    const message = finalDecision.kind === "not_current"
      ? "No decision can be recorded because an authoritative current PR head and cycle are unavailable. Historical decision events remain audit-only in the timeline."
      : finalDecision.kind === "not_found"
        ? "This Change Record is unavailable."
        : "The current exact-head review is not ready for a human decision.";
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Final human decision
        </h2>
        <p className="mt-3 text-sm text-[var(--gray-09)]">{message}</p>
      </section>
    );
  }

  const { binding, decision } = finalDecision;
  const proven = binding.reviewVerdict === "proven";
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Final human decision
        </h2>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          This records the human decision. Jace does not merge.
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Repository / PR" mono>{binding.repo}#{binding.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{binding.headSha}</CorrectionDatum>
          <CorrectionDatum label="Head cycle" mono>{binding.headCycleId}</CorrectionDatum>
          <CorrectionDatum label="Review verdict" mono>{binding.reviewVerdict}</CorrectionDatum>
          <CorrectionDatum label="Authority generation" mono>{binding.authorityGeneration}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {binding.acceptanceContract.id} v{binding.acceptanceContract.version}
          </CorrectionDatum>
        </dl>
        <a
          href={binding.postedReviewUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex text-xs text-[var(--blue-11)] hover:underline"
        >
          Open the attested GitHub review
        </a>

        {decision ? (
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-xs">
            <p className="font-medium text-[var(--gray-12)]">
              Recorded current decision: {finalDecisionLabel(decision.decision)}
            </p>
            <p className="mt-2 text-[var(--gray-09)]">
              {decision.decidedRole} · {decision.decidedBy} · {formatChangeRecordDate(decision.decidedAt)}
            </p>
            {decision.rationale ? (
              <p className="mt-2 whitespace-pre-wrap text-[var(--gray-11)]">{decision.rationale}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-[var(--gray-12)]">
              Not recorded for this current exact head
            </p>
            {!canRecordFinalDecision ? (
              <p className="text-xs text-[var(--gray-09)]">
                A workspace owner or admin can record the final decision.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {proven ? (
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => onDecide("approved")}
                      className="rounded bg-[var(--green-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                    >
                      {deciding ? "Recording…" : "Approve PR"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={deciding}
                    onClick={() => onDecide("changes_requested")}
                    className="rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    Request changes
                  </button>
                  <button
                    type="button"
                    disabled={deciding}
                    onClick={() => onDecide("rejected")}
                    className="rounded border border-[var(--gray-06)] px-2.5 py-1.5 text-xs font-medium text-[var(--gray-12)] disabled:opacity-60"
                  >
                    Reject PR
                  </button>
                </div>
                {!proven ? (
                  <div className="rounded border border-[var(--yellow-06)] bg-[var(--yellow-03)] p-3">
                    <label
                      className="block text-xs font-medium text-[var(--gray-12)]"
                      htmlFor={`decision-exception-${binding.reviewJobId}`}
                    >
                      Explicit exception rationale
                    </label>
                    <textarea
                      id={`decision-exception-${binding.reviewJobId}`}
                      value={exceptionRationale}
                      onChange={(event) => onExceptionRationaleChange(event.target.value)}
                      maxLength={4_000}
                      rows={3}
                      className="mt-2 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-01)] p-2 text-xs text-[var(--gray-12)]"
                    />
                    <button
                      type="button"
                      disabled={deciding || !exceptionRationale.trim()}
                      onClick={() => onDecide("approved_with_exception", exceptionRationale)}
                      className="mt-2 rounded border border-[var(--yellow-08)] px-2.5 py-1.5 text-xs font-medium text-[var(--yellow-11)] disabled:opacity-60"
                    >
                      Record approval with exception
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
        {decisionError ? <p className="text-sm text-[var(--red-11)]">{decisionError}</p> : null}
      </div>
    </section>
  );
}

export function LifecycleTimeline({ events }: { events: ChangeRecordEvent[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
        Lifecycle events ({events.length})
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-[var(--gray-09)]">No lifecycle evidence attached yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((event, index) => (
            <li
              key={event.id}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium capitalize text-[var(--gray-12)]">
                    {event.stage}
                  </span>
                  <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-xs text-[var(--gray-09)]">
                    {event.actor}
                  </span>
                  {event.stage === "human_pr_decision" ? (
                    <span className="rounded-sm border border-[var(--gray-06)] px-1.5 py-0.5 text-xs text-[var(--gray-09)]">
                      Audit history only
                    </span>
                  ) : null}
                </div>
                <time dateTime={event.at} title={new Date(event.at).toLocaleString()} className="font-mono text-xs text-[var(--gray-09)]">
                  {formatChangeRecordDate(event.at)}
                </time>
              </div>
              <p className="mt-2 font-mono text-xs text-[var(--gray-09)]">
                {index + 1}. {event.eventKey}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
                  Evidence reference
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 font-mono text-xs text-[var(--gray-11)]">
                  {JSON.stringify(event.payloadRef, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function ChangeRecordView({ workspaceId, recordId }: { workspaceId: string; recordId: string }) {
  const [data, setData] = useState<ChangeRecordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [exceptionRationale, setExceptionRationale] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as Partial<ChangeRecordResponse> & { error?: string };
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        if (!body.record || !Array.isArray(body.events)
          || !isCorrectionPacketsEnvelope(body.correctionPackets)
          || !isFinalDecisionEnvelope(body.finalDecision)
          || typeof body.canRecordFinalDecision !== "boolean") {
          throw new Error("Change record response was incomplete");
        }
        setData(body as ChangeRecordResponse);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Failed to load change record");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [workspaceId, recordId, reloadVersion]);

  async function recordFinalDecision(
    decision: AcceptancePrDecision,
    rationale?: string,
  ) {
    if (!data || data.finalDecision.kind !== "current") {
      setDecisionError("The current decision binding is no longer available");
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(finalDecisionPatchBody(
          data.finalDecision.binding.bindingId,
          decision,
          rationale,
        )),
      });
      const body = (await response.json().catch(() => ({}))) as {
        kind?: string;
        error?: string;
        reason?: string;
      };
      if (!response.ok || (body.kind !== "recorded" && body.kind !== "replayed")) {
        throw new Error(body.error ?? body.reason ?? `HTTP ${response.status}`);
      }
      setExceptionRationale("");
      setReloadVersion((current) => current + 1);
    } catch (caught) {
      setDecisionError(
        caught instanceof Error ? caught.message : "Failed to record final decision",
      );
    } finally {
      setDeciding(false);
    }
  }

  const backHref = `/dashboard/${workspaceId}/work`;
  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <p className="animate-pulse py-8 text-sm text-[var(--gray-09)]">Loading change record...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[900px]">
        <a href={backHref} className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <p className="py-8 text-sm text-[var(--red-11)]">{error ?? "Change record not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]">
          <ArrowLeft size={14} /> Back to Work
        </a>
        <PageHeader
          title="Change Record"
          subtitle={`${data.record.repo} · ${data.record.state}`}
          actions={<CopyId id={data.record.id} label="Record" />}
        />
        <p className="text-xs text-[var(--gray-09)]">
          Created {formatChangeRecordDate(data.record.createdAt)} · Updated {formatChangeRecordDate(data.record.updatedAt)}
        </p>
      </div>
      <ChangeRecordAnchors record={data.record} />
      <CorrectionsSection correctionPackets={data.correctionPackets} />
      <FinalDecisionPanel
        finalDecision={data.finalDecision}
        canRecordFinalDecision={data.canRecordFinalDecision}
        onDecide={recordFinalDecision}
        deciding={deciding}
        decisionError={decisionError}
        exceptionRationale={exceptionRationale}
        onExceptionRationaleChange={setExceptionRationale}
      />
      <LifecycleTimeline events={data.events} />
    </div>
  );
}
