import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptanceContractSha256: vi.fn(() => "1".repeat(64)),
  acceptanceCorrectionPacketPayloadSetSha256: vi.fn(() => "2".repeat(64)),
  acceptanceContextOverlayManifestSha256: vi.fn(() => "6".repeat(64)),
  acceptanceContextPacketSetSha256: vi.fn(() => "3".repeat(64)),
  acceptanceContextPackSnapshotId: vi.fn(() => "00000000-0000-4000-8000-000000000007"),
  acceptanceContextPackCustodyBaseIndexRevisionSha256: vi.fn(() => "4".repeat(64)),
  getInstallationToken: vi.fn(),
  getRepositoryByName: vi.fn(),
  getReviewJobById: vi.fn(),
  listWikiPages: vi.fn(),
  projectConfirmedAcceptanceContract: vi.fn(),
  queueSelectedCorrectionDispatch: vi.fn(),
  readAcceptanceBuilderRouteSelection: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
  recordAcceptanceContextPackSnapshot: vi.fn(),
  resolveAcceptanceCompiledContextPack: vi.fn(),
  resolveAcceptanceBuilderRouteCapabilityProfile: vi.fn(),
  resolveAcceptanceContextPackCustody: vi.fn(),
  validateReviewJobCorrectionPacketPayload: vi.fn(() => true),
  wikiPageBodySha256: vi.fn(() => "5".repeat(64)),
  compileAndRecordAcceptanceContextPack: vi.fn(),
  materializeExactHeadGithubContent: vi.fn(),
  exactHeadContextCustodyOverlay: vi.fn(),
  readExactHeadGithubContext: vi.fn(),
  runGithubCorrectionCarrier: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  acceptanceContractSha256: mocks.acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256: mocks.acceptanceCorrectionPacketPayloadSetSha256,
  acceptanceContextOverlayManifestSha256: mocks.acceptanceContextOverlayManifestSha256,
  acceptanceContextPacketSetSha256: mocks.acceptanceContextPacketSetSha256,
  acceptanceContextPackSnapshotId: mocks.acceptanceContextPackSnapshotId,
  acceptanceContextPackCustodyBaseIndexRevisionSha256:
    mocks.acceptanceContextPackCustodyBaseIndexRevisionSha256,
  getInstallationToken: mocks.getInstallationToken,
  getRepositoryByName: mocks.getRepositoryByName,
  getReviewJobById: mocks.getReviewJobById,
  listWikiPages: mocks.listWikiPages,
  projectConfirmedAcceptanceContract: mocks.projectConfirmedAcceptanceContract,
  queueSelectedCorrectionDispatch: mocks.queueSelectedCorrectionDispatch,
  readAcceptanceBuilderRouteSelection: mocks.readAcceptanceBuilderRouteSelection,
  readAcceptanceContracts: mocks.readAcceptanceContracts,
  readChangeRecordTimelineByPr: mocks.readChangeRecordTimelineByPr,
  recordAcceptanceContextPackSnapshot: mocks.recordAcceptanceContextPackSnapshot,
  resolveAcceptanceCompiledContextPack: mocks.resolveAcceptanceCompiledContextPack,
  resolveAcceptanceBuilderRouteCapabilityProfile: mocks.resolveAcceptanceBuilderRouteCapabilityProfile,
  resolveAcceptanceContextPackCustody: mocks.resolveAcceptanceContextPackCustody,
  validateReviewJobCorrectionPacketPayload: mocks.validateReviewJobCorrectionPacketPayload,
  wikiPageBodySha256: mocks.wikiPageBodySha256,
}));

vi.mock("./acceptance-context-pack-compiler", () => ({
  ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION: "exact-head-correction-pack-v4",
  ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION: "bounded-exact-ranges-v2",
  compileAndRecordAcceptanceContextPack: mocks.compileAndRecordAcceptanceContextPack,
}));
vi.mock("./github-exact-head-content", () => ({
  materializeExactHeadGithubContent: mocks.materializeExactHeadGithubContent,
}));
vi.mock("./github-exact-head-context", () => ({
  exactHeadContextCustodyOverlay: mocks.exactHeadContextCustodyOverlay,
  readExactHeadGithubContext: mocks.readExactHeadGithubContext,
}));
vi.mock("./github-correction-carrier", () => ({
  runGithubCorrectionCarrier: mocks.runGithubCorrectionCarrier,
}));

import { produceAndRunGithubCorrectionDispatch } from "./github-correction-dispatch-production";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-000000000002";
const JOB_ID = "00000000-0000-4000-8000-000000000003";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000004";
const ROUTE_ID = "00000000-0000-4000-8000-000000000005";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000006";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000007";
const PACK_ID = "00000000-0000-4000-8000-000000000008";
const DISPATCH_ID = "00000000-0000-4000-8000-000000000009";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const CRITERION = "The saved value is visible.";

const packet = {
  kind: "review_job_correction_packet",
  version: 1,
  packetId: "correction-" + "f".repeat(48),
  workspaceId: WORKSPACE_ID,
  repo: "acme/widgets",
  prNumber: 42,
  headSha: HEAD,
  recordId: RECORD_ID,
  jobId: JOB_ID,
  acceptanceContract: { id: CONTRACT_ID, version: 2 },
  criterion: { id: "AC-1", snapshot: CRITERION },
};

const exactSnapshot = {
  repo: "acme/widgets",
  prNumber: 42,
  baseSha: BASE,
  mergeBaseSha: MERGE_BASE,
  headSha: HEAD,
  headTreeSha: TREE,
  changedFiles: [{
    path: "src/widget.ts",
    status: "modified",
    blobSha: "e".repeat(40),
    previousPath: null,
    patchSha256: "f".repeat(64),
    patchByteCount: 128,
    headRanges: [{ startLine: 3, endLine: 4 }],
  }],
  manifestSha256: "6".repeat(64),
  provenance: { schemaVersion: 1, included: [], excluded: [] },
};

const overlay = {
  schemaVersion: 2,
  baseSha: BASE,
  mergeBaseSha: MERGE_BASE,
  headSha: HEAD,
  files: [{
    path: "src/widget.ts",
    status: "modified",
    blobSha: "e".repeat(40),
    previousPath: null,
    patchSha256: "f".repeat(64),
    patchByteCount: 128,
    headRanges: [{ startLine: 3, endLine: 4, coordinateSha256: "9".repeat(64) }],
  }],
  manifestSha256: "7".repeat(64),
};

const admittedCustody = {
  sourceSnapshot: {
    id: SNAPSHOT_ID,
    workspaceId: WORKSPACE_ID,
    recordId: RECORD_ID,
    reviewJobId: JOB_ID,
    acceptanceContractId: CONTRACT_ID,
    acceptanceContractVersion: 2,
    repo: "acme/widgets",
    prNumber: 42,
    expectedHeadSha: HEAD,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    headTreeSha: TREE,
    packetIds: [packet.packetId],
    packetSetSha256: "3".repeat(64),
    correctionPacketPayloadSetSha256: "2".repeat(64),
    compilerVersion: "exact-head-overlay-v2",
    baseIndex: {
      schemaVersion: 2,
      backgroundOnly: true,
      pages: [],
      gaps: ["No compiled Wiki pages exist for this repository"],
      revisionSha256: "4".repeat(64),
    },
    overlay,
    provenance: { schemaVersion: 1, included: [], excluded: [] },
  },
  contract: {},
  acceptanceContractSha256: "1".repeat(64),
  correctionPackets: [packet],
  correctionPacketPayloadSetSha256: "2".repeat(64),
  wikiPages: [],
};

function postedEvent() {
  return {
    eventKey: `review:github-posted:${JOB_ID}`,
    stage: "review",
    actor: "reviewer-of-record",
    payloadRef: {
      kind: "review_job_github_posted",
      jobId: JOB_ID,
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
      prNumber: 42,
      headSha: HEAD,
      recordId: RECORD_ID,
      acceptanceContractId: CONTRACT_ID,
      acceptanceContractVersion: 2,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAcceptanceContextPackCustody.mockReset();
  mocks.validateReviewJobCorrectionPacketPayload.mockReturnValue(true);
  mocks.getReviewJobById.mockResolvedValue({
    id: JOB_ID,
    workspaceId: WORKSPACE_ID,
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    state: "running",
  });
  mocks.readChangeRecordTimelineByPr.mockResolvedValue({
    record: {
      id: RECORD_ID,
      currentPrHeadAuthoritative: true,
      currentPrHeadSha: HEAD,
      currentPrHeadCycleId: JOB_ID,
    },
    events: [
      postedEvent(),
      {
        eventKey: `review:correction:${JOB_ID}:AC-1`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: packet,
      },
    ],
  });
  mocks.readAcceptanceBuilderRouteSelection.mockResolvedValue({
    route: { id: ROUTE_ID, adapter: "github_codex" },
  });
  mocks.resolveAcceptanceBuilderRouteCapabilityProfile.mockResolvedValue({ id: ROUTE_ID });
  mocks.readAcceptanceContracts.mockResolvedValue([{
    id: CONTRACT_ID,
    version: 2,
    status: "confirmed",
    contract: { acceptanceCriteria: [{ id: "AC-1", text: CRITERION }] },
  }]);
  mocks.projectConfirmedAcceptanceContract.mockReturnValue({
    originalRequest: "Make saved values visible.",
    normalizedRequirements: [CRITERION],
    acceptanceCriteria: [{ id: "AC-1", text: CRITERION, userVisible: true, modality: "ui" }],
    nonGoals: [],
    risks: [],
    stops: [],
    environment: {},
    unresolvedQuestions: [],
  });
  mocks.getRepositoryByName.mockResolvedValue({ id: REPOSITORY_ID });
  mocks.getInstallationToken.mockResolvedValue("installation-token");
  mocks.readExactHeadGithubContext.mockResolvedValue({ ok: true, snapshot: exactSnapshot });
  mocks.exactHeadContextCustodyOverlay.mockReturnValue(overlay);
  mocks.listWikiPages.mockResolvedValue([]);
  mocks.recordAcceptanceContextPackSnapshot.mockResolvedValue({
    snapshot: { id: SNAPSHOT_ID },
    inserted: true,
  });
  mocks.resolveAcceptanceCompiledContextPack.mockResolvedValue(null);
  mocks.resolveAcceptanceContextPackCustody
    .mockRejectedValueOnce(new Error("snapshot missing"))
    .mockResolvedValue(admittedCustody);
  mocks.materializeExactHeadGithubContent.mockResolvedValue({
    ok: true,
    materialization: { content: { identitySha256: "8".repeat(64), headTreeSha: TREE, records: [], exclusions: [] } },
  });
  mocks.compileAndRecordAcceptanceContextPack.mockResolvedValue({
    ok: true,
    persistence: { pack: { id: PACK_ID }, inserted: true },
  });
  mocks.queueSelectedCorrectionDispatch.mockResolvedValue({
    dispatch: { id: DISPATCH_ID, routeAdapter: "github_codex" },
    inserted: true,
  });
  mocks.runGithubCorrectionCarrier.mockResolvedValue({
    kind: "carrier_accepted",
    githubCommentId: "123",
    githubCommentUrl: "https://github.com/acme/widgets/issues/42#issuecomment-123",
  });
});

describe("produceAndRunGithubCorrectionDispatch", () => {
  it("rejects a widened caller input before any lookup", async () => {
    await expect(produceAndRunGithubCorrectionDispatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      headSha: HEAD,
    } as never)).resolves.toEqual({ kind: "invalid_input" });
    expect(mocks.getReviewJobById).not.toHaveBeenCalled();
  });

  it("derives the exact source, persists custody, queues one selected route, then runs the carrier", async () => {
    await expect(produceAndRunGithubCorrectionDispatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).resolves.toEqual({
      kind: "carrier_accepted",
      dispatchId: DISPATCH_ID,
      githubCommentId: "123",
      githubCommentUrl: "https://github.com/acme/widgets/issues/42#issuecomment-123",
    });

    expect(mocks.readExactHeadGithubContext).toHaveBeenCalledWith({
      token: "installation-token",
      repo: "acme/widgets",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
    expect(mocks.recordAcceptanceContextPackSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      reviewJobId: JOB_ID,
      repo: "acme/widgets",
      prNumber: 42,
      expectedHeadSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headTreeSha: TREE,
      status: "admitted",
    }));
    expect(mocks.queueSelectedCorrectionDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      compiledPackId: PACK_ID,
    });
    expect(mocks.runGithubCorrectionCarrier).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      dispatchId: DISPATCH_ID,
    });

    const order = (mock: typeof mocks.recordAcceptanceContextPackSnapshot, index = 0) =>
      mock.mock.invocationCallOrder[index]!;
    expect(order(mocks.recordAcceptanceContextPackSnapshot)).toBeLessThan(order(mocks.resolveAcceptanceContextPackCustody, 1));
    expect(order(mocks.resolveAcceptanceContextPackCustody, 1)).toBeLessThan(order(mocks.materializeExactHeadGithubContent));
    expect(order(mocks.materializeExactHeadGithubContent)).toBeLessThan(order(mocks.compileAndRecordAcceptanceContextPack));
    expect(order(mocks.compileAndRecordAcceptanceContextPack)).toBeLessThan(order(mocks.queueSelectedCorrectionDispatch));
    expect(order(mocks.queueSelectedCorrectionDispatch)).toBeLessThan(order(mocks.runGithubCorrectionCarrier));
  });

  it("replays an existing exact compiled Pack before reading mutable source or Wiki state", async () => {
    mocks.resolveAcceptanceCompiledContextPack.mockResolvedValue({ id: PACK_ID });
    mocks.listWikiPages.mockRejectedValue(new Error("Wiki changed after carrier acceptance"));

    await expect(produceAndRunGithubCorrectionDispatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).resolves.toMatchObject({ kind: "carrier_accepted", dispatchId: DISPATCH_ID });

    expect(mocks.resolveAcceptanceCompiledContextPack).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      compilerVersion: "exact-head-correction-pack-v4",
      policyVersion: "bounded-exact-ranges-v2",
    });
    expect(mocks.getRepositoryByName).not.toHaveBeenCalled();
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
    expect(mocks.readExactHeadGithubContext).not.toHaveBeenCalled();
    expect(mocks.listWikiPages).not.toHaveBeenCalled();
    expect(mocks.recordAcceptanceContextPackSnapshot).not.toHaveBeenCalled();
    expect(mocks.materializeExactHeadGithubContent).not.toHaveBeenCalled();
    expect(mocks.compileAndRecordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(mocks.runGithubCorrectionCarrier).toHaveBeenCalledTimes(1);
  });

  it("resumes an admitted snapshot without rebuilding its mutable Wiki or comparison inputs", async () => {
    mocks.resolveAcceptanceContextPackCustody.mockReset();
    mocks.resolveAcceptanceContextPackCustody.mockResolvedValue(admittedCustody);

    await expect(produceAndRunGithubCorrectionDispatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).resolves.toMatchObject({ kind: "carrier_accepted", dispatchId: DISPATCH_ID });

    expect(mocks.getRepositoryByName).not.toHaveBeenCalled();
    expect(mocks.readExactHeadGithubContext).not.toHaveBeenCalled();
    expect(mocks.listWikiPages).not.toHaveBeenCalled();
    expect(mocks.recordAcceptanceContextPackSnapshot).not.toHaveBeenCalled();
    expect(mocks.materializeExactHeadGithubContent).toHaveBeenCalledWith({
      token: "installation-token",
      snapshot: expect.objectContaining({
        repo: "acme/widgets",
        prNumber: 42,
        baseSha: BASE,
        mergeBaseSha: MERGE_BASE,
        headSha: HEAD,
        headTreeSha: TREE,
        changedFiles: [expect.objectContaining({
          path: "src/widget.ts",
          blobSha: "e".repeat(40),
          headRanges: [{ startLine: 3, endLine: 4 }],
        })],
      }),
    });
    expect(mocks.compileAndRecordAcceptanceContextPack).toHaveBeenCalledTimes(1);
    expect(mocks.queueSelectedCorrectionDispatch).toHaveBeenCalledTimes(1);
  });

  it("stops before credentials when no selected native route exists", async () => {
    mocks.readAcceptanceBuilderRouteSelection.mockResolvedValue(null);
    await expect(produceAndRunGithubCorrectionDispatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).resolves.toEqual({ kind: "not_ready", reason: "missing_selected_github_route" });
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
    expect(mocks.readExactHeadGithubContext).not.toHaveBeenCalled();
  });

  it("rejects a stale local or remote head before persistence", async () => {
    mocks.readChangeRecordTimelineByPr.mockResolvedValueOnce({
      record: {
        id: RECORD_ID,
        currentPrHeadAuthoritative: true,
        currentPrHeadSha: "9".repeat(40),
        currentPrHeadCycleId: JOB_ID,
      },
      events: [],
    });
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "not_current" });
    expect(mocks.readExactHeadGithubContext).not.toHaveBeenCalled();

    mocks.readExactHeadGithubContext.mockResolvedValueOnce({
      ok: false,
      kind: "not_proven",
      reason: "head_mismatch",
    });
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "not_current" });
    expect(mocks.recordAcceptanceContextPackSnapshot).not.toHaveBeenCalled();
  });

  it("admits metadata but never compiles or queues when exact source materialization fails", async () => {
    mocks.materializeExactHeadGithubContent.mockResolvedValue({
      ok: false,
      kind: "not_proven",
      reason: "invalid_blob",
      exclusions: [],
    });
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "not_proven", stage: "exact_content" });
    expect(mocks.recordAcceptanceContextPackSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAcceptanceContextPackCustody).toHaveBeenCalledTimes(2);
    expect(mocks.compileAndRecordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(mocks.queueSelectedCorrectionDispatch).not.toHaveBeenCalled();
  });

  it("never queues when Pack compilation is not proven", async () => {
    mocks.compileAndRecordAcceptanceContextPack.mockResolvedValue({
      ok: false,
      reason: "source_custody_mismatch",
    });
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "not_proven", stage: "pack_compilation" });
    expect(mocks.queueSelectedCorrectionDispatch).not.toHaveBeenCalled();
    expect(mocks.runGithubCorrectionCarrier).not.toHaveBeenCalled();
  });

  it("holds storage failures without attempting a carrier write", async () => {
    mocks.recordAcceptanceContextPackSnapshot.mockRejectedValue(new Error("database unavailable"));
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "held", reason: "storage_unavailable" });
    expect(mocks.queueSelectedCorrectionDispatch).not.toHaveBeenCalled();
    expect(mocks.runGithubCorrectionCarrier).not.toHaveBeenCalled();
  });

  it("rejects route drift between selection and queue", async () => {
    mocks.queueSelectedCorrectionDispatch.mockResolvedValue({
      dispatch: { id: DISPATCH_ID, routeAdapter: "github_claude" },
      inserted: true,
    });
    await expect(produceAndRunGithubCorrectionDispatch({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }))
      .resolves.toEqual({ kind: "not_current" });
    expect(mocks.runGithubCorrectionCarrier).not.toHaveBeenCalled();
  });
});
