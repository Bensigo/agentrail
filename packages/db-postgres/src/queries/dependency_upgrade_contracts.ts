import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db.js";
import {
  dependencyWatchObservations,
  dependencyWatches,
  dependencyUpgradeContractEvents,
  dependencyUpgradeContracts,
} from "../schema/index.js";
import type {
  DependencyUpgradeContractEvent,
  DependencyUpgradeContractRow,
  DependencyUpgradeContractState,
} from "../schema/dependency_upgrade_contracts.js";

export type DependencyUpgradeCandidate = {
  package: string;
  ecosystem?: string;
  package_manager?: string;
  package_manager_version?: string;
  dependency_kind: string;
  specifier: string;
  current_version: string;
  target_version: string;
  manifest_path: string;
  lockfile_path: string;
  baseline_sha: string;
  fingerprint: string;
  verification_commands?: string[];
  manager_commands?: { version?: string; install?: string; update?: string };
};

export type DependencyCandidateObservation = {
  observationId: string;
  watchId: string;
  repositoryId: string;
  observationKey: string;
  baselineSha: string | null;
  candidate: DependencyUpgradeCandidate;
};

export type ContractActor = {
  actorType: string;
  actorId: string;
};

const CANDIDATE_KEYS = [
  "package",
  "dependency_kind",
  "specifier",
  "current_version",
  "target_version",
  "manifest_path",
  "lockfile_path",
  "baseline_sha",
  "fingerprint",
] as const;

function candidateFromUnknown(value: unknown): DependencyUpgradeCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (CANDIDATE_KEYS.some((key) => typeof record[key] !== "string" || !record[key])) {
    return null;
  }
  return {
    package: record.package as string,
    ecosystem: typeof record.ecosystem === "string" ? record.ecosystem : undefined,
    package_manager: typeof record.package_manager === "string" ? record.package_manager : undefined,
    package_manager_version: typeof record.package_manager_version === "string" ? record.package_manager_version : undefined,
    dependency_kind: record.dependency_kind as string,
    specifier: record.specifier as string,
    current_version: record.current_version as string,
    target_version: record.target_version as string,
    manifest_path: record.manifest_path as string,
    lockfile_path: record.lockfile_path as string,
    baseline_sha: record.baseline_sha as string,
    fingerprint: record.fingerprint as string,
    verification_commands: Array.isArray(record.verification_commands)
      ? record.verification_commands.filter((value): value is string => typeof value === "string")
      : undefined,
    manager_commands: record.manager_commands && typeof record.manager_commands === "object"
      ? record.manager_commands as DependencyUpgradeCandidate["manager_commands"]
      : undefined,
  };
}

function sameCandidate(a: DependencyUpgradeCandidate, b: DependencyUpgradeCandidate): boolean {
  return CANDIDATE_KEYS.every((key) => a[key] === b[key]) &&
    (a.ecosystem ?? "") === (b.ecosystem ?? "") &&
    (a.package_manager ?? "") === (b.package_manager ?? "") &&
    (a.package_manager_version ?? "") === (b.package_manager_version ?? "");
}

export function candidateFingerprint(candidate: DependencyUpgradeCandidate): string {
  const payloadObject: Record<string, unknown> = {
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  };
  if (candidate.package_manager) payloadObject.package_manager = candidate.package_manager;
  const payload = JSON.stringify(payloadObject);
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** Read the exact candidate from the watch's append-only observation ledger. */
export async function findDependencyCandidate(input: {
  workspaceId: string;
  watchId: string;
  fingerprint: string;
}): Promise<DependencyCandidateObservation | null> {
  const [watch] = await db
    .select({ id: dependencyWatches.id, repositoryId: dependencyWatches.repositoryId })
    .from(dependencyWatches)
    .where(and(eq(dependencyWatches.workspaceId, input.workspaceId), eq(dependencyWatches.id, input.watchId)))
    .limit(1);
  if (!watch) return null;

  const observations = await db
    .select()
    .from(dependencyWatchObservations)
    .where(
      and(
        eq(dependencyWatchObservations.workspaceId, input.workspaceId),
        eq(dependencyWatchObservations.watchId, input.watchId),
        eq(dependencyWatchObservations.repositoryId, watch.repositoryId),
        eq(dependencyWatchObservations.status, "candidates")
      )
    )
    .orderBy(desc(dependencyWatchObservations.observedAt));

  for (const observation of observations) {
    const values = Array.isArray(observation.candidates) ? observation.candidates : [];
    const candidate = values
      .map(candidateFromUnknown)
      .find(
        (value): value is DependencyUpgradeCandidate =>
          value?.fingerprint === input.fingerprint && candidateFingerprint(value) === value.fingerprint
      );
    if (candidate) {
      return {
        observationId: observation.id,
        watchId: observation.watchId,
        repositoryId: observation.repositoryId,
        observationKey: observation.observationKey,
        baselineSha: observation.baselineSha,
        candidate,
      };
    }
  }
  return null;
}

/** Read the newest candidate observation for stale-approval checks. */
export async function candidateIsCurrent(input: {
  workspaceId: string;
  watchId: string;
  candidate: DependencyUpgradeCandidate;
}): Promise<boolean> {
  const current = await findDependencyCandidate({
    workspaceId: input.workspaceId,
    watchId: input.watchId,
    fingerprint: input.candidate.fingerprint,
  });
  return !!current && sameCandidate(current.candidate, input.candidate);
}

export type CreateDependencyUpgradeContractInput = {
  workspaceId: string;
  repositoryId: string;
  watchId: string;
  observationKey: string;
  candidate: DependencyUpgradeCandidate;
  proposal: Record<string, unknown>;
  createdBy?: string | null;
  state?: DependencyUpgradeContractState;
};

/** Create once per candidate fingerprint; all retries return the same row. */
export async function createOrGetDependencyUpgradeContract(
  input: CreateDependencyUpgradeContractInput
): Promise<{ contract: DependencyUpgradeContractRow; created: boolean }> {
  const candidate = input.candidate;
  if (candidateFingerprint(candidate) !== candidate.fingerprint) {
    throw new Error("dependency candidate fingerprint does not match its identity fields");
  }
  const values = {
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    watchId: input.watchId,
    observationKey: input.observationKey,
    candidateFingerprint: candidate.fingerprint,
    packageName: candidate.package,
    dependencyKind: candidate.dependency_kind,
    specifier: candidate.specifier,
    currentVersion: candidate.current_version,
    targetVersion: candidate.target_version,
    manifestPath: candidate.manifest_path,
    lockfilePath: candidate.lockfile_path,
    baselineSha: candidate.baseline_sha,
    proposal: input.proposal,
    state: input.state ?? "proposed",
    createdBy: input.createdBy ?? null,
  } as const;

  const inserted = await db
    .insert(dependencyUpgradeContracts)
    .values(values)
    .onConflictDoNothing({
      target: [dependencyUpgradeContracts.workspaceId, dependencyUpgradeContracts.candidateFingerprint],
    })
    .returning();
  if (inserted[0]) {
    await recordDependencyUpgradeContractEvent({
      workspaceId: input.workspaceId,
      contractId: inserted[0].id,
      candidateFingerprint: candidate.fingerprint,
      actor: { actorType: "system", actorId: "dependency-watch" },
      decision: input.state === "needs-human-decision" ? "needs_human_decision" : "proposed",
      details: { baselineSha: candidate.baseline_sha, observationKey: input.observationKey },
    });
    return { contract: inserted[0], created: true };
  }

  const [existing] = await db
    .select()
    .from(dependencyUpgradeContracts)
    .where(
      and(
        eq(dependencyUpgradeContracts.workspaceId, input.workspaceId),
        eq(dependencyUpgradeContracts.candidateFingerprint, candidate.fingerprint)
      )
    )
    .limit(1);
  if (!existing) throw new Error("dependency upgrade contract disappeared after conflict");
  return { contract: existing, created: false };
}

/**
 * Replace an unresolved proposal with newly supplied evidence without ever
 * reopening an approval or a refused/published contract. This is the retry
 * path for a detector that first found an ambiguous candidate and later got
 * the missing human evidence.
 */
export async function refreshDependencyUpgradeContractProposal(input: {
  workspaceId: string;
  contractId: string;
  proposal: Record<string, unknown>;
}): Promise<DependencyUpgradeContractRow | null> {
  const [row] = await db
    .update(dependencyUpgradeContracts)
    .set({ proposal: input.proposal, state: "proposed", lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyUpgradeContracts.workspaceId, input.workspaceId),
        eq(dependencyUpgradeContracts.id, input.contractId),
        eq(dependencyUpgradeContracts.state, "needs-human-decision"),
        isNull(dependencyUpgradeContracts.approvalId)
      )
    )
    .returning();
  if (!row) return null;
  await recordDependencyUpgradeContractEvent({
    workspaceId: input.workspaceId,
    contractId: row.id,
    candidateFingerprint: row.candidateFingerprint,
    actor: { actorType: "system", actorId: "dependency-watch" },
    decision: "proposed",
    details: { refreshed: true },
  });
  return row;
}

export async function getDependencyUpgradeContract(
  workspaceId: string,
  contractId: string
): Promise<DependencyUpgradeContractRow | null> {
  const [row] = await db
    .select()
    .from(dependencyUpgradeContracts)
    .where(and(eq(dependencyUpgradeContracts.workspaceId, workspaceId), eq(dependencyUpgradeContracts.id, contractId)))
    .limit(1);
  return row ?? null;
}

export async function getDependencyUpgradeContractById(
  contractId: string
): Promise<DependencyUpgradeContractRow | null> {
  const [row] = await db
    .select()
    .from(dependencyUpgradeContracts)
    .where(eq(dependencyUpgradeContracts.id, contractId))
    .limit(1);
  return row ?? null;
}

export async function listDependencyUpgradeContracts(workspaceId: string) {
  return db
    .select()
    .from(dependencyUpgradeContracts)
    .where(eq(dependencyUpgradeContracts.workspaceId, workspaceId))
    .orderBy(desc(dependencyUpgradeContracts.updatedAt));
}

/** Attach the one approval row; a different approval can never replace it. */
export async function attachDependencyUpgradeApproval(
  workspaceId: string,
  contractId: string,
  approvalId: string
): Promise<DependencyUpgradeContractRow | null> {
  const [row] = await db
    .update(dependencyUpgradeContracts)
    .set({ approvalId, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyUpgradeContracts.workspaceId, workspaceId),
        eq(dependencyUpgradeContracts.id, contractId),
        inArray(dependencyUpgradeContracts.state, ["proposed", "needs-human-decision"]),
        or(isNull(dependencyUpgradeContracts.approvalId), eq(dependencyUpgradeContracts.approvalId, approvalId))
      )
    )
    .returning();
  if (row) return row;

  const [existing] = await db
    .select()
    .from(dependencyUpgradeContracts)
    .where(and(eq(dependencyUpgradeContracts.workspaceId, workspaceId), eq(dependencyUpgradeContracts.id, contractId)))
    .limit(1);
  if (existing?.approvalId === approvalId) return existing;
  if (existing?.approvalId) throw new Error("dependency upgrade contract already has another approval");
  return null;
}

export async function setDependencyUpgradeContractState(input: {
  workspaceId: string;
  contractId: string;
  state: DependencyUpgradeContractState;
  lastError?: string | null;
  issueUrl?: string | null;
  issueNumber?: number | null;
}) {
  const [row] = await db
    .update(dependencyUpgradeContracts)
    .set({
      state: input.state,
      lastError: input.lastError ?? null,
      issueUrl: input.issueUrl ?? undefined,
      issueNumber: input.issueNumber == null ? undefined : String(input.issueNumber),
      updatedAt: new Date(),
    })
    .where(and(eq(dependencyUpgradeContracts.workspaceId, input.workspaceId), eq(dependencyUpgradeContracts.id, input.contractId)))
    .returning();
  return row ?? null;
}

/**
 * Resolve a contract only after re-reading the observed candidate. The
 * pending approval may be old; a fresh observation with the same fingerprint
 * is the proof that the human approved the candidate they actually saw.
 */
export async function decideDependencyUpgradeContract(input: {
  workspaceId: string;
  contractId: string;
  approvalId: string;
  decision: "approved" | "denied";
  actor: ContractActor;
}): Promise<{ status: "approved" | "refused" | "stale" | "already_resolved"; contract: DependencyUpgradeContractRow | null }> {
  const current = await getDependencyUpgradeContract(input.workspaceId, input.contractId);
  if (!current || current.approvalId !== input.approvalId) {
    return { status: "stale", contract: current };
  }
  if (current.state !== "proposed") {
    return {
      status: current.state === "refused" ? "already_resolved" : current.state === "approved" || current.state === "published" ? "already_resolved" : "stale",
      contract: current,
    };
  }

  const candidate = await findDependencyCandidate({
    workspaceId: input.workspaceId,
    watchId: current.watchId,
    fingerprint: current.candidateFingerprint,
  });
  if (!candidate || !sameCandidate(candidate.candidate, {
    package: current.packageName,
    dependency_kind: current.dependencyKind,
    specifier: current.specifier,
    current_version: current.currentVersion,
    target_version: current.targetVersion,
    manifest_path: current.manifestPath,
    lockfile_path: current.lockfilePath,
    baseline_sha: current.baselineSha,
    fingerprint: current.candidateFingerprint,
  })) {
    const [stale] = await db
      .update(dependencyUpgradeContracts)
      .set({
        state: "stale",
        lastError: "candidate observation no longer matches the approved fingerprint",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dependencyUpgradeContracts.workspaceId, input.workspaceId),
          eq(dependencyUpgradeContracts.id, input.contractId),
          eq(dependencyUpgradeContracts.approvalId, input.approvalId),
          eq(dependencyUpgradeContracts.state, "proposed")
        )
      )
      .returning();
    if (stale) {
      await recordDependencyUpgradeContractEvent({
        workspaceId: input.workspaceId,
        contractId: stale.id,
        candidateFingerprint: stale.candidateFingerprint,
        actor: input.actor,
        decision: "stale",
        approvalId: input.approvalId,
      });
    }
    return { status: "stale", contract: stale };
  }

  const state = input.decision === "approved" ? "approved" : "refused";
  const [updated] = await db
    .update(dependencyUpgradeContracts)
    .set({ state, updatedAt: new Date(), lastError: null })
    .where(
      and(
        eq(dependencyUpgradeContracts.workspaceId, input.workspaceId),
        eq(dependencyUpgradeContracts.id, input.contractId),
        eq(dependencyUpgradeContracts.approvalId, input.approvalId),
        eq(dependencyUpgradeContracts.state, "proposed")
      )
    )
    .returning();
  if (!updated) return { status: "already_resolved", contract: await getDependencyUpgradeContract(input.workspaceId, input.contractId) };
  await recordDependencyUpgradeContractEvent({
    workspaceId: input.workspaceId,
    contractId: updated.id,
    candidateFingerprint: updated.candidateFingerprint,
    actor: input.actor,
    decision: input.decision === "approved" ? "approved" : "refused",
    approvalId: input.approvalId,
  });
  return { status: state, contract: updated };
}

export async function recordDependencyUpgradeContractEvent(input: {
  workspaceId: string;
  contractId: string;
  candidateFingerprint: string;
  actor: ContractActor;
  decision: DependencyUpgradeContractEvent;
  approvalId?: string | null;
  details?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(dependencyUpgradeContractEvents)
    .values({
      workspaceId: input.workspaceId,
      contractId: input.contractId,
      candidateFingerprint: input.candidateFingerprint,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      decision: input.decision,
      approvalId: input.approvalId ?? null,
      details: input.details ?? {},
    })
    .returning();
  return row;
}

export { candidateFromUnknown, sameCandidate };
