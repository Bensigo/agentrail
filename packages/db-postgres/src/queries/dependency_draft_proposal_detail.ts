import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import {
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { acceptanceContractId, changeRecordEventId, changeRecordId } from "./change_records.js";
import {
  dependencyObservationProposalCustodyIdentity,
  resolveDependencyObservationProposalCandidate,
  type DependencyObservationProposalCandidate,
  type DependencyObservationProposalProfile,
  type DependencyObservationSelectedFileHashes,
} from "./dependency_observation_acceptance_records.js";

const ACTOR = "server:dependency-observation-proposal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/i;
const FILE_SHA256 = /^[a-f0-9]{64}$/i;
const BASE_UNRESOLVED = [
  "release", "usage", "runtime", "target-lock", "security", "human-confirmation",
  "approval", "context-pack", "builder-handoff",
] as const;

type Source = {
  repositoryId: string;
  repositoryName: string;
  watchId: string;
  observationId: string;
  observationKey: string;
  candidateFingerprint: string;
  proposalCustodyIdentity: string;
  candidate: DependencyObservationProposalCandidate;
  baselineSha: string;
  manifestPath: "package.json";
  lockfilePath: "pnpm-lock.yaml" | "package-lock.json";
  selectedFileHashes: DependencyObservationSelectedFileHashes;
  profile: DependencyObservationProposalProfile;
};

export type DependencyDraftProposalDetail = {
  kind: "draft";
  record: { id: string; repo: string; contractId: string; contractVersion: 1 };
  proposal: {
    custodyIdentity: string;
    watch: { id: string; observationId: string; observationKey: string };
    candidate: {
      package: string;
      currentVersion: string;
      targetVersion: string;
      dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
    };
    files: {
      manifest: { path: "package.json"; sha256: string };
      lockfile: { path: "pnpm-lock.yaml" | "package-lock.json"; sha256: string };
    };
    profile: DependencyObservationProposalProfile;
    repositorySourceVerification: "watch_observation_only";
    independentSourceProof: "not_proven";
    evidenceAdmission: "unresolved";
    laterEvidence: {
      confirmation: "not_recorded";
      contextPack: "not_recorded";
      builderHandoff: "not_recorded";
      delivery: "not_recorded";
      result: "not_recorded";
    };
  };
};

export type ReadDependencyDraftProposalDetailResult =
  | DependencyDraftProposalDetail
  | { kind: "not_found" }
  | { kind: "not_draft_proposal" }
  | { kind: "invalid_custody" };

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function safeText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function source(value: unknown): Source | null {
  if (!object(value) || !exactKeys(value, [
    "kind", "version", "repositoryId", "repositoryName", "watchId", "observationId", "observationKey",
    "candidateFingerprint", "proposalCustodyIdentity", "candidate", "baselineSha", "manifestPath", "lockfilePath",
    "selectedFileHashes", "profile", "repositorySourceVerification", "independentSourceProof",
  ]) || value.kind !== "dependency_watch_observation_proposal" || value.version !== 1
    || typeof value.repositoryId !== "string" || !UUID.test(value.repositoryId)
    || !safeText(value.repositoryName) || typeof value.watchId !== "string" || !UUID.test(value.watchId)
    || typeof value.observationId !== "string" || !UUID.test(value.observationId) || !safeText(value.observationKey)
    || typeof value.candidateFingerprint !== "string" || !SHA256.test(value.candidateFingerprint)
    || typeof value.proposalCustodyIdentity !== "string" || !SHA256.test(value.proposalCustodyIdentity)
    || typeof value.baselineSha !== "string" || !SHA1.test(value.baselineSha)
    || !object(value.selectedFileHashes)
    || value.repositorySourceVerification !== "watch_observation_only" || value.independentSourceProof !== "not_proven") return null;
  const resolved = resolveDependencyObservationProposalCandidate(value.candidate);
  if (!resolved || resolved.candidate.fingerprint !== value.candidateFingerprint
    || resolved.candidate.baseline_sha !== value.baselineSha
    || value.manifestPath !== resolved.manifestPath || value.lockfilePath !== resolved.lockfilePath
    || !isDeepStrictEqual(value.profile, resolved.profile)
    || !exactKeys(value.selectedFileHashes, [resolved.manifestPath, resolved.lockfilePath])) return null;
  const manifestHash = value.selectedFileHashes[resolved.manifestPath];
  const lockfileHash = value.selectedFileHashes[resolved.lockfilePath];
  if (typeof manifestHash !== "string" || !FILE_SHA256.test(manifestHash)
    || typeof lockfileHash !== "string" || !FILE_SHA256.test(lockfileHash)) return null;
  const selectedFileHashes: DependencyObservationSelectedFileHashes = resolved.lockfilePath === "pnpm-lock.yaml"
    ? {
        "package.json": manifestHash,
        "pnpm-lock.yaml": lockfileHash,
      }
    : {
        "package.json": manifestHash,
        "package-lock.json": lockfileHash,
      };
  const proposalCustodyIdentity = dependencyObservationProposalCustodyIdentity({
    repositoryId: value.repositoryId,
    repositoryName: value.repositoryName,
    watchId: value.watchId,
    observationId: value.observationId,
    observationKey: value.observationKey,
    baselineSha: value.baselineSha,
    selectedFileHashes,
    candidate: resolved.candidate,
  });
  if (proposalCustodyIdentity !== value.proposalCustodyIdentity) return null;
  return {
    repositoryId: value.repositoryId, repositoryName: value.repositoryName, watchId: value.watchId,
    observationId: value.observationId, observationKey: value.observationKey,
    candidateFingerprint: value.candidateFingerprint, proposalCustodyIdentity: value.proposalCustodyIdentity,
    candidate: resolved.candidate, baselineSha: value.baselineSha,
    manifestPath: resolved.manifestPath, lockfilePath: resolved.lockfilePath,
    selectedFileHashes, profile: resolved.profile,
  };
}

function sameSourceFields(value: Record<string, unknown>, parsed: Source): boolean {
  return value.repositoryId === parsed.repositoryId && value.repositoryName === parsed.repositoryName
    && value.watchId === parsed.watchId && value.observationId === parsed.observationId
    && value.observationKey === parsed.observationKey && value.candidateFingerprint === parsed.candidateFingerprint
    && value.proposalCustodyIdentity === parsed.proposalCustodyIdentity && value.baselineSha === parsed.baselineSha
    && value.manifestPath === parsed.manifestPath && value.lockfilePath === parsed.lockfilePath
    && isDeepStrictEqual(value.candidate, parsed.candidate)
    && isDeepStrictEqual(value.selectedFileHashes, parsed.selectedFileHashes)
    && isDeepStrictEqual(value.profile, parsed.profile)
    && value.repositorySourceVerification === "watch_observation_only"
    && value.independentSourceProof === "not_proven";
}

function unresolvedFor(parsed: Source): readonly string[] {
  return parsed.profile.manager === "npm"
    ? [...BASE_UNRESOLVED, "delivery", "pull-request", "merge"]
    : BASE_UNRESOLVED;
}

function lockfileSha(parsed: Source): string {
  return parsed.lockfilePath === "pnpm-lock.yaml"
    ? (parsed.selectedFileHashes as { "pnpm-lock.yaml": string })["pnpm-lock.yaml"]
    : (parsed.selectedFileHashes as { "package-lock.json": string })["package-lock.json"];
}

function exactContract(value: unknown, parsed: Source): boolean {
  if (!object(value) || !exactKeys(value, [
    "originalRequest", "normalizedRequirements", "acceptanceCriteria", "nonGoals", "risks", "environment", "stops", "unresolvedQuestions",
  ])) return false;
  const environment = value.environment;
  if (!object(environment) || !exactKeys(environment, [
    "kind", "admission", "profile", "repositoryId", "repositoryName", "watchId", "observationId", "observationKey",
    "candidateFingerprint", "proposalCustodyIdentity", "candidate", "baselineSha", "manifestPath", "lockfilePath",
    "selectedFileHashes", "repositorySourceVerification", "independentSourceProof",
  ]) || environment.kind !== "dependency_watch_observation_proposal" || environment.admission !== "draft_only"
    || !sameSourceFields(environment, parsed)) return false;
  const expectedRequest = `Assess observed dependency candidate ${parsed.candidate.package} from ${parsed.candidate.current_version} to ${parsed.candidate.target_version}.`;
  const unresolved = unresolvedFor(parsed);
  return value.originalRequest === expectedRequest
    && isDeepStrictEqual(value.normalizedRequirements, [
      "This is a draft-only dependency proposal with server-derived observation custody.",
      "No confirmation, approval, Context Pack, route, issue, pull request, queue, execution, or delivery is authorized.",
    ])
    && isDeepStrictEqual(value.acceptanceCriteria, [{
      id: "DEP-PROPOSAL-CUSTODY", text: "Watch-observation proposal custody remains exact and grants no delivery authority.", userVisible: false,
    }])
    && isDeepStrictEqual(value.nonGoals, ["No dependency change or operational handoff."])
    && isDeepStrictEqual(value.risks, unresolved.map((kind) => `${kind} evidence is unresolved and blocking.`))
    && isDeepStrictEqual(value.stops, unresolved.map((kind) => `${kind} evidence remains unresolved.`))
    && isDeepStrictEqual(value.unresolvedQuestions, unresolved.map((kind) => ({
      id: `dependency-${kind}-evidence`, text: `${kind} evidence has not been admitted.`,
    })));
}

function exactEventPayload(value: unknown, parsed: Source, recordId: string, contractId: string): boolean {
  if (!object(value) || !exactKeys(value, [
    "kind", "version", "recordId", "acceptanceContractId", "acceptanceContractVersion", "repositoryId", "repositoryName",
    "watchId", "observationId", "observationKey", "candidateFingerprint", "proposalCustodyIdentity", "candidate", "profile",
    "baselineSha", "manifestPath", "lockfilePath", "selectedFileHashes", "evidenceAdmission", "authority",
    "repositorySourceVerification", "independentSourceProof",
  ])) return false;
  return value.kind === "dependency_observation_proposal_draft" && value.version === 1
    && value.recordId === recordId && value.acceptanceContractId === contractId && value.acceptanceContractVersion === 1
    && sameSourceFields(value, parsed) && value.evidenceAdmission === "unresolved" && value.authority === "draft_only";
}

/**
 * A purpose-built, read-only projection for the R10 draft proposal producer.
 * It deliberately refuses rather than guessing if the Record, one draft
 * Contract, one proposal event, and one source reference do not agree exactly.
 */
export async function readDependencyDraftProposalDetail(input: {
  workspaceId: string;
  recordId: string;
}): Promise<ReadDependencyDraftProposalDetailResult> {
  if (!UUID.test(input.workspaceId) || !UUID.test(input.recordId)) return { kind: "not_found" };
  const record = (await db.select().from(changeRecords).where(and(
    eq(changeRecords.workspaceId, input.workspaceId), eq(changeRecords.id, input.recordId),
  )).limit(1))[0];
  if (!record) return { kind: "not_found" };
  if (record.originChannel !== "dependency_watch" || record.sourceReferences.length !== 1 || !record.workKey) {
    return { kind: "not_draft_proposal" };
  }
  const parsed = source(record.sourceReferences[0]);
  if (!parsed || record.repo !== parsed.repositoryName
    || record.workKey !== `dependency-observation-proposal:${parsed.proposalCustodyIdentity}`
    || record.id !== changeRecordId({ workspaceId: input.workspaceId, repo: record.repo, workKey: record.workKey })) {
    return { kind: "invalid_custody" };
  }
  const [contracts, events] = await Promise.all([
    db.select().from(acceptanceContracts).where(eq(acceptanceContracts.recordId, record.id)),
    db.select().from(changeRecordEvents).where(eq(changeRecordEvents.recordId, record.id)),
  ]);
  if (contracts.length !== 1 || events.length !== 1) return { kind: "invalid_custody" };
  const contract = contracts[0]!;
  const event = events[0]!;
  const expectedEventKey = `dependency-observation-proposal:draft:${parsed.proposalCustodyIdentity}`;
  if (contract.id !== acceptanceContractId({ recordId: record.id, version: 1 })
    || contract.version !== 1 || contract.status !== "draft" || contract.createdBy !== ACTOR
    || contract.confirmedBy !== null || contract.confirmedAt !== null
    || !exactContract(contract.contract, parsed)
    || event.eventKey !== expectedEventKey || event.id !== changeRecordEventId({ recordId: record.id, eventKey: expectedEventKey })
    || event.stage !== "dependency_observation_proposal" || event.actor !== ACTOR
    || !exactEventPayload(event.payloadRef, parsed, record.id, contract.id)) return { kind: "invalid_custody" };
  return {
    kind: "draft",
    record: { id: record.id, repo: record.repo, contractId: contract.id, contractVersion: 1 },
    proposal: {
      custodyIdentity: parsed.proposalCustodyIdentity,
      watch: { id: parsed.watchId, observationId: parsed.observationId, observationKey: parsed.observationKey },
      candidate: {
        package: parsed.candidate.package, currentVersion: parsed.candidate.current_version,
        targetVersion: parsed.candidate.target_version,
        dependencyKind: parsed.candidate.dependency_kind as
          | "dependencies"
          | "devDependencies"
          | "optionalDependencies"
          | "peerDependencies",
      },
      files: {
        manifest: { path: "package.json", sha256: parsed.selectedFileHashes["package.json"] },
        lockfile: {
          path: parsed.lockfilePath,
          sha256: lockfileSha(parsed),
        },
      },
      profile: parsed.profile,
      repositorySourceVerification: "watch_observation_only",
      independentSourceProof: "not_proven",
      evidenceAdmission: "unresolved",
      laterEvidence: {
        confirmation: "not_recorded", contextPack: "not_recorded", builderHandoff: "not_recorded",
        delivery: "not_recorded", result: "not_recorded",
      },
    },
  };
}
