import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  acceptanceContextPacketSetSha256,
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  acceptanceContextOverlayManifestSha256,
  reviewJobCorrectionPacketId,
  wikiPageBodySha256,
  type AcceptanceConfirmedContractProjection,
  type AcceptanceContextPackCustodyResolution,
} from "@agentrail/db-postgres";
import {
  ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET,
  ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER,
  compileAcceptanceContextPack,
  searchAcceptanceContextPackSources,
} from "./acceptance-context-pack-compiler";
import { exactHeadGitBlobSha1 } from "./acceptance-context-pack-source-custody";
import {
  exactHeadContentMaterializationIdentity,
  type ExactHeadContentReadResult,
  type ExactHeadContentRecord,
} from "./github-exact-head-content";
import {
  exactHeadContextCustodyOverlay,
  type ExactHeadGithubContextSnapshot,
} from "./github-exact-head-context";
import type { ReviewJobCorrectionPacket } from "./review-job-correction-packet";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const RECORD = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000004";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000005";
const PAGE_ID = "00000000-0000-4000-8000-000000000006";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000007";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const WIKI_COMMIT = "1".repeat(40);
const INPUTS_HASH = "2".repeat(64);
const PATCH = "@@ -3,2 +3,2 @@\n export function widget(value: string) {\n-  return value;\n+  return helper(value);";
const WIDGET = [
  'import { helper } from "./helper";',
  "",
  "export function widget(value: string) {",
  "  return helper(value);",
  "}",
].join("\n");
const HELPER = [
  "export function helper(value: string) {",
  "  return value.trim();",
  "}",
].join("\n");
const WIKI_BODY = "# Widget architecture\n\nThe widget delegates normalization to the helper module.";
const WIDGET_BLOB = exactHeadGitBlobSha1(WIDGET);
const HELPER_BLOB = exactHeadGitBlobSha1(HELPER);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function packetId(): string {
  return reviewJobCorrectionPacketId({
    jobId: JOB,
    criterionId: "AC-1",
    headSha: HEAD,
    recordId: RECORD,
    acceptanceContractId: CONTRACT_ID,
    acceptanceContractVersion: 2,
  });
}

function packet(overrides: Partial<ReviewJobCorrectionPacket> = {}): ReviewJobCorrectionPacket {
  return {
    kind: "review_job_correction_packet",
    version: 1,
    packetId: packetId(),
    workspaceId: WORKSPACE,
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    recordId: RECORD,
    jobId: JOB,
    acceptanceContract: { id: CONTRACT_ID, version: 2 },
    criterion: { id: "AC-1", snapshot: "A widget trims its value." },
    basis: "acceptance_contract",
    state: "failed",
    expected: "A widget trims its value.",
    observed: "The exact-head widget returned an untrimmed value.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Open the widget, enter a padded value, and inspect the result.",
      reproduction: {
        modality: "ui",
        steps: [
          { action: "open", path: "/widget" },
          { action: "expect_text", text: "trimmed" },
          { action: "screenshot", label: "widget-result" },
        ],
      },
    },
    evidence: {
      evidenceRef: "ui-execution:execution-1",
      artifactKey: "review/ui/execution-1.png",
      executionId: "execution-1",
      previewBootId: "preview-boot-1",
    },
    scopeBoundary: "Only AC-1 for acme/widgets#42 at the bound exact head.",
    impact: "The exact-head UI receipt shows that trimming failed.",
    requiredCorrection: "Make the widget use the trimming helper.",
    reverification: "Rerun the persisted UI flow on the next exact head.",
    ...overrides,
  };
}

function contract(overrides: Partial<AcceptanceConfirmedContractProjection> = {}): AcceptanceConfirmedContractProjection {
  return {
    originalRequest: "Make widgets normalize their displayed values.",
    normalizedRequirements: ["Trim widget values before display."],
    acceptanceCriteria: [
      { id: "AC-1", text: "A widget trims its value.", userVisible: true, modality: "ui" },
      { id: "AC-2", text: "The existing widget contract remains compatible.", userVisible: false, modality: "api" },
    ],
    nonGoals: ["Do not redesign unrelated controls."],
    risks: ["Whitespace behavior can regress."],
    stops: ["Stop if exact-head source is unavailable."],
    environment: { preview: "isolated", runtime: "node" },
    unresolvedQuestions: [{ id: "Q-1", text: "Should tabs be normalized later?" }],
    ...overrides,
  };
}

function contractAsRecord(value: AcceptanceConfirmedContractProjection): Record<string, unknown> {
  return {
    originalRequest: value.originalRequest,
    normalizedRequirements: value.normalizedRequirements,
    acceptanceCriteria: value.acceptanceCriteria,
    nonGoals: value.nonGoals,
    risks: value.risks,
    stops: value.stops,
    environment: value.environment,
    unresolvedQuestions: value.unresolvedQuestions,
  };
}

function snapshot(changedFiles: ExactHeadGithubContextSnapshot["changedFiles"] = [{
  path: "src/widget.ts",
  status: "modified",
  blobSha: WIDGET_BLOB,
  previousPath: null,
  headRanges: [{ startLine: 3, endLine: 4 }],
  patchSha256: hash(PATCH),
  patchByteCount: Buffer.byteLength(PATCH),
}]): ExactHeadGithubContextSnapshot {
  const manifestFiles = changedFiles.map(({ path, status, blobSha, previousPath }) => ({
    path,
    status: status as "modified",
    blobSha,
    previousPath,
  }));
  return {
    repo: "acme/widgets",
    prNumber: 42,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    headTreeSha: TREE,
    changedFiles,
    manifestSha256: acceptanceContextOverlayManifestSha256({
      schemaVersion: 1,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
      files: manifestFiles,
    }),
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

function custody(exact = snapshot(), options: {
  contract?: AcceptanceConfirmedContractProjection;
  packets?: Record<string, unknown>[];
  staleWiki?: boolean;
} = {}): AcceptanceContextPackCustodyResolution {
  const confirmed = options.contract ?? contract();
  const packets = options.packets ?? [packet() as unknown as Record<string, unknown>];
  const packetIds = packets.map((value) => String(value["packetId"])).sort();
  const baseCore = {
    schemaVersion: 2 as const,
    backgroundOnly: true as const,
    pages: [{
      id: PAGE_ID,
      repositoryId: REPOSITORY_ID,
      slug: "wiki/overview",
      commitSha: WIKI_COMMIT,
      inputsHashSha256: INPUTS_HASH,
      pageBodySha256: wikiPageBodySha256(WIKI_BODY),
      stale: options.staleWiki ?? false,
    }],
    gaps: [],
  };
  const overlay = exactHeadContextCustodyOverlay(exact);
  if (!overlay) throw new Error("fixture exact-head overlay is invalid");
  const packetPayloadHash = acceptanceCorrectionPacketPayloadSetSha256({ packets });
  return {
    sourceSnapshot: {
      id: SNAPSHOT_ID,
      workspaceId: WORKSPACE,
      recordId: RECORD,
      reviewJobId: JOB,
      acceptanceContractId: CONTRACT_ID,
      acceptanceContractVersion: 2,
      repo: "acme/widgets",
      prNumber: 42,
      expectedHeadSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headTreeSha: TREE,
      packetIds,
      packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
      correctionPacketPayloadSetSha256: packetPayloadHash,
      compilerVersion: "exact-head-overlay-v2",
      baseIndex: {
        ...baseCore,
        revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseCore),
      },
      overlay,
      provenance: {
        schemaVersion: 1,
        included: [
          { path: "wiki/overview", source: "base_index", reason: "Background Wiki page" },
          ...exact.changedFiles.map(({ path }) => ({ path, source: "overlay" as const, reason: "PR changed file" })),
        ],
        excluded: [],
      },
    },
    contract: confirmed,
    acceptanceContractSha256: acceptanceContractSha256({
      acceptanceContractId: CONTRACT_ID,
      acceptanceContractVersion: 2,
      contract: contractAsRecord(confirmed),
    }),
    correctionPackets: packets,
    correctionPacketPayloadSetSha256: packetPayloadHash,
    wikiPages: [{
      id: PAGE_ID,
      repositoryId: REPOSITORY_ID,
      slug: "wiki/overview",
      commitSha: WIKI_COMMIT,
      inputsHashSha256: INPUTS_HASH,
      pageBodySha256: wikiPageBodySha256(WIKI_BODY),
      stale: options.staleWiki ?? false,
      bodyMd: WIKI_BODY,
    }],
  };
}

function contentRecord(
  filePath: string,
  content: string,
  source: ExactHeadContentRecord["source"],
): ExactHeadContentRecord {
  return {
    path: filePath,
    blobSha: exactHeadGitBlobSha1(content),
    previousPath: null,
    contentSha256: hash(content),
    byteCount: Buffer.byteLength(content),
    lineCount: content.split("\n").length,
    content,
    source,
    reason: source === "exact_head_overlay" ? "exact_base_to_head_compare" : "exact_head_tree_path",
  };
}

function materialization(exact = snapshot(), overrides: {
  identity?: string;
  dependency?: ExactHeadContentRecord;
  changedContent?: string;
  read?: (candidate: string) => Promise<ExactHeadContentReadResult>;
} = {}) {
  const changed = contentRecord("src/widget.ts", overrides.changedContent ?? WIDGET, "exact_head_overlay");
  const dependency = overrides.dependency ?? contentRecord("src/helper.ts", HELPER, "exact_head_tree_fallback");
  const readExactPath = vi.fn(overrides.read ?? (async (candidate: string): Promise<ExactHeadContentReadResult> =>
    candidate === dependency.path
      ? { ok: true, record: dependency }
      : { ok: false, kind: "not_proven", reason: "path_not_found" }
  ));
  const records = [changed];
  const exclusions: never[] = [];
  return {
    content: {
      identitySha256: overrides.identity ?? exactHeadContentMaterializationIdentity({ snapshot: exact, records, exclusions }),
      headTreeSha: TREE,
      records,
      exclusions,
    },
    readExactPath,
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]));
}

describe("compileAcceptanceContextPack", () => {
  it("compiles exact patch ranges, one-hop dependencies, and bound Wiki background with a source receipt", async () => {
    const exact = snapshot();
    const result = await compileAcceptanceContextPack({
      custody: custody(exact),
      snapshot: exact,
      materialization: materialization(exact),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.manifest.acceptanceCriterionIds).toEqual(["AC-1", "AC-2"]);
    expect(result.compiled.manifest.unresolvedQuestionIds).toEqual(["Q-1"]);
    expect(result.compiled.manifest.packetIds).toEqual([packetId()]);
    expect(result.compiled.manifest.sources.map((source) => source.kind).sort()).toEqual([
      "base_index_background",
      "exact_head_dependency",
      "exact_head_overlay",
    ]);
    expect(result.compiled.manifest.sources.find((source) => source.kind === "exact_head_overlay")).toMatchObject({
      path: "src/widget.ts",
      blobSha: WIDGET_BLOB,
      fullContentSha256: hash(WIDGET),
      startLine: 3,
      endLine: 4,
    });
    expect(result.compiled.manifest.sources.find((source) => source.kind === "exact_head_dependency")).toMatchObject({
      path: "src/helper.ts",
      blobSha: HELPER_BLOB,
    });
    expect(result.compiled.manifest.sources.find((source) => source.kind === "base_index_background")).toMatchObject({
      pageId: PAGE_ID,
      pageBodySha256: hash(WIKI_BODY),
      stale: false,
      reason: "background_only",
    });
    expect(result.compiled.sourceCustodyReceipt.directReadReceipts).toEqual([
      expect.objectContaining({ requestedPath: "src/helper.ts", outcome: "record" }),
    ]);
    expect(result.compiled.manifest.sourceCustody.identitySha256).toBe(result.compiled.sourceCustodyReceipt.identitySha256);
    expect(result.compiled.compiler.byteCounter).toBe(ACCEPTANCE_CONTEXT_PACK_BYTE_COUNTER);
    expect(result.compiled.renderedByteCount).toBeLessThanOrEqual(ACCEPTANCE_CONTEXT_PACK_BYTE_BUDGET);
    expect(result.compiled.representations).toEqual({
      jsonSha256: hash(result.rendered.json),
      markdownSha256: hash(result.rendered.markdown),
    });
    expect(result.rendered.markdown).toContain("# Acceptance Context Pack");
    expect(result.rendered.json).toContain("Make widgets normalize their displayed values.");
    expect(JSON.stringify(result.compiled.manifest)).not.toContain(WIDGET);
    expect(JSON.stringify(result.compiled.manifest)).not.toContain(HELPER);
    expect(searchAcceptanceContextPackSources({ rendered: result.rendered, query: "helper" })).not.toEqual([]);
  });

  it("is byte-deterministic when packet object properties are constructed in another order", async () => {
    const exact = snapshot();
    const first = await compileAcceptanceContextPack({ custody: custody(exact), snapshot: exact, materialization: materialization(exact) });
    const reorderedPacket = reverseObjectKeys(packet()) as Record<string, unknown>;
    const second = await compileAcceptanceContextPack({
      custody: custody(exact, { packets: [reorderedPacket] }),
      snapshot: exact,
      materialization: materialization(exact),
    });
    expect(first.ok && second.ok ? second.compiled.packSha256 : null).toBe(first.ok ? first.compiled.packSha256 : null);
    expect(first.ok && second.ok ? second.rendered.json : null).toBe(first.ok ? first.rendered.json : null);
    expect(first.ok && second.ok ? second.rendered.markdown : null).toBe(first.ok ? first.rendered.markdown : null);
  });

  it.each([
    {
      name: "Contract hash",
      mutate: (value: AcceptanceContextPackCustodyResolution) => ({ ...value, acceptanceContractSha256: "9".repeat(64) }),
      reason: "contract_mismatch",
    },
    {
      name: "packet payload",
      mutate: (value: AcceptanceContextPackCustodyResolution) => ({
        ...value,
        correctionPackets: [{ ...value.correctionPackets[0], observed: "A forged observation." }],
      }),
      reason: "correction_packet_mismatch",
    },
    {
      name: "workspace",
      mutate: (value: AcceptanceContextPackCustodyResolution) => ({
        ...value,
        sourceSnapshot: { ...value.sourceSnapshot, workspaceId: "00000000-0000-4000-8000-000000000099" },
      }),
      reason: "correction_packet_mismatch",
    },
    {
      name: "exact head",
      mutate: (value: AcceptanceContextPackCustodyResolution) => ({
        ...value,
        sourceSnapshot: { ...value.sourceSnapshot, expectedHeadSha: "9".repeat(40) },
      }),
      reason: "source_snapshot_mismatch",
    },
    {
      name: "Wiki body",
      mutate: (value: AcceptanceContextPackCustodyResolution) => ({
        ...value,
        wikiPages: [{ ...value.wikiPages[0]!, bodyMd: "A caller-forged Wiki body." }],
      }),
      reason: "source_snapshot_mismatch",
    },
  ])("fails closed for a mismatched $name", async ({ mutate, reason }) => {
    const exact = snapshot();
    await expect(compileAcceptanceContextPack({
      custody: mutate(custody(exact)),
      snapshot: exact,
      materialization: materialization(exact),
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason });
  });

  it("rejects a forged materialization identity and a forged dependency Git blob", async () => {
    const exact = snapshot();
    await expect(compileAcceptanceContextPack({
      custody: custody(exact),
      snapshot: exact,
      materialization: materialization(exact, { identity: "9".repeat(64) }),
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "materialization_mismatch" });

    const forgedDependency = { ...contentRecord("src/helper.ts", HELPER, "exact_head_tree_fallback"), blobSha: "f".repeat(40) };
    await expect(compileAcceptanceContextPack({
      custody: custody(exact),
      snapshot: exact,
      materialization: materialization(exact, { dependency: forgedDependency }),
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "source_custody_mismatch" });
  });

  it("records a stale Wiki as background exclusion and never succeeds from Wiki alone", async () => {
    const exact = snapshot();
    const stale = await compileAcceptanceContextPack({
      custody: custody(exact, { staleWiki: true }),
      snapshot: exact,
      materialization: materialization(exact),
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) {
      expect(stale.compiled.manifest.sources.some((source) => source.kind === "base_index_background")).toBe(false);
      expect(stale.compiled.manifest.exclusions).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "base_index_background", reason: "base_index_stale" }),
      ]));
    }

    const withoutPatch = snapshot([{
      path: "src/widget.ts",
      status: "modified",
      blobSha: WIDGET_BLOB,
      previousPath: null,
      headRanges: null,
      patchSha256: null,
      patchByteCount: null,
    }]);
    await expect(compileAcceptanceContextPack({
      custody: custody(withoutPatch),
      snapshot: withoutPatch,
      materialization: materialization(withoutPatch),
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "no_exact_head_context" });
  });

  it("does not resolve bare packages or computed imports through an alternate source", async () => {
    const unsafe = [
      'import react from "react";',
      "const target = './helper';",
      "import(target);",
      "export function widget() { return react; }",
    ].join("\n");
    const unsafeBlob = exactHeadGitBlobSha1(unsafe);
    const exact = snapshot([{
      path: "src/widget.ts",
      status: "modified",
      blobSha: unsafeBlob,
      previousPath: null,
      headRanges: [{ startLine: 1, endLine: 4 }],
      patchSha256: hash(PATCH),
      patchByteCount: Buffer.byteLength(PATCH),
    }]);
    const source = materialization(exact, { changedContent: unsafe });
    const result = await compileAcceptanceContextPack({ custody: custody(exact), snapshot: exact, materialization: source });
    expect(result.ok).toBe(true);
    expect(source.readExactPath).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.compiled.manifest.exclusions).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "exact_head_dependency", reason: "unsupported_dependency_expression" }),
      ]));
    }
  });

  it("uses an honest byte budget and refuses a base payload that cannot fit", async () => {
    const exact = snapshot();
    const oversized = contract({
      normalizedRequirements: Array.from({ length: 40 }, (_, index) => `${index}:${"x".repeat(1800)}`),
    });
    await expect(compileAcceptanceContextPack({
      custody: custody(exact, { contract: oversized }),
      snapshot: exact,
      materialization: materialization(exact),
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "pack_budget" });
  });
});
