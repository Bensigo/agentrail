import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  acceptanceCompiledContextPacks,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  acceptanceDependencyObservationClaims,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { workspaces } from "../schema/workspaces.js";
import {
  acceptanceContextPackCanonicalSha256,
  acceptanceContractSha256,
  githubInstallationIdentitySha256,
} from "./change_records.js";
import {
  dependencyWatchGoSumdbSignedTreeNotes,
  dependencyWatchObservations,
} from "../schema/dependency_watches.js";
import {
  dependencyObservationProposalContractMatches,
  resolveDependencyObservationProposalSourceCustody,
} from "./dependency_draft_proposal_detail.js";
import { validateGoDependencySourceInventoryReceipt } from "./dependency_watches.js";

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

type AcceptanceDependencyObservationWorkBinding = {
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

type AcceptanceDependencyObservationWorkBase = {
  claim: { id: string; token: string; expiresAt: Date };
  binding: AcceptanceDependencyObservationWorkBinding;
  githubInstallationIdentitySha256: string;
};

export type PnpmAcceptanceDependencyObservationWorkDescriptor =
  AcceptanceDependencyObservationWorkBase & {
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

export type GoModulesAcceptanceDependencyObservationWorkDescriptor =
  AcceptanceDependencyObservationWorkBase & {
    candidate: {
      identity: { ecosystem: "go"; manager: "go-modules"; profile: "go_root_public_proxy_lock_v1" };
      package: string;
      dependencyKind: "dependencies";
      specifier: string;
      currentVersion: string;
      targetVersion: string;
      proposalFingerprint: string;
    };
    source: {
      manifest: { path: "go.mod"; blobSha: string };
      lockfile: { path: "go.sum"; blobSha: string };
      inventory: { receipt: Record<string, unknown>; identitySha256: string };
      sumdb: {
        priorSignedTreeNoteBase64: string | null;
        priorSignedTreeNoteSha256: string | null;
        generation: number | null;
      };
    };
    operation: {
      updateArgv: ["go", "get", string];
      authority: "observe_or_refuse_only";
    };
  };

export type AcceptanceDependencyObservationWorkDescriptor =
  | PnpmAcceptanceDependencyObservationWorkDescriptor
  | GoModulesAcceptanceDependencyObservationWorkDescriptor;

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
  const snapshots = await tx.select().from(acceptanceContextPackSnapshots).where(and(
    eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
    eq(acceptanceContextPackSnapshots.recordId, input.recordId),
    eq(acceptanceContextPackSnapshots.reviewJobId, input.headCycleId),
    eq(acceptanceContextPackSnapshots.generationStatus, "active"),
  )).limit(2);
  if (snapshots.length !== 1) return null;
  const snapshot = snapshots[0]!;
  if (snapshot.repo !== input.repo || snapshot.prNumber !== input.prNumber
    || snapshot.expectedHeadSha !== input.headSha
    || snapshot.acceptanceContractId !== input.acceptanceContractId
    || snapshot.acceptanceContractVersion !== input.acceptanceContractVersion
    || snapshot.acceptanceContractSha256 !== input.acceptanceContractSha256
    || snapshot.status !== "admitted") return null;
  const packs = await tx.select().from(acceptanceCompiledContextPacks).where(and(
    eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
    eq(acceptanceCompiledContextPacks.sourceSnapshotId, snapshot.id),
    eq(acceptanceCompiledContextPacks.generationStatus, "active"),
  )).limit(2);
  return packs.length === 1 ? { pack: packs[0]!, snapshot } : null;
}

export async function releaseAcceptanceDependencyObservationClaim(input: {
  workspaceId: string;
  claimId: string;
  claimToken: string;
}): Promise<boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3
    || !UUID.test(input.workspaceId) || !UUID.test(input.claimId)
    || typeof input.claimToken !== "string"
    || !/^[A-Za-z0-9_-]{32,256}$/u.test(input.claimToken)) return false;
  const tokenSha256 = createHash("sha256").update(input.claimToken, "utf8").digest("hex");
  const released = await db.delete(acceptanceDependencyObservationClaims).where(and(
    eq(acceptanceDependencyObservationClaims.id, input.claimId.toLowerCase()),
    eq(acceptanceDependencyObservationClaims.workspaceId, input.workspaceId.toLowerCase()),
    eq(acceptanceDependencyObservationClaims.claimTokenSha256, tokenSha256),
    isNull(acceptanceDependencyObservationClaims.consumedAt),
  )).returning({ id: acceptanceDependencyObservationClaims.id });
  return released.length === 1;
}

/**
 * Claims one server-selected current operational dependency evidence task. The caller supplies
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
    const installation = (await tx.select({
      installationId: workspaces.githubInstallationId,
      accountLogin: workspaces.githubInstallationAccountLogin,
      accountType: workspaces.githubInstallationAccountType,
    }).from(workspaces).where(eq(workspaces.id, parsed.workspaceId)).limit(1))[0];
    const installationIdentitySha256 = installation && githubInstallationIdentitySha256({
      workspaceId: parsed.workspaceId,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    });
    if (!installationIdentitySha256) return null;

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
      if (!source || source.profile.capability !== "proposal_observation_only"
        || record.repo !== source.repositoryName) continue;
      const isPnpm = source.profile.ecosystem === "node" && source.profile.manager === "pnpm"
        && source.profile.profile === "pnpm_lockfile_only_v1"
        && source.sourceInventoryReceiptSha256 === null;
      const isGo = source.profile.ecosystem === "go" && source.profile.manager === "go-modules"
        && source.profile.profile === "go_root_public_proxy_lock_v1"
        && source.sourceInventoryReceiptSha256 !== null;
      if (!isPnpm && !isGo) continue;

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
      const manifestPath = isGo ? "go.mod" as const : "package.json" as const;
      const lockfilePath = isGo ? "go.sum" as const : "pnpm-lock.yaml" as const;
      const manifestBlobSha = exactPackBlobSha(current.pack.manifest, manifestPath);
      const lockfileBlobSha = exactPackBlobSha(current.pack.manifest, lockfilePath);
      if (!manifestBlobSha || !lockfileBlobSha) continue;

      let goManagerCustody: Record<string, unknown> | null = null;
      let goDescriptorSource: GoModulesAcceptanceDependencyObservationWorkDescriptor["source"] | null = null;
      if (isGo) {
        const sourceInventoryReceiptSha256 = source.sourceInventoryReceiptSha256;
        if (sourceInventoryReceiptSha256 === null) continue;
        const observation = (await tx.select().from(dependencyWatchObservations).where(and(
          eq(dependencyWatchObservations.id, source.observationId),
          eq(dependencyWatchObservations.workspaceId, parsed.workspaceId),
          eq(dependencyWatchObservations.watchId, source.watchId),
          eq(dependencyWatchObservations.repositoryId, source.repositoryId),
        )).limit(1))[0];
        const inventory = observation?.sourceInventoryReceiptSha256 === sourceInventoryReceiptSha256
          ? validateGoDependencySourceInventoryReceipt(
            observation.sourceInventoryReceipt,
            sourceInventoryReceiptSha256,
          )
          : null;
        const requiredManifest = inventory?.requiredFiles.find((file) => file.path === "go.mod");
        const requiredLockfile = inventory?.requiredFiles.find((file) => file.path === "go.sum");
        if (!observation || observation.status !== "candidates"
          || observation.baselineSha !== record.currentPrHeadSha
          || observation.candidateFingerprint !== source.candidateFingerprint
          || !inventory || inventory.authority.repository !== record.repo
          || inventory.authority.requestedRef !== record.currentPrHeadSha
          || inventory.authority.commitSha !== record.currentPrHeadSha
          || requiredManifest?.blobSha !== manifestBlobSha
          || requiredLockfile?.blobSha !== lockfileBlobSha
          || requiredManifest.contentSha256
            !== (source.selectedFileHashes as { "go.mod": string })["go.mod"]
          || requiredLockfile.contentSha256
            !== (source.selectedFileHashes as { "go.sum": string })["go.sum"]) continue;
        const note = (await tx.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(and(
          eq(dependencyWatchGoSumdbSignedTreeNotes.workspaceId, parsed.workspaceId),
          eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, source.watchId),
          eq(dependencyWatchGoSumdbSignedTreeNotes.repositoryId, source.repositoryId),
        )).orderBy(desc(dependencyWatchGoSumdbSignedTreeNotes.generation)).limit(1))[0] ?? null;
        if (note && (note.sourceInventoryReceiptSha256 !== sourceInventoryReceiptSha256
          || note.sourceObservationId !== source.observationId)) continue;
        goManagerCustody = {
          kind: "go_modules_sumdb_observation_custody",
          version: 1,
          repositoryId: source.repositoryId,
          watchId: source.watchId,
          sourceObservationId: source.observationId,
          sourceInventoryReceiptSha256,
          priorSignedTreeNoteSha256: note?.signedTreeNoteSha256 ?? null,
          priorGeneration: note?.generation ?? null,
        };
        goDescriptorSource = {
          manifest: { path: "go.mod", blobSha: manifestBlobSha },
          lockfile: { path: "go.sum", blobSha: lockfileBlobSha },
          inventory: {
            receipt: inventory as unknown as Record<string, unknown>,
            identitySha256: sourceInventoryReceiptSha256,
          },
          sumdb: {
            priorSignedTreeNoteBase64: note?.signedTreeNoteBase64 ?? null,
            priorSignedTreeNoteSha256: note?.signedTreeNoteSha256 ?? null,
            generation: note?.generation ?? null,
          },
        };
      }

      const observationPrefix = `acceptance-dependency-observation:v2:${record.currentPrHeadCycleId}:%`;
      const legacyObservationPrefix = `acceptance-dependency-observation:${record.currentPrHeadCycleId}:%`;
      const observed = (await tx.select({ id: changeRecordEvents.id }).from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
        sql`(${changeRecordEvents.eventKey} LIKE ${observationPrefix}
          OR ${changeRecordEvents.eventKey} LIKE ${legacyObservationPrefix})`,
      )).limit(1))[0];
      if (observed) continue;

      const observationCandidate = {
        identity: isGo
          ? { ecosystem: "go" as const, manager: "go-modules" as const, profile: "go_root_public_proxy_lock_v1" as const }
          : { ecosystem: "node" as const, manager: "pnpm" as const, profile: "pnpm_lockfile_only_v1" as const },
        package: source.candidate.package,
        dependencyKind: source.candidate.dependency_kind,
        specifier: source.candidate.specifier,
        currentVersion: source.candidate.current_version,
        targetVersion: source.candidate.target_version,
      };
      const observationCandidateFingerprint = `sha256:${acceptanceContextPackCanonicalSha256({
        identity: observationCandidate.identity,
        manifestPath,
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
        githubInstallationIdentitySha256: installationIdentitySha256,
        candidateFingerprint: observationCandidateFingerprint,
        candidate: observationCandidate,
        profile: source.profile,
        managerCustody: goManagerCustody ?? {},
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
          githubInstallationIdentitySha256: installationIdentitySha256,
          candidate: observationCandidate,
          profile: source.profile,
          managerCustody: goManagerCustody ?? {},
          claimedBy: parsed.workerId,
          claimTokenSha256: tokenSha256,
          claimedAt: now,
          leaseExpiresAt: expiresAt,
          updatedAt: now,
        },
      });

      const binding: AcceptanceDependencyObservationWorkBinding = {
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
      };
      if (isGo) {
        if (!goDescriptorSource) continue;
        return {
          claim: { id, token, expiresAt },
          binding,
          candidate: {
            identity: {
              ecosystem: "go", manager: "go-modules", profile: "go_root_public_proxy_lock_v1",
            },
            package: observationCandidate.package,
            dependencyKind: "dependencies",
            specifier: observationCandidate.specifier,
            currentVersion: observationCandidate.currentVersion,
            targetVersion: observationCandidate.targetVersion,
            proposalFingerprint: source.candidateFingerprint,
          },
          source: goDescriptorSource,
          operation: {
            updateArgv: ["go", "get", `${source.candidate.package}@${source.candidate.target_version}`],
            authority: "observe_or_refuse_only",
          },
          githubInstallationIdentitySha256: installationIdentitySha256,
        } satisfies GoModulesAcceptanceDependencyObservationWorkDescriptor;
      }
      return {
        claim: { id, token, expiresAt },
        binding,
        candidate: {
          identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
          package: observationCandidate.package,
          dependencyKind: observationCandidate.dependencyKind,
          specifier: observationCandidate.specifier,
          currentVersion: observationCandidate.currentVersion,
          targetVersion: observationCandidate.targetVersion,
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
        githubInstallationIdentitySha256: installationIdentitySha256,
      } satisfies PnpmAcceptanceDependencyObservationWorkDescriptor;
    }
    return null;
  });
}
