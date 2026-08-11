import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
  dependencyWatchObservations,
  dependencyWatches,
  repositories,
} from "../schema/index.js";
import type { ChangeRecordEventRow } from "../schema/change_records.js";
import {
  acceptanceContractId,
  changeRecordEventId,
  changeRecordId,
  type AcceptanceRecordDraft,
} from "./change_records.js";
import {
  type DependencyUpgradeCandidate,
} from "./dependency_upgrade_contracts.js";

const ACTOR = "server:dependency-observation-proposal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const FILE_SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const UNSAFE_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/i;
const BIDI_OR_CONTROL = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_SELECTED_FILE_HASHES = 16;

export const dependencyObservationDraftErrorCodes = [
  "not_found", "unsupported_manager", "unsafe_custody", "conflict",
] as const;
export type DependencyObservationDraftErrorCode =
  (typeof dependencyObservationDraftErrorCodes)[number];

export class DependencyObservationDraftError extends Error {
  constructor(readonly code: DependencyObservationDraftErrorCode, message: string) {
    super(message);
    this.name = "DependencyObservationDraftError";
  }
}

/** This is intentionally the entire public authority surface. */
export type CreateDraftAcceptanceRecordFromDependencyObservationInput = {
  workspaceId: string;
  watchId: string;
  candidateFingerprint: string;
};

export type DependencyObservationProposalProfile = {
  ecosystem: "node";
  manager: "pnpm";
  profile: "pnpm_lockfile_only_v1";
  capability: "proposal_observation_only";
};

export type DependencyObservationAcceptanceRecordDraft = AcceptanceRecordDraft & {
  event: ChangeRecordEventRow;
  observation: { id: string; key: string };
  profile: DependencyObservationProposalProfile;
  created: boolean;
};

type PnpmObservationProposalCandidate = Omit<
  DependencyUpgradeCandidate,
  | "ecosystem"
  | "package_manager"
  | "package_manager_version"
  | "verification_commands"
  | "manager_commands"
> & {
  ecosystem: "node";
  package_manager: "pnpm";
  package_manager_version: null;
  verification_commands: [string, string];
  manager_commands: { version: string; install: string; update: string };
};

type Custody = {
  watchId: string;
  repositoryId: string;
  repositoryName: string;
  observationId: string;
  observationKey: string;
  baselineSha: string;
  selectedFileHashes: { "package.json": string; "pnpm-lock.yaml": string };
  candidate: PnpmObservationProposalCandidate;
};
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PROFILE: DependencyObservationProposalProfile = {
  ecosystem: "node",
  manager: "pnpm",
  profile: "pnpm_lockfile_only_v1",
  capability: "proposal_observation_only",
};

function exactLocator(input: unknown): input is CreateDraftAcceptanceRecordFromDependencyObservationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 3
    && Object.keys(value).every((key) => key === "workspaceId" || key === "watchId" || key === "candidateFingerprint")
    && UUID.test(value.workspaceId as string)
    && UUID.test(value.watchId as string)
    && SHA256.test(value.candidateFingerprint as string);
}

function safeText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !BIDI_OR_CONTROL.test(value);
}

function safePath(value: unknown): value is string {
  return safeText(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Observation writers may hash a bounded set of selected files. This proposal
 * profile admits only the two files it understands, so unrelated hashes never
 * become Record custody or alter the canonical identity.
 */
function selectedHashes(value: unknown): Custody["selectedFileHashes"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 2 || entries.length > MAX_SELECTED_FILE_HASHES
    || !entries.every(([path, hash]) => safePath(path) && typeof hash === "string" && FILE_SHA256.test(hash))) return null;
  const manifest = (value as Record<string, unknown>)["package.json"];
  const lockfile = (value as Record<string, unknown>)["pnpm-lock.yaml"];
  if (typeof manifest !== "string" || typeof lockfile !== "string"
    || !FILE_SHA256.test(manifest) || !FILE_SHA256.test(lockfile)) return null;
  return { "package.json": manifest, "pnpm-lock.yaml": lockfile };
}

const PNPM_CANDIDATE_KEYS = [
  "package", "ecosystem", "package_manager", "dependency_kind", "specifier",
  "current_version", "target_version", "manifest_path", "lockfile_path",
  "baseline_sha", "fingerprint", "package_manager_version",
  "verification_commands", "manager_commands",
] as const;

function candidateRaw(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === PNPM_CANDIDATE_KEYS.length
    && keys.every((key) => (PNPM_CANDIDATE_KEYS as readonly string[]).includes(key));
}

function candidateWithFingerprint(value: unknown, fingerprint: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).fingerprint === fingerprint;
}

/**
 * Byte-compatible with agentrail/dependencies/pnpm.py:_make_candidate.
 * Python serializes the fingerprint payload with sorted keys and compact JSON;
 * keep this explicit order so a real heartbeat candidate is not mistaken for
 * forged custody.
 */
export function pnpmObservationCandidateFingerprint(
  candidate: Pick<
    DependencyUpgradeCandidate,
    | "baseline_sha"
    | "current_version"
    | "dependency_kind"
    | "lockfile_path"
    | "manifest_path"
    | "package"
    | "specifier"
    | "target_version"
  >,
): string {
  return stableSha256({
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    package_manager: "pnpm",
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  });
}

/** Parse exactly the asdict shape serialized by the live pnpm watch producer. */
export function validatePnpmObservationProposalCandidate(
  value: unknown,
): PnpmObservationProposalCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!candidateRaw(raw) || PNPM_CANDIDATE_KEYS.some((key) => !(key in raw))) return null;
  if (raw.ecosystem !== "node" || raw.package_manager !== "pnpm"
    || raw.package_manager_version !== null) return null;
  if (!safeText(raw.package) || !NPM_PACKAGE.test(raw.package)
    || !safeText(raw.dependency_kind) || !["dependencies", "devDependencies"].includes(raw.dependency_kind)
    || !safeText(raw.specifier) || UNSAFE_SPECIFIER.test(raw.specifier)
    || !safeText(raw.current_version) || !SEMVER.test(raw.current_version)
    || !safeText(raw.target_version) || !SEMVER.test(raw.target_version) || raw.target_version === raw.current_version
    || raw.manifest_path !== "package.json" || raw.lockfile_path !== "pnpm-lock.yaml"
    || typeof raw.baseline_sha !== "string" || !GIT_SHA.test(raw.baseline_sha)
    || typeof raw.fingerprint !== "string" || !SHA256.test(raw.fingerprint)) return null;

  const commands = raw.manager_commands;
  const verification = raw.verification_commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)
    || !Array.isArray(verification)) return null;
  const commandRecord = commands as Record<string, unknown>;
  const expectedUpdate = `pnpm update --lockfile-only --ignore-scripts ${raw.package}@${raw.target_version}`;
  if (Object.keys(commandRecord).length !== 3
    || commandRecord.version !== "pnpm --version"
    || commandRecord.install !== "pnpm install --frozen-lockfile"
    || commandRecord.update !== expectedUpdate
    || verification.length !== 2
    || verification[0] !== "pnpm install --frozen-lockfile"
    || verification[1] !== "pnpm test") return null;

  const candidate: PnpmObservationProposalCandidate = {
    package: raw.package,
    ecosystem: "node",
    package_manager: "pnpm",
    package_manager_version: null,
    dependency_kind: raw.dependency_kind,
    specifier: raw.specifier,
    current_version: raw.current_version,
    target_version: raw.target_version,
    manifest_path: "package.json",
    lockfile_path: "pnpm-lock.yaml",
    baseline_sha: raw.baseline_sha,
    fingerprint: raw.fingerprint,
    verification_commands: [verification[0], verification[1]],
    manager_commands: {
      version: commandRecord.version as string,
      install: commandRecord.install as string,
      update: commandRecord.update as string,
    },
  };
  return pnpmObservationCandidateFingerprint(candidate) === candidate.fingerprint ? candidate : null;
}

function stableSha256(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/** Every field that can distinguish custody participates in the deterministic record key. */
function custodyIdentity(custody: Custody): string {
  return stableSha256({
    kind: "dependency_observation_proposal_custody",
    version: 1,
    profile: PROFILE,
    repository: { id: custody.repositoryId, name: custody.repositoryName },
    watchId: custody.watchId,
    observation: { id: custody.observationId, key: custody.observationKey },
    baselineSha: custody.baselineSha,
    selectedFileHashes: custody.selectedFileHashes,
    candidate: custody.candidate,
  });
}

/**
 * Recompute the immutable proposal identity from persisted source custody.
 * Readers use this instead of trusting the stored digest to be self-authenticating.
 */
export function dependencyObservationProposalCustodyIdentity(input: {
  repositoryId: string;
  repositoryName: string;
  watchId: string;
  observationId: string;
  observationKey: string;
  baselineSha: string;
  selectedFileHashes: { "package.json": string; "pnpm-lock.yaml": string };
  candidate: unknown;
}): string | null {
  const candidate = validatePnpmObservationProposalCandidate(input.candidate);
  const hashes = selectedHashes(input.selectedFileHashes);
  if (!candidate || !hashes || Object.keys(input.selectedFileHashes).length !== 2
    || !UUID.test(input.repositoryId) || !safeText(input.repositoryName)
    || !UUID.test(input.watchId) || !UUID.test(input.observationId)
    || !safeText(input.observationKey) || !GIT_SHA.test(input.baselineSha)
    || candidate.baseline_sha !== input.baselineSha) return null;
  return custodyIdentity({
    repositoryId: input.repositoryId,
    repositoryName: input.repositoryName,
    watchId: input.watchId,
    observationId: input.observationId,
    observationKey: input.observationKey,
    baselineSha: input.baselineSha,
    selectedFileHashes: hashes,
    candidate,
  });
}

function sourceReferences(custody: Custody, proposalCustodyIdentity: string): Record<string, unknown>[] {
  return [{
    kind: "dependency_watch_observation_proposal", version: 1,
    repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
    watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
    candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity,
    candidate: custody.candidate, baselineSha: custody.baselineSha,
    manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml", selectedFileHashes: custody.selectedFileHashes,
    profile: PROFILE, repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
  }];
}

function contract(custody: Custody, proposalCustodyIdentity: string): Record<string, unknown> {
  const unresolved = [
    "release",
    "usage",
    "runtime",
    "target-lock",
    "security",
    "human-confirmation",
    "approval",
    "context-pack",
    "builder-handoff",
  ];
  return {
    originalRequest: `Assess observed dependency candidate ${custody.candidate.package} from ${custody.candidate.current_version} to ${custody.candidate.target_version}.`,
    normalizedRequirements: [
      "This is a draft-only dependency proposal with server-derived observation custody.",
      "No confirmation, approval, Context Pack, route, issue, pull request, queue, execution, or delivery is authorized.",
    ],
    acceptanceCriteria: [{
      id: "DEP-PROPOSAL-CUSTODY",
      text: "Watch-observation proposal custody remains exact and grants no delivery authority.",
      userVisible: false,
    }],
    nonGoals: ["No dependency change or operational handoff."],
    risks: unresolved.map((kind) => `${kind} evidence is unresolved and blocking.`),
    environment: {
      kind: "dependency_watch_observation_proposal", admission: "draft_only", profile: PROFILE,
      repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
      watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
      candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity, candidate: custody.candidate,
      baselineSha: custody.baselineSha, manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml",
      selectedFileHashes: custody.selectedFileHashes,
      repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
    },
    stops: unresolved.map((kind) => `${kind} evidence remains unresolved.`),
    unresolvedQuestions: unresolved.map((kind) => ({ id: `dependency-${kind}-evidence`, text: `${kind} evidence has not been admitted.` })),
  };
}

function payload(custody: Custody, recordId: string, contractId: string, proposalCustodyIdentity: string): Record<string, unknown> {
  return {
    kind: "dependency_observation_proposal_draft", version: 1, recordId,
    acceptanceContractId: contractId, acceptanceContractVersion: 1,
    repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
    watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
    candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity, candidate: custody.candidate,
    profile: PROFILE, baselineSha: custody.baselineSha, manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml",
    selectedFileHashes: custody.selectedFileHashes, evidenceAdmission: "unresolved", authority: "draft_only",
    repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
  };
}

async function readCustody(
  tx: DbTransaction,
  input: CreateDraftAcceptanceRecordFromDependencyObservationInput,
): Promise<Custody> {
  const watch = (await tx.select({
    id: dependencyWatches.id,
    repositoryId: dependencyWatches.repositoryId,
    repositoryName: repositories.name,
    manifestPath: dependencyWatches.manifestPath,
    lockfilePath: dependencyWatches.lockfilePath,
  })
    .from(dependencyWatches)
    .innerJoin(repositories, eq(repositories.id, dependencyWatches.repositoryId))
    .where(and(
      eq(dependencyWatches.workspaceId, input.workspaceId),
      eq(dependencyWatches.id, input.watchId),
      eq(repositories.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!watch) throw new DependencyObservationDraftError("not_found", "Dependency watch was not found in this workspace");
  const exactRootPaths = watch.manifestPath === "package.json"
    && watch.lockfilePath === "pnpm-lock.yaml";
  const autoRootPaths = watch.manifestPath === "auto" && watch.lockfilePath === "auto";
  if (!exactRootPaths && !autoRootPaths) {
    throw new DependencyObservationDraftError(
      "unsafe_custody",
      "Dependency watch paths do not match the root pnpm proposal custody profile",
    );
  }

  // A newer failed, unchanged, or unsupported observation revokes older candidate custody.
  const observation = (await tx.select().from(dependencyWatchObservations).where(and(
    eq(dependencyWatchObservations.workspaceId, input.workspaceId),
    eq(dependencyWatchObservations.watchId, watch.id),
    eq(dependencyWatchObservations.repositoryId, watch.repositoryId),
  )).orderBy(desc(dependencyWatchObservations.observedAt), desc(dependencyWatchObservations.createdAt), desc(dependencyWatchObservations.id)).limit(1))[0];
  if (!observation) throw new DependencyObservationDraftError("not_found", "Dependency watch has no current observation");
  if (!safeText(observation.observationKey, 512)) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency observation key is not bounded custody");
  }

  const raw = (Array.isArray(observation.candidates) ? observation.candidates : []).find(
    (value): value is Record<string, unknown> =>
      candidateWithFingerprint(value, input.candidateFingerprint),
  );
  if (!raw) throw new DependencyObservationDraftError("not_found", "Dependency candidate is not present in the current observation");
  if (raw.ecosystem !== "node" || raw.package_manager !== "pnpm") {
    throw new DependencyObservationDraftError("unsupported_manager", "Dependency manager is not supported by the proposal custody profile");
  }
  const candidate = validatePnpmObservationProposalCandidate(raw);
  const hashes = selectedHashes(observation.selectedFileHashes);
  if (observation.status !== "candidates" || !candidate
    || observation.baselineSha !== candidate.baseline_sha || !GIT_SHA.test(observation.baselineSha ?? "")
    || !hashes) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency observation lacks bounded pnpm proposal custody");
  }
  return {
    watchId: watch.id,
    repositoryId: watch.repositoryId,
    repositoryName: watch.repositoryName,
    observationId: observation.id,
    observationKey: observation.observationKey,
    baselineSha: observation.baselineSha,
    selectedFileHashes: hashes,
    candidate,
  };
}

/** Atomically create/replay one draft-only Record, v1 Contract, and immutable provenance event. */
export async function createDraftAcceptanceRecordFromDependencyObservation(
  input: CreateDraftAcceptanceRecordFromDependencyObservationInput,
): Promise<DependencyObservationAcceptanceRecordDraft> {
  if (!exactLocator(input)) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency proposal locator must contain exactly workspaceId, watchId, and candidateFingerprint");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dependency-proposal:${input.workspaceId}:${input.watchId}:${input.candidateFingerprint}`}))`);
    const custody = await readCustody(tx, input);
    const proposalCustodyIdentity = custodyIdentity(custody);
    const workKey = `dependency-observation-proposal:${proposalCustodyIdentity}`;
    const recordId = changeRecordId({ workspaceId: input.workspaceId, repo: custody.repositoryName, workKey });
    const contractId = acceptanceContractId({ recordId, version: 1 });
    const eventKey = `dependency-observation-proposal:draft:${proposalCustodyIdentity}`;
    const sources = sourceReferences(custody, proposalCustodyIdentity);
    const draftContract = contract(custody, proposalCustodyIdentity);
    const provenance = payload(custody, recordId, contractId, proposalCustodyIdentity);
    const observation = { id: custody.observationId, key: custody.observationKey };
    const existing = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId), eq(changeRecords.id, recordId),
    )).limit(1))[0];

    if (existing) {
      const storedContract = (await tx.select().from(acceptanceContracts).where(and(
        eq(acceptanceContracts.recordId, recordId), eq(acceptanceContracts.version, 1),
      )).limit(1))[0];
      const event = (await tx.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, recordId), eq(changeRecordEvents.eventKey, eventKey),
      )).limit(1))[0];
      if (existing.repo !== custody.repositoryName || existing.workKey !== workKey
        || existing.originChannel !== "dependency_watch" || !isDeepStrictEqual(existing.sourceReferences, sources)
        || !storedContract || storedContract.id !== contractId || storedContract.status !== "draft"
        || storedContract.createdBy !== ACTOR || !isDeepStrictEqual(storedContract.contract, draftContract)
        || !event || event.id !== changeRecordEventId({ recordId, eventKey })
        || event.stage !== "dependency_observation_proposal" || event.actor !== ACTOR
        || !isDeepStrictEqual(event.payloadRef, provenance)) {
        throw new DependencyObservationDraftError("conflict", "Dependency proposal custody conflicts with its immutable record");
      }
      return { record: existing, contract: storedContract, event, observation, profile: PROFILE, created: false };
    }

    const [record] = await tx.insert(changeRecords).values({
      id: recordId, workspaceId: input.workspaceId, repo: custody.repositoryName,
      workKey, originChannel: "dependency_watch", sourceReferences: sources,
    }).returning();
    const [createdContract] = await tx.insert(acceptanceContracts).values({
      id: contractId, recordId, version: 1, status: "draft", contract: draftContract, createdBy: ACTOR,
    }).returning();
    const [event] = await tx.insert(changeRecordEvents).values({
      id: changeRecordEventId({ recordId, eventKey }), recordId, eventKey,
      stage: "dependency_observation_proposal", actor: ACTOR, payloadRef: provenance,
    }).returning();
    if (!record || !createdContract || !event) throw new Error("Dependency proposal custody insert returned no row");
    return { record, contract: createdContract, event, observation, profile: PROFILE, created: true };
  });
}
