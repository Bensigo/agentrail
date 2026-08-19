import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  acceptanceContextOverlayManifestSha256: vi.fn(() => "f".repeat(64)),
  acceptanceContextPackCustodyBaseIndexRevisionSha256: vi.fn(() => "e".repeat(64)),
  completeAcceptanceContextPackRegenerationExecution: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepositoryByName: vi.fn(),
  listWikiPages: vi.fn(),
  prepareAcceptanceContextPackRegenerationExecution: vi.fn(),
  recordAcceptanceContextPackSnapshot: vi.fn(),
  resolveAcceptanceContextPackCustodyForRegeneration: vi.fn(),
  wikiPageBodySha256: vi.fn(() => "d".repeat(64)),
}));
vi.mock("./acceptance-context-pack-compiler", () => ({
  ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION: "compiler-current",
  ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION: "policy-current",
  compileAndRecordAcceptanceContextPack: vi.fn(),
}));
vi.mock("./github-exact-head-content", () => ({ materializeExactHeadGithubContent: vi.fn() }));

import {
  completeAcceptanceContextPackRegenerationExecution,
  getInstallationToken,
  getRepositoryByName,
  listWikiPages,
  prepareAcceptanceContextPackRegenerationExecution,
  recordAcceptanceContextPackSnapshot,
  resolveAcceptanceContextPackCustodyForRegeneration,
} from "@agentrail/db-postgres";
import { compileAndRecordAcceptanceContextPack } from "./acceptance-context-pack-compiler";
import { materializeExactHeadGithubContent } from "./github-exact-head-content";
import { executeAcceptanceContextPackRegeneration } from "./acceptance-context-pack-regeneration-execution";

const lease = { executionId: "11111111-1111-4111-8111-111111111111", workerId: "w", leaseToken: "a".repeat(43) };
const priorSourceSnapshot = {
    workspaceId: "11111111-1111-4111-8111-111111111112", id: "11111111-1111-4111-8111-111111111113", repo: "acme/repo", prNumber: 1,
    recordId: "11111111-1111-4111-8111-111111111114", reviewJobId: "11111111-1111-4111-8111-111111111115",
    acceptanceContractId: "11111111-1111-4111-8111-111111111116", acceptanceContractVersion: 1,
    acceptanceContractSha256: "a".repeat(64), packetIds: [], packetSetSha256: "b".repeat(64),
    correctionPacketPayloadSetSha256: "c".repeat(64), compilerVersion: "source-old",
    baseSha: "1".repeat(40), mergeBaseSha: "2".repeat(40), expectedHeadSha: "3".repeat(40),
    headTreeSha: "4".repeat(40), overlay: { files: [] }, baseIndex: { revisionSha256: "0".repeat(64) },
};
const ready = { kind: "ready", workspaceId: priorSourceSnapshot.workspaceId, recordId: priorSourceSnapshot.recordId, sourceSnapshotId: priorSourceSnapshot.id, priorCompiledPackId: "old", executionId: lease.executionId, priorSourceSnapshot, priorCompilerVersion: "compiler-old", priorPolicyVersion: "policy-old" };

describe("executeAcceptanceContextPackRegeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(completeAcceptanceContextPackRegenerationExecution).mockImplementation(async (input) => ({ kind: "completed", execution: input } as never));
    vi.mocked(getRepositoryByName).mockResolvedValue({ id: "11111111-1111-4111-8111-111111111117" } as never);
    vi.mocked(listWikiPages).mockResolvedValue([] as never);
    vi.mocked(recordAcceptanceContextPackSnapshot).mockResolvedValue({ snapshot: { id: "11111111-1111-4111-8111-111111111118" } } as never);
    vi.mocked(resolveAcceptanceContextPackCustodyForRegeneration).mockResolvedValue({ sourceSnapshot: { id: "11111111-1111-4111-8111-111111111118" } } as never);
  });
  it("re-materializes server-derived custody and records an immutable replacement", async () => {
    vi.mocked(prepareAcceptanceContextPackRegenerationExecution).mockResolvedValue(ready as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    vi.mocked(materializeExactHeadGithubContent).mockResolvedValue({ ok: true, materialization: {} } as never);
    vi.mocked(compileAndRecordAcceptanceContextPack).mockResolvedValue({ ok: true, persistence: { pack: { id: "new" } } } as never);
    await executeAcceptanceContextPackRegeneration(lease);
    expect(materializeExactHeadGithubContent).toHaveBeenCalledWith(expect.objectContaining({ token: "installation-token" }));
    expect(recordAcceptanceContextPackSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHeadSha: priorSourceSnapshot.expectedHeadSha,
        baseIndex: expect.objectContaining({ revisionSha256: "e".repeat(64) }),
      }),
      { regenerationExecutionId: lease.executionId },
    );
    expect(resolveAcceptanceContextPackCustodyForRegeneration).toHaveBeenCalledWith({
      workspaceId: priorSourceSnapshot.workspaceId,
      sourceSnapshotId: "11111111-1111-4111-8111-111111111118",
      regenerationExecutionId: lease.executionId,
    });
    expect(compileAndRecordAcceptanceContextPack).toHaveBeenCalledWith(expect.objectContaining({
      regenerationExecutionId: lease.executionId,
    }));
    expect(completeAcceptanceContextPackRegenerationExecution).toHaveBeenCalledWith({ ...lease, outcome: "replaced", replacementCompiledPackId: "new", reason: "compiler_output_replaced" });
  });
  it("holds an ambiguous exception and never retries inside the executor", async () => {
    vi.mocked(prepareAcceptanceContextPackRegenerationExecution).mockRejectedValue(new Error("unknown commit result"));
    await executeAcceptanceContextPackRegeneration(lease);
    expect(prepareAcceptanceContextPackRegenerationExecution).toHaveBeenCalledTimes(1);
    expect(completeAcceptanceContextPackRegenerationExecution).toHaveBeenCalledWith({ ...lease, outcome: "held", replacementCompiledPackId: undefined, reason: "execution_ambiguous" });
  });
  it("records explicit unchanged without a new snapshot or compiler run when Wiki and compiler inputs match", async () => {
    vi.mocked(prepareAcceptanceContextPackRegenerationExecution).mockResolvedValue({
      ...ready,
      priorSourceSnapshot: { ...priorSourceSnapshot, baseIndex: { revisionSha256: "e".repeat(64) } },
      priorCompilerVersion: "compiler-current",
      priorPolicyVersion: "policy-current",
    } as never);
    await executeAcceptanceContextPackRegeneration(lease);
    expect(recordAcceptanceContextPackSnapshot).not.toHaveBeenCalled();
    expect(materializeExactHeadGithubContent).not.toHaveBeenCalled();
    expect(compileAndRecordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(completeAcceptanceContextPackRegenerationExecution).toHaveBeenCalledWith({
      ...lease, outcome: "unchanged", replacementCompiledPackId: undefined, reason: "compiler_output_unchanged",
    });
  });
  it("holds a persisted replacement when the first terminal write is ambiguous without recompiling", async () => {
    vi.mocked(prepareAcceptanceContextPackRegenerationExecution).mockResolvedValue(ready as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    vi.mocked(materializeExactHeadGithubContent).mockResolvedValue({ ok: true, materialization: {} } as never);
    vi.mocked(compileAndRecordAcceptanceContextPack).mockResolvedValue({ ok: true, persistence: { pack: { id: "new" } } } as never);
    vi.mocked(completeAcceptanceContextPackRegenerationExecution)
      .mockRejectedValueOnce(new Error("ambiguous commit result"))
      .mockResolvedValueOnce({ kind: "completed", execution: { status: "held" } } as never);
    await executeAcceptanceContextPackRegeneration(lease);
    expect(compileAndRecordAcceptanceContextPack).toHaveBeenCalledTimes(1);
    expect(completeAcceptanceContextPackRegenerationExecution).toHaveBeenNthCalledWith(2, {
      ...lease, outcome: "held", replacementCompiledPackId: undefined, reason: "execution_ambiguous",
    });
  });
});
