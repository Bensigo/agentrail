import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceContextPackCanonicalJson,
  acceptanceContextPackCanonicalSha256,
  validateAcceptanceCompiledContextPackInput,
  validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs,
  validateAcceptanceCompiledContextPackExactSourceProofs,
} from "../queries/change_records.js";
import {
  exactGitTreeInclusionProofIdentity,
  type ExactGitTreeInclusionProof,
} from "../exact-git-tree-path-proof.js";

const SOURCE_CONTENT = "x";
const SOURCE_BYTES = Buffer.from(SOURCE_CONTENT, "utf8");
const SOURCE_BLOB_SHA = createHash("sha1").update(`blob ${SOURCE_BYTES.length}\0`, "utf8").update(SOURCE_BYTES).digest("hex");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");

function compiledMetadata() {
  const source = {
    kind: "exact_head_overlay" as const,
    path: "apps/file.ts",
    blobSha: SOURCE_BLOB_SHA,
    fullContentSha256: SOURCE_SHA256,
    startLine: 1,
    endLine: 1,
    rangeSha256: SOURCE_SHA256,
    byteCount: 1,
    reason: "exact_patch_head_range",
    citation: `apps/file.ts@${SOURCE_BLOB_SHA}#L1-L1`,
  };
  const receipt = {
    kind: "exact_head_source_custody" as const, schemaVersion: 2 as const, repo: "acme/widgets", prNumber: 1,
    baseSha: "a".repeat(40), mergeBaseSha: "b".repeat(40), headSha: "c".repeat(40), headTreeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
    changedManifest: [{ path: "apps/file.ts", status: "modified", blobSha: SOURCE_BLOB_SHA, previousPath: null, headRanges: [{ startLine: 1, endLine: 1 }], patchSha256: "1".repeat(64), patchByteCount: 1 }],
    records: [{ path: source.path, blobSha: source.blobSha, previousPath: null, contentSha256: source.fullContentSha256, byteCount: 1, lineCount: 1, source: "exact_head_overlay", reason: "exact_base_to_head_compare" }],
    exclusions: [], directReadReceipts: [],
    selectedExactRanges: [((({ reason: _reason, citation: _citation, ...range }) => range)(source))],
    identitySha256: "2".repeat(64),
  };
  return {
    kind: "compiled_acceptance_context_pack" as const, version: 1 as const,
    binding: { sourceSnapshotId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", recordId: "00000000-0000-4000-8000-000000000003", reviewJobId: "00000000-0000-4000-8000-000000000004", acceptanceContractId: "00000000-0000-4000-8000-000000000005", acceptanceContractVersion: 1, acceptanceContractSha256: "3".repeat(64), repo: "acme/widgets", prNumber: 1, baseSha: "a".repeat(40), mergeBaseSha: "b".repeat(40), headSha: "c".repeat(40), headTreeSha: "d".repeat(40), packetSetSha256: "4".repeat(64), correctionPacketPayloadSetSha256: "5".repeat(64), sourceSnapshotCompilerVersion: "snapshot-v1", baseIndexRevisionSha256: "6".repeat(64), overlayManifestSha256: "7".repeat(64) },
    compiler: { version: "exact-head-correction-pack-v4", policyVersion: "bounded-exact-ranges-v2", byteCounter: "utf8_byte_upper_bound_v1", byteBudget: 65536 },
    manifest: { version: 1, acceptanceCriterionIds: [], unresolvedQuestionIds: [], packetIds: [], sources: [source], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], sourceCustody: { kind: "exact_head_source_custody", schemaVersion: 2, identitySha256: receipt.identitySha256 }, budget: { counter: "utf8_byte_upper_bound_v1", limitBytes: 65536 }, custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false } },
    sourceCustodyReceipt: receipt, exactHeadDependencyTreeProofs: [], representations: { jsonSha256: "8".repeat(64), markdownSha256: "9".repeat(64) }, renderedByteCount: 1, packSha256: "a".repeat(64),
  };
}

describe("compiled Context Pack canonical custody", () => {
  it("is invariant to object insertion order and sorts keys by UTF-8 bytes", () => {
    const first = { z: { "é": 1, a: [true, null] }, a: "x" };
    const second = { a: "x", z: { a: [true, null], "é": 1 } };
    expect(acceptanceContextPackCanonicalJson(first)).toBe('{"a":"x","z":{"a":[true,null],"é":1}}');
    expect(acceptanceContextPackCanonicalSha256(first)).toBe(acceptanceContextPackCanonicalSha256(second));
  });

  it("rejects non-JSON values instead of silently changing a receipt identity", () => {
    expect(() => acceptanceContextPackCanonicalJson({ value: undefined })).toThrow("cannot encode undefined");
    expect(() => acceptanceContextPackCanonicalJson({ value: Number.NaN })).toThrow("non-finite");
  });

  it("rejects raw/URL metadata, malformed manifest exclusions, and unvalidated direct-read exclusions", () => {
    const valid = compiledMetadata();
    expect(validateAcceptanceCompiledContextPackInput(valid)).toBe(true);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid, manifest: { ...valid.manifest, architectureBoundaries: ["https://github.example/raw"] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid, manifest: { ...valid.manifest, exclusions: [{ source: "exact_head_overlay", path: "apps/file.ts", reason: "skip", content: "raw" }] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid, sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, directReadReceipts: [{ requestedPath: "lib/unsafe.ts", headSha: "c".repeat(40), headTreeSha: "d".repeat(40), outcome: "not_proven", reason: "secret", exclusion: { arbitrary: true } }] },
    })).toBe(false);
  });

  it("requires canonical bounded materialization records and a selected overlay source", () => {
    const valid = compiledMetadata();
    expect(validateAcceptanceCompiledContextPackInput(valid)).toBe(true);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        records: [{ ...valid.sourceCustodyReceipt.records[0], source: "exact_head_tree_fallback" }],
      },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      manifest: { ...valid.manifest, sources: [] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        selectedExactRanges: [{ ...valid.sourceCustodyReceipt.selectedExactRanges[0], kind: "exact_head_dependency" }],
      },
    })).toBe(false);
  });

  it("requires exact direct-read provenance, canonical ordering, and derived source grammar", () => {
    const valid = compiledMetadata();
    const fallbackRecord = {
      path: "lib/helper.ts", blobSha: "a".repeat(40), previousPath: null, contentSha256: "b".repeat(64),
      byteCount: 1, lineCount: 1, source: "exact_head_tree_fallback", reason: "exact_head_tree_path",
    };
    const directRead = {
      requestedPath: fallbackRecord.path, headSha: valid.sourceCustodyReceipt.headSha, headTreeSha: valid.sourceCustodyReceipt.headTreeSha,
      outcome: "record", record: fallbackRecord,
    };
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, directReadReceipts: [{ ...directRead, record: { ...fallbackRecord, source: "exact_head_overlay" } }] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, directReadReceipts: [{ ...directRead, record: { ...fallbackRecord, reason: "exact_base_to_head_compare" } }] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      manifest: { ...valid.manifest, sources: [{ ...valid.manifest.sources[0], citation: "arbitrary citation" }] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        records: [
          { ...valid.sourceCustodyReceipt.records[0], path: "z.ts" },
          valid.sourceCustodyReceipt.records[0],
        ],
      },
    })).toBe(false);
  });

  it("rejects source-custody file, aggregate, direct-read, and receipt-metadata cap overflows", () => {
    const valid = compiledMetadata();
    const overlayRecord = (path: string, byteCount: number) => ({
      ...valid.sourceCustodyReceipt.records[0], path, byteCount,
    });
    const fallbackRead = (requestedPath: string, byteCount: number) => ({
      requestedPath,
      headSha: valid.sourceCustodyReceipt.headSha,
      headTreeSha: valid.sourceCustodyReceipt.headTreeSha,
      outcome: "record" as const,
      record: {
        ...overlayRecord(requestedPath, byteCount),
        source: "exact_head_tree_fallback",
        reason: "exact_head_tree_path",
      },
    });
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, records: [overlayRecord("apps/file.ts", 256 * 1024 + 1)] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        records: Array.from({ length: 129 }, (_, index) => overlayRecord(`apps/${String(index).padStart(3, "0")}.ts`, 1)),
      },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        records: Array.from({ length: 5 }, (_, index) => overlayRecord(`apps/${String(index).padStart(3, "0")}.ts`, 256 * 1024)),
      },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, directReadReceipts: [fallbackRead("lib/one.ts", 256 * 1024 + 1)] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        directReadReceipts: Array.from({ length: 17 }, (_, index) => fallbackRead(`lib/${String(index).padStart(3, "0")}.ts`, 1)),
      },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        directReadReceipts: [fallbackRead("lib/one.ts", 256 * 1024), fallbackRead("lib/three.ts", 1), fallbackRead("lib/two.ts", 256 * 1024)],
      },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        records: [
          valid.sourceCustodyReceipt.records[0],
          ...Array.from({ length: 17 }, (_, index) => overlayRecord(`z/${String(index).padStart(2, "0")}-${"x".repeat(4_000)}.ts`, 1)),
        ],
      },
    })).toBe(false);
  });

  it("requires canonical source-custody exclusions, direct reads, and selected ranges", () => {
    const valid = compiledMetadata();
    const removed = (path: string) => ({
      path, source: "exact_head_overlay" as const, blobSha: null, byteCount: null,
      reason: "removed_at_exact_head", secretKinds: [], findingCount: 0,
    });
    const fallbackRead = (requestedPath: string) => ({
      requestedPath,
      headSha: valid.sourceCustodyReceipt.headSha,
      headTreeSha: valid.sourceCustodyReceipt.headTreeSha,
      outcome: "record" as const,
      record: {
        ...valid.sourceCustodyReceipt.records[0], path: requestedPath,
        source: "exact_head_tree_fallback", reason: "exact_head_tree_path",
      },
    });
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, exclusions: [removed("z.ts"), removed("a.ts")] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: { ...valid.sourceCustodyReceipt, directReadReceipts: [fallbackRead("z.ts"), fallbackRead("a.ts")] },
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackInput({
      ...valid,
      sourceCustodyReceipt: {
        ...valid.sourceCustodyReceipt,
        selectedExactRanges: [
          { ...valid.sourceCustodyReceipt.selectedExactRanges[0], path: "z.ts" },
          valid.sourceCustodyReceipt.selectedExactRanges[0],
        ],
      },
    })).toBe(false);
  });

  it("rederives selected Git blob, full-content, range, and byte identities from transient bytes", () => {
    const compiled = compiledMetadata();
    const exactSourceProofs = [{ kind: "exact_head_overlay" as const, path: "apps/file.ts", content: SOURCE_CONTENT }];
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({ compiled, exactSourceProofs })).toBe(true);
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({
      compiled,
      exactSourceProofs: [{ ...exactSourceProofs[0], content: "forged" }],
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({ compiled, exactSourceProofs: [] })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({
      compiled,
      exactSourceProofs: [...exactSourceProofs, { ...exactSourceProofs[0], path: "apps/extra.ts" }],
    })).toBe(false);
  });

  it("rederives dependency bytes instead of trusting a same-head direct-read receipt", () => {
    const compiled = compiledMetadata();
    const dependencyContent = "y";
    const dependencyBytes = Buffer.from(dependencyContent, "utf8");
    const dependencyBlobSha = createHash("sha1")
      .update(`blob ${dependencyBytes.length}\0`, "utf8").update(dependencyBytes).digest("hex");
    const dependencySha256 = createHash("sha256").update(dependencyBytes).digest("hex");
    const dependency = {
      kind: "exact_head_dependency" as const,
      path: "lib/helper.ts",
      blobSha: dependencyBlobSha,
      fullContentSha256: dependencySha256,
      startLine: 1,
      endLine: 1,
      rangeSha256: dependencySha256,
      byteCount: 1,
      reason: "static_relative_import",
      citation: `lib/helper.ts@${dependencyBlobSha}#L1-L1`,
    };
    const dependencyRange = (({ reason: _reason, citation: _citation, ...range }) => range)(dependency);
    const withDependency = {
      ...compiled,
      manifest: { ...compiled.manifest, sources: [dependency, ...compiled.manifest.sources] },
      sourceCustodyReceipt: {
        ...compiled.sourceCustodyReceipt,
        directReadReceipts: [{
          requestedPath: dependency.path,
          headSha: compiled.sourceCustodyReceipt.headSha,
          headTreeSha: compiled.sourceCustodyReceipt.headTreeSha,
          outcome: "record" as const,
          record: {
            path: dependency.path,
            blobSha: dependencyBlobSha,
            previousPath: null,
            contentSha256: dependencySha256,
            byteCount: 1,
            lineCount: 1,
            source: "exact_head_tree_fallback",
            reason: "exact_head_tree_path",
          },
        }],
        selectedExactRanges: [dependencyRange, ...compiled.sourceCustodyReceipt.selectedExactRanges],
      },
    };
    const proofs = [
      { kind: "exact_head_dependency" as const, path: dependency.path, content: dependencyContent },
      { kind: "exact_head_overlay" as const, path: "apps/file.ts", content: SOURCE_CONTENT },
    ];
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({ compiled: withDependency, exactSourceProofs: proofs })).toBe(true);
    expect(validateAcceptanceCompiledContextPackExactSourceProofs({
      compiled: withDependency,
      exactSourceProofs: [{ ...proofs[0], content: "forged" }, proofs[1]],
    })).toBe(false);
  });

  it("requires one verified, head-bound native Git tree proof per selected dependency and persists only its identity", () => {
    const compiled = compiledMetadata();
    const dependencyContent = "y";
    const dependencyBytes = Buffer.from(dependencyContent, "utf8");
    const blobSha = createHash("sha1").update(`blob ${dependencyBytes.length}\0`, "utf8").update(dependencyBytes).digest("hex");
    const treeBody = Buffer.concat([Buffer.from("100644 helper.ts\0", "utf8"), Buffer.from(blobSha, "hex")]);
    const headTreeSha = createHash("sha1").update(`tree ${treeBody.length}\0`, "utf8").update(treeBody).digest("hex");
    const proof: ExactGitTreeInclusionProof = {
      kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha,
      trees: [{ sha1: headTreeSha, bodyBase64: treeBody.toString("base64") }],
      paths: [{ path: "helper.ts", blobSha }],
    };
    const dependency = {
      kind: "exact_head_dependency" as const, path: "helper.ts", blobSha,
      fullContentSha256: createHash("sha256").update(dependencyBytes).digest("hex"),
      startLine: 1, endLine: 1, rangeSha256: createHash("sha256").update(dependencyBytes).digest("hex"), byteCount: 1,
      reason: "static_relative_import", citation: `helper.ts@${blobSha}#L1-L1`,
    };
    const dependencyRange = (({ reason: _reason, citation: _citation, ...range }) => range)(dependency);
    const withDependency = {
      ...compiled,
      binding: { ...compiled.binding, headTreeSha },
      manifest: { ...compiled.manifest, sources: [dependency, ...compiled.manifest.sources] },
      sourceCustodyReceipt: {
        ...compiled.sourceCustodyReceipt, headTreeSha,
        directReadReceipts: [{
          requestedPath: dependency.path, headSha: compiled.sourceCustodyReceipt.headSha, headTreeSha, outcome: "record" as const,
          record: { path: dependency.path, blobSha, previousPath: null, contentSha256: dependency.fullContentSha256, byteCount: 1, lineCount: 1, source: "exact_head_tree_fallback", reason: "exact_head_tree_path" },
        }],
        selectedExactRanges: [dependencyRange, ...compiled.sourceCustodyReceipt.selectedExactRanges],
      },
      exactHeadDependencyTreeProofs: [{ path: dependency.path, blobSha, proofIdentitySha256: exactGitTreeInclusionProofIdentity(proof) }],
    };
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({ compiled: withDependency, exactGitTreeInclusionProofs: [proof] })).toBe(true);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({ compiled: withDependency, exactGitTreeInclusionProofs: [] })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({ compiled: withDependency, exactGitTreeInclusionProofs: [proof, proof] })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({
      compiled: withDependency,
      exactGitTreeInclusionProofs: [{ ...proof, headTreeSha: "f".repeat(40) }],
    })).toBe(false);
    const crossHeadBody = Buffer.concat([treeBody, Buffer.from("100644 sibling.ts\0", "utf8"), Buffer.from("f".repeat(40), "hex")]);
    const crossHeadSha = createHash("sha1").update(`tree ${crossHeadBody.length}\0`, "utf8").update(crossHeadBody).digest("hex");
    const crossHeadProof: ExactGitTreeInclusionProof = {
      ...proof, headTreeSha: crossHeadSha, trees: [{ sha1: crossHeadSha, bodyBase64: crossHeadBody.toString("base64") }],
    };
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({ compiled: withDependency, exactGitTreeInclusionProofs: [crossHeadProof] })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({
      compiled: withDependency,
      exactGitTreeInclusionProofs: [{ ...proof, trees: [{ ...proof.trees[0]!, bodyBase64: proof.trees[0]!.bodyBase64.slice(0, -4) }] }],
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({
      compiled: { ...withDependency, exactHeadDependencyTreeProofs: [{ ...withDependency.exactHeadDependencyTreeProofs[0], proofIdentitySha256: "0".repeat(64) }] },
      exactGitTreeInclusionProofs: [proof],
    })).toBe(false);
    expect(validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs({
      compiled: { ...withDependency, exactHeadDependencyTreeProofs: [...withDependency.exactHeadDependencyTreeProofs, { path: "extra.ts", blobSha, proofIdentitySha256: exactGitTreeInclusionProofIdentity(proof) }] },
      exactGitTreeInclusionProofs: [proof],
    })).toBe(false);
  });
});
