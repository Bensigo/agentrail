import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptanceContextOverlayManifestSha256 } from "@agentrail/db-postgres";
import {
  exactHeadGitBlobSha1,
  projectExactHeadSourceCustody,
  type ExactHeadDirectReadReceiptInput,
  type ExactHeadSourceCustodyInput,
} from "./acceptance-context-pack-source-custody";
import {
  exactHeadContentMaterializationIdentity,
  MAX_EXACT_HEAD_DIRECT_PATH_BYTES,
  MAX_EXACT_HEAD_FILE_BYTES,
  MAX_EXACT_HEAD_SOURCE_BYTES,
  type ExactHeadContentRecord,
} from "./github-exact-head-content";
import {
  exactHeadContextCustodyOverlay,
  type ExactHeadGithubContextSnapshot,
} from "./github-exact-head-context";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const WIDGET = "export const widget = () => helper();\n";
const HELPER = "export const helper = () => true;\n";

type MutableSourceCustodyInput = Omit<ExactHeadSourceCustodyInput, "directReadReceipts" | "selectedDependencyPaths"> & {
  directReadReceipts: ExactHeadDirectReadReceiptInput[];
  selectedDependencyPaths: string[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(path: string, content: string, source: ExactHeadContentRecord["source"]): ExactHeadContentRecord {
  return {
    path,
    blobSha: exactHeadGitBlobSha1(content),
    previousPath: null,
    contentSha256: sha256(content),
    byteCount: Buffer.byteLength(content),
    lineCount: content.split("\n").length,
    content,
    source,
    reason: source === "exact_head_overlay" ? "exact_base_to_head_compare" : "exact_head_tree_path",
  };
}

function snapshot(): ExactHeadGithubContextSnapshot {
  const changedFiles = [{
    path: "src/widget.ts", status: "modified", blobSha: exactHeadGitBlobSha1(WIDGET), previousPath: null,
    headRanges: [{ startLine: 1, endLine: 1 }], patchSha256: sha256("@@ -1 +1 @@\n-old\n+new\n"),
    patchByteCount: Buffer.byteLength("@@ -1 +1 @@\n-old\n+new\n", "utf8"),
  }];
  return {
    repo: "acme/widgets", prNumber: 42, baseSha: BASE, mergeBaseSha: MERGE_BASE, headSha: HEAD, headTreeSha: TREE,
    changedFiles,
    manifestSha256: acceptanceContextOverlayManifestSha256({ schemaVersion: 1, baseSha: BASE, mergeBaseSha: MERGE_BASE, headSha: HEAD, files: changedFiles.map(({ path, status, blobSha, previousPath }) => ({ path, status: status as "modified", blobSha, previousPath })) }),
    provenance: { schemaVersion: 1, included: [{ path: "src/widget.ts", source: "overlay", reason: "exact_base_to_head_compare" }], excluded: [] },
  };
}

function input(overrides: Partial<MutableSourceCustodyInput> = {}): MutableSourceCustodyInput {
  const exact = snapshot();
  const records = [record("src/widget.ts", WIDGET, "exact_head_overlay")];
  const exclusions: never[] = [];
  const admittedOverlay = exactHeadContextCustodyOverlay(exact);
  if (!admittedOverlay) throw new Error("expected admitted overlay fixture");
  return {
    snapshot: exact,
    materialization: { content: {
      identitySha256: exactHeadContentMaterializationIdentity({ snapshot: exact, records, exclusions }),
      headTreeSha: TREE,
      records,
      exclusions,
    } },
    admittedOverlay,
    directReadReceipts: [{ requestedPath: "src/helper.ts", headSha: HEAD, headTreeSha: TREE, result: { ok: true as const, record: record("src/helper.ts", HELPER, "exact_head_tree_fallback") } }],
    selectedDependencyPaths: ["src/helper.ts"],
    ...overrides,
  };
}

function inputWithChangedContents(contents: readonly string[]): ExactHeadSourceCustodyInput {
  const patch = "@@ -1 +1 @@\n-old\n+new\n";
  const changedFiles = contents.map((content, index) => ({
    path: `src/changed-${index}.ts`,
    status: "modified" as const,
    blobSha: exactHeadGitBlobSha1(content),
    previousPath: null,
    headRanges: [{ startLine: 1, endLine: 1 }],
    patchSha256: sha256(patch),
    patchByteCount: Buffer.byteLength(patch, "utf8"),
  }));
  const exact: ExactHeadGithubContextSnapshot = {
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
      files: changedFiles.map(({ path, status, blobSha, previousPath }) => ({ path, status, blobSha, previousPath })),
    }),
    provenance: {
      schemaVersion: 1,
      included: changedFiles.map(({ path }) => ({ path, source: "overlay" as const, reason: "exact_base_to_head_compare" as const })),
      excluded: [],
    },
  };
  const records = contents.map((content, index) => record(`src/changed-${index}.ts`, content, "exact_head_overlay"));
  const admittedOverlay = exactHeadContextCustodyOverlay(exact);
  if (!admittedOverlay) throw new Error("expected admitted overlay fixture");
  return {
    snapshot: exact,
    admittedOverlay,
    materialization: {
      content: {
        identitySha256: exactHeadContentMaterializationIdentity({ snapshot: exact, records, exclusions: [] }),
        headTreeSha: TREE,
        records,
        exclusions: [],
      },
    },
    directReadReceipts: [],
    selectedDependencyPaths: [],
  };
}

function directReads(contents: readonly string[]) {
  return contents.map((content, index) => ({
    requestedPath: `src/dependency-${index}.ts`,
    headSha: HEAD,
    headTreeSha: TREE,
    result: { ok: true as const, record: record(`src/dependency-${index}.ts`, content, "exact_head_tree_fallback") },
  }));
}

describe("projectExactHeadSourceCustody", () => {
  it("projects a deterministic, source-free receipt with diff identity", () => {
    const result = projectExactHeadSourceCustody(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.changedManifest[0]).toMatchObject({ path: "src/widget.ts", patchSha256: sha256("@@ -1 +1 @@\n-old\n+new\n") });
    expect(JSON.stringify(result.receipt)).not.toContain(WIDGET);
    expect(JSON.stringify(result.receipt)).not.toContain(HELPER);
  });

  it("rejects forged SHA-1 blob ids, including legacy e*40 fixtures", () => {
    const forged = record("src/widget.ts", WIDGET, "exact_head_overlay");
    forged.blobSha = "e".repeat(40);
    expect(projectExactHeadSourceCustody(input({ materialization: { content: { identitySha256: "0".repeat(64), headTreeSha: TREE, records: [forged], exclusions: [] } } }))).toMatchObject({ ok: false, reason: "record_identity_mismatch" });
  });

  it("rejects a forged or stale materialization identity", () => {
    expect(projectExactHeadSourceCustody(input({
      materialization: {
        content: {
          ...input().materialization.content,
          identitySha256: "0".repeat(64),
        },
      },
    }))).toMatchObject({ ok: false, reason: "materialization_identity_mismatch" });
  });

  it("rejects patch or HEAD-range drift outside the admitted v2 overlay", () => {
    const drifted = snapshot();
    drifted.changedFiles[0]!.headRanges = [{ startLine: 2, endLine: 2 }];
    expect(projectExactHeadSourceCustody(input({ snapshot: drifted })))
      .toMatchObject({ ok: false, reason: "snapshot_manifest_mismatch" });

    const unpaired = snapshot();
    unpaired.changedFiles[0]!.patchSha256 = null;
    expect(projectExactHeadSourceCustody(input({ snapshot: unpaired })))
      .toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it.each(["missing", "extra"])("rejects a %s changed record", (kind) => {
    const records = kind === "missing" ? [] : [record("src/widget.ts", WIDGET, "exact_head_overlay"), record("src/extra.ts", "x\n", "exact_head_overlay")];
    expect(projectExactHeadSourceCustody(input({ materialization: { content: { identitySha256: "0".repeat(64), headTreeSha: TREE, records, exclusions: [] } } }))).toMatchObject({ ok: false, reason: "changed_record_mismatch" });
  });

  it("rejects a materialization tree mismatch", () => {
    expect(projectExactHeadSourceCustody(input({ materialization: { content: { identitySha256: "0".repeat(64), headTreeSha: "f".repeat(40), records: [record("src/widget.ts", WIDGET, "exact_head_overlay")], exclusions: [] } } }))).toMatchObject({ ok: false, reason: "head_tree_mismatch" });
  });

  it("rejects direct reads returned for another path or source", () => {
    const wrongPath = input();
    wrongPath.directReadReceipts[0] = { ...wrongPath.directReadReceipts[0]!, result: { ok: true, record: record("src/other.ts", HELPER, "exact_head_tree_fallback") } };
    expect(projectExactHeadSourceCustody(wrongPath)).toMatchObject({ ok: false, reason: "direct_read_mismatch" });
    const wrongSource = input();
    wrongSource.directReadReceipts[0] = { ...wrongSource.directReadReceipts[0]!, result: { ok: true, record: record("src/helper.ts", HELPER, "exact_head_overlay") } };
    expect(projectExactHeadSourceCustody(wrongSource)).toMatchObject({ ok: false, reason: "direct_read_mismatch" });
  });

  it("rejects contradictory duplicate reads for one requested path", () => {
    const contradictory = input();
    contradictory.directReadReceipts.push({
      requestedPath: "src/helper.ts",
      headSha: HEAD,
      headTreeSha: TREE,
      result: { ok: false, kind: "not_proven", reason: "path_not_found" },
    });
    expect(projectExactHeadSourceCustody(contradictory)).toMatchObject({ ok: false, reason: "direct_read_mismatch" });
  });

  it("requires every selected dependency source to have one successful exact read", () => {
    expect(projectExactHeadSourceCustody(input({ directReadReceipts: [] })))
      .toMatchObject({ ok: false, reason: "direct_read_mismatch" });
    expect(projectExactHeadSourceCustody(input({ directReadReceipts: [], selectedDependencyPaths: [] }))).toMatchObject({ ok: true });
  });

  it("enforces the exact-path resolver receipt cap", () => {
    const directReadReceipts = Array.from({ length: 17 }, (_, index) => ({
      requestedPath: `src/missing-${index}.ts`,
      headSha: HEAD,
      headTreeSha: TREE,
      result: { ok: false as const, kind: "not_proven" as const, reason: "path_not_found" as const },
    }));
    expect(projectExactHeadSourceCustody(input({ directReadReceipts, selectedDependencyPaths: [] })))
      .toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("rejects per-file and aggregate changed-source byte limits", () => {
    expect(projectExactHeadSourceCustody(inputWithChangedContents(["x".repeat(MAX_EXACT_HEAD_FILE_BYTES + 1)])))
      .toMatchObject({ ok: false, reason: "record_identity_mismatch" });

    const aggregate = Array.from({ length: 5 }, () => "x".repeat(MAX_EXACT_HEAD_FILE_BYTES));
    expect(aggregate.reduce((total, value) => total + Buffer.byteLength(value), 0)).toBeGreaterThan(MAX_EXACT_HEAD_SOURCE_BYTES);
    expect(projectExactHeadSourceCustody(inputWithChangedContents(aggregate)))
      .toMatchObject({ ok: false, reason: "source_limit" });
  });

  it("rejects per-file and aggregate direct-read byte limits", () => {
    const oversized = "x".repeat(MAX_EXACT_HEAD_FILE_BYTES + 1);
    expect(projectExactHeadSourceCustody(input({
      directReadReceipts: directReads([oversized]),
      selectedDependencyPaths: ["src/dependency-0.ts"],
    }))).toMatchObject({ ok: false, reason: "direct_read_mismatch" });

    const aggregate = Array.from({ length: 3 }, () => "x".repeat(Math.floor(MAX_EXACT_HEAD_DIRECT_PATH_BYTES / 2)));
    expect(projectExactHeadSourceCustody(input({
      directReadReceipts: directReads(aggregate),
      selectedDependencyPaths: aggregate.map((_, index) => `src/dependency-${index}.ts`),
    }))).toMatchObject({ ok: false, reason: "source_limit" });
  });

  it("accepts exact changed and direct-read byte boundaries", () => {
    const changed = Array.from({ length: MAX_EXACT_HEAD_SOURCE_BYTES / MAX_EXACT_HEAD_FILE_BYTES }, () => "x".repeat(MAX_EXACT_HEAD_FILE_BYTES));
    expect(projectExactHeadSourceCustody(inputWithChangedContents(changed))).toMatchObject({ ok: true });

    const dependencies = Array.from({ length: MAX_EXACT_HEAD_DIRECT_PATH_BYTES / MAX_EXACT_HEAD_FILE_BYTES }, () => "x".repeat(MAX_EXACT_HEAD_FILE_BYTES));
    expect(projectExactHeadSourceCustody(input({
      directReadReceipts: directReads(dependencies),
      selectedDependencyPaths: dependencies.map((_, index) => `src/dependency-${index}.ts`),
    }))).toMatchObject({ ok: true });
  });

  it("rejects direct-read head/tree and content-identity drift", () => {
    const wrongTree = input();
    wrongTree.directReadReceipts[0] = { ...wrongTree.directReadReceipts[0]!, headTreeSha: "f".repeat(40) };
    expect(projectExactHeadSourceCustody(wrongTree)).toMatchObject({ ok: false, reason: "direct_read_mismatch" });
    const wrongBytes = input();
    const dependency = record("src/helper.ts", HELPER, "exact_head_tree_fallback");
    dependency.byteCount += 1;
    wrongBytes.directReadReceipts[0] = { ...wrongBytes.directReadReceipts[0]!, result: { ok: true, record: dependency } };
    expect(projectExactHeadSourceCustody(wrongBytes)).toMatchObject({ ok: false, reason: "direct_read_mismatch" });
  });

  it("rejects byte, content hash, and line count drift", () => {
    for (const field of ["byteCount", "contentSha256", "lineCount"] as const) {
      const changed = record("src/widget.ts", WIDGET, "exact_head_overlay");
      if (field === "byteCount") changed.byteCount += 1;
      if (field === "contentSha256") changed.contentSha256 = "0".repeat(64);
      if (field === "lineCount") changed.lineCount += 1;
      expect(projectExactHeadSourceCustody(input({ materialization: { content: { identitySha256: "0".repeat(64), headTreeSha: TREE, records: [changed], exclusions: [] } } }))).toMatchObject({ ok: false, reason: "record_identity_mismatch" });
    }
  });

  it("is deterministic when records and receipts are shuffled", () => {
    const first = input();
    const extra = { requestedPath: "src/second.ts", headSha: HEAD, headTreeSha: TREE, result: { ok: false as const, kind: "not_proven" as const, reason: "path_not_found" as const } };
    const second = input({ directReadReceipts: [extra, ...first.directReadReceipts] });
    const third = input({ directReadReceipts: [...first.directReadReceipts, extra] });
    const left = projectExactHeadSourceCustody(second);
    const right = projectExactHeadSourceCustody(third);
    expect(left.ok && right.ok ? left.receipt : null).toEqual(right.ok ? right.receipt : null);
  });

  it("keeps the receipt identity stable when equivalent objects use another property order", () => {
    const first = input();
    const reordered = input();
    const original = reordered.directReadReceipts[0]!;
    reordered.directReadReceipts[0] = {
      result: original.result,
      headTreeSha: original.headTreeSha,
      requestedPath: original.requestedPath,
      headSha: original.headSha,
    };
    const result = projectExactHeadSourceCustody(reordered);
    const baseline = projectExactHeadSourceCustody(first);
    expect(result.ok && baseline.ok ? result.receipt.identitySha256 : null)
      .toBe(baseline.ok ? baseline.receipt.identitySha256 : null);
  });

  it("fails closed when source bytes or exclusions violate secret policy", () => {
    const secret = record("src/widget.ts", "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';\n", "exact_head_overlay");
    const secretSnapshot = snapshot();
    secretSnapshot.changedFiles[0]!.blobSha = secret.blobSha;
    secretSnapshot.manifestSha256 = acceptanceContextOverlayManifestSha256({
      schemaVersion: 1, baseSha: BASE, mergeBaseSha: MERGE_BASE, headSha: HEAD,
      files: secretSnapshot.changedFiles.map(({ path, status, blobSha, previousPath }) => ({ path, status: status as "modified", blobSha, previousPath })),
    });
    const admittedOverlay = exactHeadContextCustodyOverlay(secretSnapshot);
    expect(admittedOverlay).not.toBeNull();
    if (!admittedOverlay) return;
    expect(projectExactHeadSourceCustody(input({
      snapshot: secretSnapshot,
      admittedOverlay,
      materialization: { content: { identitySha256: "0".repeat(64), headTreeSha: TREE, records: [secret], exclusions: [] } },
    }))).toMatchObject({ ok: false, reason: "record_identity_mismatch" });
  });
});
