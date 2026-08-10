import { describe, expect, it } from "vitest";
import {
  acceptanceContextBaseIndexRevisionSha256,
  acceptanceContextOverlayManifestSha256,
  acceptanceContextPacketSetSha256,
  parseAcceptanceContextPackSnapshotInput,
  reviewJobCorrectionPacketId,
  validateAcceptanceContextPackSnapshotInput,
  validateReviewJobCorrectionPacketPayload,
} from "./change_records.js";

const SHA = "a".repeat(40);
const packetId = "correction-" + "c".repeat(48);
const packetIds = [packetId];
const baseIndexCore = {
  schemaVersion: 1 as const,
  backgroundOnly: true as const,
  pages: [{
    id: "00000000-0000-4000-8000-000000000005",
    slug: "wiki/overview",
    commitSha: "1".repeat(40),
    inputsHashSha256: "3".repeat(64),
    stale: false,
  }],
  gaps: [],
};
const overlayCore = {
  schemaVersion: 1 as const,
  baseSha: "d".repeat(40),
  mergeBaseSha: "9".repeat(40),
  headSha: SHA,
  files: [{ path: "apps/console/page.tsx", status: "modified" as const, blobSha: "4".repeat(40), previousPath: null }],
};

const admitted = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  recordId: "00000000-0000-4000-8000-000000000002",
  reviewJobId: "00000000-0000-4000-8000-000000000003",
  acceptanceContractId: "00000000-0000-4000-8000-000000000004",
  acceptanceContractVersion: 2,
  repo: "acme/widgets",
  prNumber: 42,
  expectedHeadSha: SHA,
  baseSha: overlayCore.baseSha,
  mergeBaseSha: overlayCore.mergeBaseSha,
  headTreeSha: "e".repeat(40),
  packetIds,
  packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
  compilerVersion: "exact-head-overlay-v1",
  baseIndex: { ...baseIndexCore, revisionSha256: acceptanceContextBaseIndexRevisionSha256(baseIndexCore) },
  overlay: { ...overlayCore, manifestSha256: acceptanceContextOverlayManifestSha256(overlayCore) },
  provenance: {
    schemaVersion: 1,
    included: [
      { path: "wiki/overview", source: "base_index", reason: "Background Wiki page" },
      { path: "apps/console/page.tsx", source: "overlay", reason: "PR changed file" },
    ],
    excluded: [],
  },
  status: "admitted",
  reason: null,
};

const correctionPacket = {
  kind: "review_job_correction_packet",
  version: 1,
  packetId: reviewJobCorrectionPacketId({
    jobId: admitted.reviewJobId,
    criterionId: "AC-1",
    headSha: admitted.expectedHeadSha,
    recordId: admitted.recordId,
    acceptanceContractId: admitted.acceptanceContractId,
    acceptanceContractVersion: admitted.acceptanceContractVersion,
  }),
  workspaceId: admitted.workspaceId,
  repo: admitted.repo,
  prNumber: admitted.prNumber,
  headSha: admitted.expectedHeadSha,
  recordId: admitted.recordId,
  jobId: admitted.reviewJobId,
  acceptanceContract: { id: admitted.acceptanceContractId, version: admitted.acceptanceContractVersion },
  criterion: { id: "AC-1", snapshot: "Health returns OK." },
  basis: "acceptance_contract",
  state: "failed",
  expected: "Health returns OK.",
  observed: "The exact-head endpoint returned HTTP 503.",
  affectedContext: {
    modality: "api",
    environmentKind: "isolated_preview",
    flow: "Read the health endpoint.",
    reproduction: { modality: "api", request: { method: "GET", path: "/health", expectedStatus: 200 } },
  },
  evidence: {
    evidenceRef: "api-execution:execution-1",
    artifactKey: "review/api/execution-1.json",
    executionId: "execution-1",
    previewBootId: "preview-boot-1",
  },
  scopeBoundary: "Only AC-1 at the bound exact head.",
  impact: "The server-attested API receipt shows the confirmed criterion failed.",
  requiredCorrection: "Make the safe GET return the planned HTTP status.",
  reverification: "Rerun the persisted API plan against the next exact head.",
};

describe("Acceptance exact-head Context Pack snapshot input", () => {
  it("accepts a bounded immutable admitted snapshot with exact GitHub compare provenance", () => {
    expect(validateAcceptanceContextPackSnapshotInput(admitted)).toBe(true);
    expect(parseAcceptanceContextPackSnapshotInput(admitted)).toEqual(admitted);
  });

  it("records unavailable source identity as not_proven instead of inventing an overlay", () => {
    const unavailable = {
      ...admitted, baseSha: null, mergeBaseSha: null, headTreeSha: null, baseIndex: null, overlay: null,
      provenance: { schemaVersion: 1, included: [], excluded: [{ path: null, source: "overlay", reason: "GitHub compare unavailable" }] },
      status: "not_proven", reason: "GitHub compare unavailable",
    };
    expect(parseAcceptanceContextPackSnapshotInput(unavailable)).toEqual(unavailable);
  });

  it("allows an explicit empty Wiki background gap without treating it as exact-head source", () => {
    const core = { ...baseIndexCore, pages: [], gaps: ["No compiled Wiki pages exist for this repository"] };
    const withWikiGap = {
      ...admitted,
      baseIndex: { ...core, revisionSha256: acceptanceContextBaseIndexRevisionSha256(core) },
      provenance: {
        schemaVersion: 1,
        included: [{ path: "apps/console/page.tsx", source: "overlay", reason: "PR changed file" }],
        excluded: [{ path: null, source: "base_index", reason: core.gaps[0] }],
      },
    };
    expect(validateAcceptanceContextPackSnapshotInput(withWikiGap)).toBe(true);
  });

  it.each([
    { ...admitted, provenance: { ...admitted.provenance, included: admitted.provenance.included.slice(1) } },
    { ...admitted, provenance: { ...admitted.provenance, included: [
      ...admitted.provenance.included,
      { path: "unknown.ts", source: "overlay", reason: "invented" },
    ] } },
    { ...admitted, provenance: { ...admitted.provenance, excluded: [
      { path: "apps/console/page.tsx", source: "overlay", reason: "duplicate" },
    ] } },
  ])("rejects incomplete, invented, or duplicate source provenance", (input) => {
    expect(validateAcceptanceContextPackSnapshotInput(input)).toBe(false);
  });

  it("rejects a renamed compare file without a distinct previous path even when its manifest hash is canonical", () => {
    const core = {
      ...overlayCore,
      files: [{ path: "new.ts", status: "renamed" as const, blobSha: "4".repeat(40), previousPath: null }],
    };
    const invalidRenamed = { ...admitted, overlay: { ...core, manifestSha256: acceptanceContextOverlayManifestSha256(core) } };
    expect(validateAcceptanceContextPackSnapshotInput(invalidRenamed)).toBe(false);
  });

  it("rejects a raw Wiki input hash even when the enclosing revision hash is canonical", () => {
    const core = {
      ...baseIndexCore,
      pages: [{ ...baseIndexCore.pages[0]!, inputsHashSha256: "sha256:deadbeef" }],
    };
    const invalidPageHash = { ...admitted, baseIndex: { ...core, revisionSha256: acceptanceContextBaseIndexRevisionSha256(core) } };
    expect(validateAcceptanceContextPackSnapshotInput(invalidPageHash)).toBe(false);
  });

  it.each([
    { ...admitted, expectedHeadSha: "short" },
    { ...admitted, packetSetSha256: "b".repeat(64) },
    { ...admitted, baseIndex: { ...admitted.baseIndex, revisionSha256: "b".repeat(64) } },
    { ...admitted, overlay: { ...admitted.overlay, manifestSha256: "b".repeat(64) } },
    { ...admitted, baseSha: null },
    { ...admitted, mergeBaseSha: null },
    { ...admitted, overlay: { ...admitted.overlay, files: [] } },
    { ...admitted, packetIds: [packetId, packetId] },
    { ...admitted, repo: "./widgets" },
    { ...admitted, provenance: { ...admitted.provenance, included: [{ path: "../secret", source: "overlay", reason: "bad" }] } },
    { ...admitted, provenance: { ...admitted.provenance, included: [{ path: "safe\\..\\secret", source: "overlay", reason: "bad" }] } },
    { ...admitted, provenance: { ...admitted.provenance, included: [{ path: "safe.ts", source: "overlay", reason: "Bearer ghp_secret" }] } },
    { ...admitted, provenance: { schemaVersion: 1, included: [], excluded: [{ path: "../secret", source: "overlay", reason: "bad" }] } },
    { ...admitted, provenance: { schemaVersion: 1, included: [], excluded: [{ path: null, source: "overlay", reason: "Bearer ghp_secret" }] } },
    { ...admitted, extra: "not accepted" },
  ])("fails closed for malformed, widened, tampered, or secret-bearing input", (input) => {
    expect(validateAcceptanceContextPackSnapshotInput(input)).toBe(false);
    expect(parseAcceptanceContextPackSnapshotInput(input)).toBeNull();
  });
});

describe("R8.1 correction packet identity reused by Context Pack custody", () => {
  it("accepts the closed packet envelope and its canonical deterministic identity", () => {
    expect(validateReviewJobCorrectionPacketPayload(correctionPacket)).toBe(true);
    expect(correctionPacket.packetId).toMatch(/^correction-[a-f0-9]{48}$/);
  });

  it.each([
    {},
    {
      kind: "review_job_correction_packet", version: 1, packetId: correctionPacket.packetId,
      workspaceId: correctionPacket.workspaceId, repo: correctionPacket.repo,
    },
    { ...correctionPacket, packetId: "correction-" + "f".repeat(48) },
    { ...correctionPacket, criterion: { ...correctionPacket.criterion, id: "AC-OTHER" } },
    { ...correctionPacket, affectedContext: {
      ...correctionPacket.affectedContext,
      reproduction: { modality: "api", request: { method: "POST", path: "/health", expectedStatus: 200 } },
    } },
    { ...correctionPacket, observed: "Bearer ghp_secret" },
    { ...correctionPacket, extra: "widened" },
  ])("rejects a partial, forged, widened, or secret-bearing packet envelope", (packet) => {
    expect(validateReviewJobCorrectionPacketPayload(packet)).toBe(false);
  });
});
