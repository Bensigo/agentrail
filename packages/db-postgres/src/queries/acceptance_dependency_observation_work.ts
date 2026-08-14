import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  acceptanceCompiledContextPacks,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  acceptanceDependencyObservationClaims,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { acceptanceContextPackCanonicalSha256, acceptanceContractSha256 } from "./change_records.js";
import {
  dependencyObservationProposalContractMatches,
  resolveDependencyObservationProposalSourceCustody,
} from "./dependency_draft_proposal_detail.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_SCAN = 100;

export type AcceptanceDependencyObservationClaimInput = {
  workspaceId: string;
  workerId: string;
};

export function parseAcceptanceDependencyObservationClaimInput(
  value: unknown,
): AcceptanceDependencyObservationClaimInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2
    || !Object.hasOwn(input, "workspaceId") || !Object.hasOwn(input, "workerId")
    || typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.workerId !== "string" || !WORKER.test(input.workerId)) return null;
  return { workspaceId: input.workspaceId.toLowerCase(), workerId: input.workerId };
}

export type AcceptanceDependencyObservationWorkDescriptor = {
  claim: { id: string; token: string; expiresAt: Date };
  binding: {
    workspaceId: string;
    recordId: string;
    repo: string;
    prNumber: number;
    headSha: string;
    headCycleId: string;
    authorityGeneration: number;
    acceptanceContract: { id: string; version: number; sha256: string };
    compiledPack: {
      id: string;
      sha256: string;
      sourceSnapshotId: string;
      sourceCustodyIdentitySha256: string;
      compilerVersion: string;
      policyVersion: string;
    };
  };
  candidate: {
    identity: { ecosystem: "node"; manager: "pnpm"; profile: "pnpm_lockfile_only_v1" };
    package: string;
    dependencyKind: string;
    specifier: string;
    currentVersion: string;
    targetVersion: string;
    proposalFingerprint: string;
  };
  source: {
    manifest: { path: "package.json"; blobSha: string };
    lockfile: { path: "pnpm-lock.yaml"; blobSha: string };
  };
  operation: {
    updateArgv: ["pnpm", "update", string, "--lockfile-only", "--ignore-scripts"];
    authority: "observe_or_refuse_only";
  };
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function exactPackBlobSha(manifest: Record<string, unknown>, path: string): string | null {
  const sources = manifest.sources;
  if (!Array.isArray(sources)) return null;
  const matches = sources.filter((value): value is Record<string, unknown> =>
    value != null && typeof value === "object" && !Array.isArray(value)
      && value.path === path
      && (value.kind === "exact_head_overlay" || value.kind === "exact_head_dependency")
      && typeof value.blobSha === "string" && /^[a-f0-9]{40}$/u.test(value.blobSha)
  );
  return matches.length === 1 ? matches[0]!.blobSha as string : null;
}

async function currentCompiledPack(
  tx: DbTransaction,
  input: {
    workspaceId: string;
    recordId: string;
    repo: string;
    prNumber: number;
    headSha: string;
    headCycleId: string;
    acceptanceContractId: string;
    acceptanceContractVersion: number;
    acceptanceContractSha256: string;
  },
) {
  return (await tx.select({
    pack: acceptanceCompiledContextPacks,
    snapshot: acceptanceContextPackSnapshots,
  }).from(acceptanceCompiledContextPacks).innerJoin(
    acceptanceContextPackSnapshots,
    and(
      eq(acceptanceContextPackSnapshots.id, acceptanceCompiledContextPacks.sourceSnapshotId),
      eq(acceptanceContextPackSnapshots.workspaceId, acceptanceCompiledContextPacks.workspaceId),
    ),
  ).where(and(
    eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
    eq(acceptanceContextPackSnapshots.recordId, input.recordId),
    eq(acceptanceContextPackSnapshots.repo, input.repo),
    eq(acceptanceContextPackSnapshots.prNumber, input.prNumber),
    eq(acceptanceContextPackSnapshots.expectedHeadSha, input.headSha),
    eq(acceptanceContextPackSnapshots.reviewJobId, input.headCycleId),
    eq(acceptanceContextPackSnapshots.acceptanceContractId, input.acceptanceContractId),
    eq(acceptanceContextPackSnapshots.acceptanceContractVersion, input.acceptanceContractVersion),
    eq(acceptanceContextPackSnapshots.acceptanceContractSha256, input.acceptanceContractSha256),
    eq(acceptanceContextPackSnapshots.status, "admitted"),
  )).orderBy(
    desc(acceptanceCompiledContextPacks.createdAt),
    desc(acceptanceCompiledContextPacks.id),
  ).limit(1))[0] ?? null;
}

/**
 * Claims one server-selected current pnpm evidence task. The caller supplies
 * no Record, PR, head, Contract, Pack, candidate, path, profile, or command.
 * This is scheduling only: the existing v2 observation writer remains the
 * final exact-custody admission boundary after evidence gathering.
 */
export async function claimAcceptanceDependencyObservationWork(
  input: AcceptanceDependencyObservationClaimInput,
  options: { leaseSeconds?: number } = {},
): Promise<AcceptanceDependencyObservationWorkDescriptor | null> {
  const parsed = parseAcceptanceDependencyObservationClaimInput(input);
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!parsed || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3_600) {
    throw new Error("Dependency observation claim requires bounded workspace, worker, and lease");
  }

  return db.transaction(async (tx) => {
    const candidates = Array.from(await tx.execute(sql`
      SELECT record.id
      FROM ${changeRecords} AS record
      WHERE record.workspace_id = ${parsed.workspaceId}
        AND record.origin_channel = 'dependency_watch'
        AND record.state = 'open'
        AND record.merged_sha IS NULL
        AND record.pr_number IS NOT NULL
        AND record.current_pr_head_authoritative = true
        AND record.current_pr_head_sha IS NOT NULL
        AND record.current_pr_head_cycle_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${acceptanceContracts} AS contract
          WHERE contract.record_id = record.id AND contract.status = 'confirmed'
        )
      ORDER BY record.updated_at, record.id
      FOR UPDATE OF record SKIP LOCKED
      LIMIT ${MAX_SCAN}
    `)) as Array<{ id: string }>;

    for (const candidateRow of candidates) {
      const record = (await tx.select().from(changeRecords).where(and(
        eq(changeRecords.workspaceId, parsed.workspaceId),
        eq(changeRecords.id, candidateRow.id),
      )).limit(1))[0];
      if (!record || record.prNumber == null || record.currentPrHeadSha == null
        || record.currentPrHeadCycleId == null || record.sourceReferences.length !== 1
        || !record.headShas.includes(record.currentPrHeadSha)) continue;

      const source = resolveDependencyObservationProposalSourceCustody(record.sourceReferences[0]);
      if (!source || source.profile.ecosystem !== "node" || source.profile.manager !== "pnpm"
        || source.profile.profile !== "pnpm_lockfile_only_v1"
        || source.profile.capability !== "proposal_observation_only"
        || record.repo !== source.repositoryName) continue;

      const contracts = await tx.select().from(acceptanceContracts).where(and(
        eq(acceptanceContracts.recordId, record.id),
        eq(acceptanceContracts.status, "confirmed"),
      ));
      if (contracts.length !== 1) continue;
      const contract = contracts[0]!;
      if (!contract.confirmedBy || !(contract.confirmedAt instanceof Date)
        || !dependencyObservationProposalContractMatches(contract.contract, source)) continue;
      let contractSha256: string;
      try {
        contractSha256 = acceptanceContractSha256({
          acceptanceContractId: contract.id,
          acceptanceContractVersion: contract.version,
          contract: contract.contract,
        });
      } catch {
        continue;
      }

      const current = await currentCompiledPack(tx, {
        workspaceId: parsed.workspaceId,
        recordId: record.id,
        repo: record.repo,
        prNumber: record.prNumber,
        headSha: record.currentPrHeadSha,
        headCycleId: record.currentPrHeadCycleId,
        acceptanceContractId: contract.id,
        acceptanceContractVersion: contract.version,
        acceptanceContractSha256: contractSha256,
      });
      if (!current) continue;
      const manifestBlobSha = exactPackBlobSha(current.pack.manifest, "package.json");
      const lockfileBlobSha = exactPackBlobSha(current.pack.manifest, "pnpm-lock.yaml");
      if (!manifestBlobSha || !lockfileBlobSha) continue;

      const observationPrefix = `acceptance-dependency-observation:v2:${record.currentPrHeadCycleId}:%`;
      const legacyObservationPrefix = `acceptance-dependency-observation:${record.currentPrHeadCycleId}:%`;
      const observed = (await tx.select({ id: changeRecordEvents.id }).from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
        sql`(${changeRecordEvents.eventKey} LIKE ${observationPrefix}
          OR ${changeRecordEvents.eventKey} LIKE ${legacyObservationPrefix})`,
      )).limit(1))[0];
      if (observed) continue;

      const observationCandidate: Omit<
        AcceptanceDependencyObservationWorkDescriptor["candidate"],
        "proposalFingerprint"
      > = {
        identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
        package: source.candidate.package,
        dependencyKind: source.candidate.dependency_kind,
        specifier: source.candidate.specifier,
        currentVersion: source.candidate.current_version,
        targetVersion: source.candidate.target_version,
      };
      const observationCandidateFingerprint = `sha256:${acceptanceContextPackCanonicalSha256({
        identity: observationCandidate.identity,
        manifestPath: "package.json",
        package: observationCandidate.package,
        dependencyKind: observationCandidate.dependencyKind,
        specifier: observationCandidate.specifier,
        currentVersion: observationCandidate.currentVersion,
        targetVersion: observationCandidate.targetVersion,
      })}`;
      const existing = (await tx.select().from(acceptanceDependencyObservationClaims).where(and(
        eq(acceptanceDependencyObservationClaims.recordId, record.id),
        eq(acceptanceDependencyObservationClaims.headCycleId, record.currentPrHeadCycleId),
        eq(acceptanceDependencyObservationClaims.candidateFingerprint, observationCandidateFingerprint),
      )).limit(1))[0];
      const now = new Date();
      if (existing && existing.leaseExpiresAt > now) continue;

      const token = randomBytes(32).toString("base64url");
      const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
      const expiresAt = new Date(now.valueOf() + leaseSeconds * 1_000);
      const id = existing?.id ?? randomUUID();
      await tx.insert(acceptanceDependencyObservationClaims).values({
        id,
        workspaceId: parsed.workspaceId,
        recordId: record.id,
        headSha: record.currentPrHeadSha,
        headCycleId: record.currentPrHeadCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        acceptanceContractId: contract.id,
        acceptanceContractVersion: contract.version,
        acceptanceContractSha256: contractSha256,
        compiledPackId: current.pack.id,
        compiledPackSha256: current.pack.packSha256,
        candidateFingerprint: observationCandidateFingerprint,
        candidate: observationCandidate,
        profile: source.profile,
        claimedBy: parsed.workerId,
        claimTokenSha256: tokenSha256,
        claimedAt: now,
        leaseExpiresAt: expiresAt,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [
          acceptanceDependencyObservationClaims.recordId,
          acceptanceDependencyObservationClaims.headCycleId,
          acceptanceDependencyObservationClaims.candidateFingerprint,
        ],
        set: {
          headSha: record.currentPrHeadSha,
          authorityGeneration: record.currentPrHeadAuthorityGeneration,
          acceptanceContractId: contract.id,
          acceptanceContractVersion: contract.version,
          acceptanceContractSha256: contractSha256,
          compiledPackId: current.pack.id,
          compiledPackSha256: current.pack.packSha256,
          candidate: observationCandidate,
          profile: source.profile,
          claimedBy: parsed.workerId,
          claimTokenSha256: tokenSha256,
          claimedAt: now,
          leaseExpiresAt: expiresAt,
          updatedAt: now,
        },
      });

      return {
        claim: { id, token, expiresAt },
        binding: {
          workspaceId: parsed.workspaceId,
          recordId: record.id,
          repo: record.repo,
          prNumber: record.prNumber,
          headSha: record.currentPrHeadSha,
          headCycleId: record.currentPrHeadCycleId,
          authorityGeneration: record.currentPrHeadAuthorityGeneration,
          acceptanceContract: { id: contract.id, version: contract.version, sha256: contractSha256 },
          compiledPack: {
            id: current.pack.id,
            sha256: current.pack.packSha256,
            sourceSnapshotId: current.pack.sourceSnapshotId,
            sourceCustodyIdentitySha256: current.pack.sourceCustodyIdentitySha256,
            compilerVersion: current.pack.compilerVersion,
            policyVersion: current.pack.policyVersion,
          },
        },
        candidate: {
          ...observationCandidate,
          proposalFingerprint: source.candidateFingerprint,
        },
        source: {
          manifest: { path: "package.json", blobSha: manifestBlobSha },
          lockfile: { path: "pnpm-lock.yaml", blobSha: lockfileBlobSha },
        },
        operation: {
          updateArgv: [
            "pnpm", "update", `${source.candidate.package}@${source.candidate.target_version}`,
            "--lockfile-only", "--ignore-scripts",
          ],
          authority: "observe_or_refuse_only",
        },
      };
    }
    return null;
  });
}
