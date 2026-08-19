import {
  acceptanceContextOverlayManifestSha256,
  completeAcceptanceContextPackRegenerationExecution,
  getInstallationToken,
  getRepositoryByName,
  listWikiPages,
  prepareAcceptanceContextPackRegenerationExecution,
  recordAcceptanceContextPackSnapshot,
  resolveAcceptanceContextPackCustodyForRegeneration,
  type AcceptanceContextPackCustodyResolution,
  type AcceptanceContextPackSnapshotInput,
} from "@agentrail/db-postgres";
import {
  ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION,
  ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION,
  compileAndRecordAcceptanceContextPack,
} from "./acceptance-context-pack-compiler";
import { buildAcceptanceContextPackWikiBaseIndex } from "./acceptance-context-pack-wiki-base-index";
import { materializeExactHeadGithubContent } from "./github-exact-head-content";
import type { ExactHeadGithubContextSnapshot } from "./github-exact-head-context";

export type ExecuteAcceptanceContextPackRegenerationInput = {
  executionId: string;
  workerId: string;
  leaseToken: string;
};

function exactSnapshotFromCustody(
  source: AcceptanceContextPackSnapshotInput & { id: string },
): ExactHeadGithubContextSnapshot | null {
  if (!source.baseSha || !source.mergeBaseSha || !source.headTreeSha || !source.overlay) return null;
  const changedFiles = source.overlay.files.map((file) => ({
    path: file.path,
    status: file.status,
    blobSha: file.blobSha,
    previousPath: file.previousPath,
    patchSha256: file.patchSha256,
    patchByteCount: file.patchByteCount,
    headRanges: file.headRanges.length > 0
      ? file.headRanges.map(({ startLine, endLine }) => ({ startLine, endLine }))
      : null,
  }));
  const manifestSha256 = acceptanceContextOverlayManifestSha256({
    schemaVersion: 1,
    baseSha: source.baseSha,
    mergeBaseSha: source.mergeBaseSha,
    headSha: source.expectedHeadSha,
    files: changedFiles.map(({ path, status, blobSha, previousPath }) => ({
      path, status, blobSha, previousPath,
    })),
  });
  return {
    repo: source.repo,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    mergeBaseSha: source.mergeBaseSha,
    headSha: source.expectedHeadSha,
    headTreeSha: source.headTreeSha,
    changedFiles,
    manifestSha256,
    provenance: {
      schemaVersion: 1,
      included: changedFiles.map(({ path }) => ({
        path,
        source: "overlay" as const,
        reason: "exact_base_to_head_compare" as const,
      })),
      excluded: [],
    },
  };
}

/** Trusted, non-LLM regeneration seam. The worker supplies only opaque lease coordinates. */
export async function executeAcceptanceContextPackRegeneration(
  input: ExecuteAcceptanceContextPackRegenerationInput,
) {
  const finish = (outcome: "unchanged" | "not_proven" | "held", reason: string) =>
    completeAcceptanceContextPackRegenerationExecution({
      ...input,
      outcome,
      replacementCompiledPackId: undefined,
      reason,
    });
  try {
    const prepared = await prepareAcceptanceContextPackRegenerationExecution(input);
    if (prepared.kind !== "ready") return prepared;
    const snapshot = exactSnapshotFromCustody(prepared.priorSourceSnapshot);
    if (!snapshot) return await finish("not_proven", "exact_snapshot_not_proven");
    const repository = await getRepositoryByName(prepared.workspaceId, prepared.priorSourceSnapshot.repo);
    if (!repository) return await finish("not_proven", "wiki_repository_not_proven");
    const baseIndex = buildAcceptanceContextPackWikiBaseIndex({
      workspaceId: prepared.workspaceId,
      repositoryId: repository.id,
      pages: await listWikiPages(prepared.workspaceId, repository.id),
    });
    const wikiUnchanged = prepared.priorSourceSnapshot.baseIndex?.revisionSha256 === baseIndex.revisionSha256;
    if (wikiUnchanged && prepared.priorCompilerVersion === ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION
      && prepared.priorPolicyVersion === ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION) {
      return await finish("unchanged", "compiler_output_unchanged");
    }
    let custody: AcceptanceContextPackCustodyResolution;
    if (wikiUnchanged) {
      custody = await resolveAcceptanceContextPackCustodyForRegeneration({
        workspaceId: prepared.workspaceId,
        sourceSnapshotId: prepared.sourceSnapshotId,
        regenerationExecutionId: input.executionId,
      });
    } else {
      const source = prepared.priorSourceSnapshot;
      const compilerVersion = `exact-head-regeneration-v1-${baseIndex.revisionSha256}`;
      const persisted = await recordAcceptanceContextPackSnapshot({
        workspaceId: source.workspaceId,
        recordId: source.recordId,
        reviewJobId: source.reviewJobId,
        acceptanceContractId: source.acceptanceContractId,
        acceptanceContractVersion: source.acceptanceContractVersion,
        acceptanceContractSha256: source.acceptanceContractSha256,
        repo: source.repo,
        prNumber: source.prNumber,
        expectedHeadSha: source.expectedHeadSha,
        baseSha: source.baseSha,
        mergeBaseSha: source.mergeBaseSha,
        headTreeSha: source.headTreeSha,
        packetIds: source.packetIds,
        packetSetSha256: source.packetSetSha256,
        correctionPacketPayloadSetSha256: source.correctionPacketPayloadSetSha256,
        compilerVersion,
        baseIndex,
        overlay: source.overlay,
        provenance: {
          schemaVersion: 1,
          included: [
            ...baseIndex.pages.map(({ slug }) => ({ path: slug, source: "base_index" as const, reason: "server_wiki_background" })),
            ...(source.overlay?.files ?? []).map(({ path }) => ({ path, source: "overlay" as const, reason: "exact_base_to_head_compare" })),
          ],
          excluded: baseIndex.gaps.map((reason) => ({ path: null, source: "base_index" as const, reason })),
        },
        status: "admitted",
        reason: null,
      }, { regenerationExecutionId: input.executionId });
      custody = await resolveAcceptanceContextPackCustodyForRegeneration({
        workspaceId: prepared.workspaceId,
        sourceSnapshotId: persisted.snapshot.id,
        regenerationExecutionId: input.executionId,
      });
    }
    const token = await getInstallationToken(prepared.workspaceId);
    if (!token) return await finish("held", "github_credential_unavailable");
    const materialization = await materializeExactHeadGithubContent({ token, snapshot });
    if (!materialization.ok) return await finish("not_proven", `exact_content_${materialization.reason}`);
    const compiled = await compileAndRecordAcceptanceContextPack({
      custody,
      snapshot,
      materialization: materialization.materialization,
      regenerationExecutionId: input.executionId,
    });
    if (!compiled.ok) return await finish("not_proven", `pack_compilation_${compiled.reason}`);
    const packId = compiled.persistence.pack.id;
    if (packId === prepared.priorCompiledPackId) {
      return await finish("unchanged", "compiler_output_unchanged");
    }
    return await completeAcceptanceContextPackRegenerationExecution({
      ...input,
      outcome: "replaced",
      replacementCompiledPackId: packId,
      reason: "compiler_output_replaced",
    });
  } catch {
    return await finish("held", "execution_ambiguous");
  }
}
