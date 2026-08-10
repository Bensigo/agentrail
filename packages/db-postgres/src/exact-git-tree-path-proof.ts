import { createHash } from "node:crypto";

const SHA1 = /^[0-9a-f]{40}$/u;
const SAFE_NAME = /^[^/\\\u0000-\u001f\u007f]+$/u;

/** Limits for a transient native-Git-tree inclusion proof batch. */
export const MAX_EXACT_GIT_TREE_PROOF_PATHS = 16;
export const MAX_EXACT_GIT_TREE_PROOF_DEPTH = 32;
export const MAX_EXACT_GIT_TREE_PROOF_TREES = 128;
export const MAX_EXACT_GIT_TREE_PROOF_ENTRIES_PER_TREE = 4_096;
export const MAX_EXACT_GIT_TREE_PROOF_TREE_BYTES = 256 * 1024;
export const MAX_EXACT_GIT_TREE_PROOF_DECODED_BYTES = 1024 * 1024;
export const MAX_EXACT_GIT_TREE_PROOF_SERIALIZED_BYTES = 1_400 * 1024;

export type ExactGitTreeInclusionProof = {
  kind: "exact_git_tree_inclusion_batch";
  version: 1;
  headTreeSha: string;
  /** Canonically SHA-1-sorted native Git tree bodies, never source text. */
  trees: Array<{ sha1: string; bodyBase64: string }>;
  /** Canonically path-sorted blob claims proven by the bodies above. */
  paths: Array<{ path: string; blobSha: string }>;
};

type NativeTreeEntry = { mode: string; name: string; sha: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA1.test(value);
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "." && part !== ".." && SAFE_NAME.test(part));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Git's tree comparator treats a tree name as if it had a trailing slash. */
function compareNativeEntry(left: NativeTreeEntry, right: NativeTreeEntry): number {
  return compareUtf8(`${left.name}${left.mode === "40000" ? "/" : ""}`, `${right.name}${right.mode === "40000" ? "/" : ""}`);
}

function isNativeMode(mode: unknown): mode is string {
  return mode === "40000" || mode === "100644" || mode === "100755" || mode === "120000" || mode === "160000";
}

function gitTreeSha(body: Uint8Array): string {
  return createHash("sha1").update(`tree ${body.byteLength}\0`, "utf8").update(body).digest("hex");
}

function decodeCanonicalBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXACT_GIT_TREE_PROOF_SERIALIZED_BYTES) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function parseNativeTree(body: Uint8Array): NativeTreeEntry[] | null {
  if (body.byteLength === 0 || body.byteLength > MAX_EXACT_GIT_TREE_PROOF_TREE_BYTES) return null;
  const entries: NativeTreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space < 1) return null;
    const mode = Buffer.from(body.subarray(offset, space)).toString("ascii");
    const nul = body.indexOf(0, space + 1);
    if (nul < space + 2 || nul + 21 > body.byteLength || !isNativeMode(mode)) return null;
    const nameBytes = body.subarray(space + 1, nul);
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); } catch { return null; }
    if (!SAFE_NAME.test(name) || Buffer.byteLength(name, "utf8") > 4_096 || names.has(name)) return null;
    names.add(name);
    entries.push({ mode, name, sha: Buffer.from(body.subarray(nul + 1, nul + 21)).toString("hex") });
    offset = nul + 21;
    if (entries.length > MAX_EXACT_GIT_TREE_PROOF_ENTRIES_PER_TREE) return null;
  }
  return entries.length > 0 && entries.every((entry, index) => index === 0 || compareNativeEntry(entries[index - 1]!, entry) < 0) ? entries : null;
}

function canonicalProofJson(proof: ExactGitTreeInclusionProof): string {
  return JSON.stringify({
    kind: proof.kind,
    version: proof.version,
    headTreeSha: proof.headTreeSha,
    trees: proof.trees.map(({ sha1, bodyBase64 }) => ({ sha1, bodyBase64 })),
    paths: proof.paths.map(({ path, blobSha }) => ({ path, blobSha })),
  });
}

function serializedBytes(proof: ExactGitTreeInclusionProof): number {
  return Buffer.byteLength(canonicalProofJson(proof), "utf8");
}

/**
 * Pure verifier for the transient proof DTO. Hashing native bodies, rather
 * than a flattened JSON representation, proves Git's actual root/subtree
 * object chain and every sibling entry needed to reproduce each SHA-1.
 */
export function verifyExactGitTreeInclusionProof(value: unknown): value is ExactGitTreeInclusionProof {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "version", "headTreeSha", "trees", "paths"])
    || value["kind"] !== "exact_git_tree_inclusion_batch" || value["version"] !== 1 || !isSha(value["headTreeSha"])
    || !Array.isArray(value["trees"]) || value["trees"].length === 0 || value["trees"].length > MAX_EXACT_GIT_TREE_PROOF_TREES
    || !Array.isArray(value["paths"]) || value["paths"].length === 0 || value["paths"].length > MAX_EXACT_GIT_TREE_PROOF_PATHS) return false;
  const trees = new Map<string, NativeTreeEntry[]>();
  let decodedTotal = 0;
  let previousTreeSha: string | null = null;
  for (const rawTree of value["trees"]) {
    if (!isRecord(rawTree) || !hasExactKeys(rawTree, ["sha1", "bodyBase64"]) || !isSha(rawTree["sha1"]) || typeof rawTree["bodyBase64"] !== "string") return false;
    const sha1 = rawTree["sha1"];
    if (previousTreeSha !== null && compareUtf8(previousTreeSha, sha1) >= 0) return false;
    previousTreeSha = sha1;
    const body = decodeCanonicalBase64(rawTree["bodyBase64"]);
    if (body === null) return false;
    decodedTotal += body.byteLength;
    if (decodedTotal > MAX_EXACT_GIT_TREE_PROOF_DECODED_BYTES || gitTreeSha(body) !== sha1) return false;
    const entries = parseNativeTree(body);
    if (entries === null || trees.has(sha1)) return false;
    trees.set(sha1, entries);
  }
  let previousPath: string | null = null;
  const normalizedPaths = new Set<string>();
  const usedTreeShas = new Set<string>();
  for (const rawPath of value["paths"]) {
    if (!isRecord(rawPath) || !hasExactKeys(rawPath, ["path", "blobSha"]) || !safePath(rawPath["path"]) || !isSha(rawPath["blobSha"])) return false;
    const path = rawPath["path"] as string;
    if (previousPath !== null && compareUtf8(previousPath, path) >= 0 || path.split("/").length > MAX_EXACT_GIT_TREE_PROOF_DEPTH) return false;
    const normalized = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (normalizedPaths.has(normalized)) return false;
    normalizedPaths.add(normalized);
    previousPath = path;
    let treeSha = value["headTreeSha"];
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const entries = trees.get(treeSha);
      usedTreeShas.add(treeSha);
      const entry = entries?.find((candidate) => candidate.name === parts[index]);
      if (!entry) return false;
      if (index === parts.length - 1) {
        if ((entry.mode !== "100644" && entry.mode !== "100755") || entry.sha !== rawPath["blobSha"]) return false;
      } else {
        if (entry.mode !== "40000") return false;
        treeSha = entry.sha;
      }
    }
  }
  return usedTreeShas.size === trees.size && serializedBytes(value as ExactGitTreeInclusionProof) <= MAX_EXACT_GIT_TREE_PROOF_SERIALIZED_BYTES;
}

/** SHA-256 handle for persistence; the transient proof body itself must not persist. */
export function exactGitTreeInclusionProofIdentity(proof: ExactGitTreeInclusionProof): string {
  if (!verifyExactGitTreeInclusionProof(proof)) throw new Error("Invalid exact Git tree inclusion proof");
  return createHash("sha256").update(canonicalProofJson(proof), "utf8").digest("hex");
}
