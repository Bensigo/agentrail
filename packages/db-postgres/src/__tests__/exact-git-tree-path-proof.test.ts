import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  exactGitTreeInclusionProofIdentity,
  verifyExactGitTreeInclusionProof,
  type ExactGitTreeInclusionProof,
} from "../exact-git-tree-path-proof.js";

type Entry = { mode: string; name: string; sha: string };

function tree(entries: Entry[]) {
  const body = Buffer.concat(entries.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.sha, "hex"),
  ])));
  return { sha1: createHash("sha1").update(`tree ${body.byteLength}\0`, "utf8").update(body).digest("hex"), bodyBase64: body.toString("base64") };
}

function proofFixture(): ExactGitTreeInclusionProof {
  const leaf = tree([
    { mode: "100644", name: "a.ts", sha: "1".repeat(40) },
    { mode: "100755", name: "z.ts", sha: "2".repeat(40) },
  ]);
  const root = tree([
    { mode: "40000", name: "dir", sha: leaf.sha1 },
    { mode: "100644", name: "root.ts", sha: "3".repeat(40) },
  ]);
  return {
    kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha: root.sha1,
    trees: [root, leaf].sort((left, right) => Buffer.compare(Buffer.from(left.sha1), Buffer.from(right.sha1))),
    paths: [{ path: "dir/a.ts", blobSha: "1".repeat(40) }, { path: "root.ts", blobSha: "3".repeat(40) }],
  };
}

describe("exact Git tree inclusion proof", () => {
  it("proves root and nested blobs through native Git tree bodies", () => {
    const proof = proofFixture();
    expect(verifyExactGitTreeInclusionProof(proof)).toBe(true);
    expect(exactGitTreeInclusionProofIdentity(proof)).toMatch(/^[0-9a-f]{64}$/u);
    const reordered = {
      paths: proof.paths.map(({ path, blobSha }) => ({ blobSha, path })),
      trees: proof.trees.map(({ sha1, bodyBase64 }) => ({ bodyBase64, sha1 })),
      headTreeSha: proof.headTreeSha,
      version: proof.version,
      kind: proof.kind,
    } as ExactGitTreeInclusionProof;
    expect(verifyExactGitTreeInclusionProof(reordered)).toBe(true);
    expect(exactGitTreeInclusionProofIdentity(reordered)).toBe(exactGitTreeInclusionProofIdentity(proof));
  });

  it("rejects forged root, subtree, path, blob, and truncated tree bodies", () => {
    const proof = proofFixture();
    expect(verifyExactGitTreeInclusionProof({ ...proof, headTreeSha: "f".repeat(40) })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, paths: [{ path: "dir/a.ts", blobSha: "f".repeat(40) }, proof.paths[1]! ] })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, paths: [{ path: "dir/missing.ts", blobSha: "1".repeat(40) }, proof.paths[1]! ] })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, trees: proof.trees.map((item, index) => index === 0 ? { ...item, bodyBase64: item.bodyBase64.slice(0, -4) } : item) })).toBe(false);
    const leaf = proof.trees.find((item) => item.sha1 !== proof.headTreeSha)!;
    expect(verifyExactGitTreeInclusionProof({ ...proof, trees: proof.trees.map((item) => item.sha1 === leaf.sha1 ? { ...item, sha1: "e".repeat(40) } : item).sort((left, right) => Buffer.compare(Buffer.from(left.sha1), Buffer.from(right.sha1))) })).toBe(false);
  });

  it("requires native Git mode/name ordering, including base-name tree ordering", () => {
    const blob = "4".repeat(40);
    const child = tree([{ mode: "100644", name: "x", sha: blob }]);
    // Git sorts `a-` before directory `a/`; reversing still hashes, but is not a canonical tree body.
    const reversed = tree([{ mode: "40000", name: "a", sha: child.sha1 }, { mode: "100644", name: "a-", sha: blob }]);
    const proof: ExactGitTreeInclusionProof = {
      kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha: reversed.sha1,
      trees: [reversed, child].sort((left, right) => Buffer.compare(Buffer.from(left.sha1), Buffer.from(right.sha1))),
      paths: [{ path: "a/x", blobSha: blob }],
    };
    expect(verifyExactGitTreeInclusionProof(proof)).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proofFixture(), paths: [{ path: "../root.ts", blobSha: "3".repeat(40) }] })).toBe(false);

    const duplicateName = tree([
      { mode: "100644", name: "same", sha: "6".repeat(40) },
      { mode: "40000", name: "same", sha: child.sha1 },
    ]);
    expect(verifyExactGitTreeInclusionProof({
      kind: "exact_git_tree_inclusion_batch",
      version: 1,
      headTreeSha: duplicateName.sha1,
      trees: [duplicateName],
      paths: [{ path: "same", blobSha: "6".repeat(40) }],
    })).toBe(false);
  });

  it("rejects noncanonical batches, links, path collisions, and cap overflows", () => {
    const proof = proofFixture();
    expect(verifyExactGitTreeInclusionProof({ ...proof, trees: [...proof.trees].reverse() })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, headTreeSha: proof.headTreeSha.toUpperCase() })).toBe(false);
    const unused = tree([{ mode: "100644", name: "unused", sha: "6".repeat(40) }]);
    expect(verifyExactGitTreeInclusionProof({ ...proof, trees: [...proof.trees, unused].sort((left, right) => Buffer.compare(Buffer.from(left.sha1), Buffer.from(right.sha1))) })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, paths: [{ path: "DIR/a.ts", blobSha: "1".repeat(40) }, { path: "dir/a.ts", blobSha: "1".repeat(40) }] })).toBe(false);
    const linkRoot = tree([{ mode: "120000", name: "link", sha: "5".repeat(40) }]);
    expect(verifyExactGitTreeInclusionProof({ kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha: linkRoot.sha1, trees: [linkRoot], paths: [{ path: "link", blobSha: "5".repeat(40) }] })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, paths: Array.from({ length: 17 }, (_, index) => ({ path: `x${index}`, blobSha: "1".repeat(40) })) })).toBe(false);
    expect(verifyExactGitTreeInclusionProof({ ...proof, trees: Array.from({ length: 129 }, () => proof.trees[0]!) })).toBe(false);
    const oversizedBody = Buffer.alloc(256 * 1024 + 1, 0x61);
    const oversizedTree = {
      sha1: createHash("sha1").update(`tree ${oversizedBody.byteLength}\0`).update(oversizedBody).digest("hex"),
      bodyBase64: oversizedBody.toString("base64"),
    };
    expect(verifyExactGitTreeInclusionProof({ kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha: oversizedTree.sha1, trees: [oversizedTree], paths: [{ path: "x", blobSha: "1".repeat(40) }] })).toBe(false);
  });

  it("is source-, token-, and URL-free by exact DTO shape", () => {
    const proof = proofFixture();
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toMatch(/https?:\/\/|token|authorization|content|secret/iu);
    expect(verifyExactGitTreeInclusionProof({ ...proof, token: "forged" })).toBe(false);
  });
});
