import { createHash } from "node:crypto";

export const MAX_REVIEW_FILES = 60;
export const MAX_REVIEW_DIFF_BYTES = 120_000;

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function changedLineRanges(patch) {
  const ranges = [];
  let line = null;
  let start = null;
  let end = null;
  const flush = () => {
    if (start !== null && end !== null) ranges.push({ startLine: start, endLine: end });
    start = null;
    end = null;
  };
  for (const entry of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(entry);
    if (hunk) {
      flush();
      line = Number(hunk[1]);
      continue;
    }
    if (line === null || entry.startsWith("\\")) continue;
    if (entry.startsWith("-")) continue;
    if (entry.startsWith("+") || entry.startsWith(" ")) {
      if (start === null) start = line;
      end = line;
      line += 1;
    }
  }
  flush();
  return ranges;
}

/**
 * Reject a partial, wrong-head, binary, or over-budget diff before it becomes
 * model context. Selected evidence locations must resolve to exact-head lines
 * supplied in the bounded diff.
 */
export function buildAcceptanceReviewEvidence({ claim, pull, files }) {
  const expectedHead = claim?.request?.headSha;
  if (!text(expectedHead) || !text(claim?.pr?.repositoryFullName) || !Number.isInteger(claim?.pr?.prNumber)) {
    return { ok: false, reason: "Claim is missing exact PR identity" };
  }
  if (!pull || pull.head?.sha !== expectedHead || !text(pull.base?.sha)) {
    return { ok: false, reason: "GitHub pull request head does not match the claimed exact revision" };
  }
  if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: "GitHub returned no changed files for the exact pull request" };
  if (files.length > MAX_REVIEW_FILES) return { ok: false, reason: `Pull request exceeds the ${MAX_REVIEW_FILES}-file review budget` };
  const normalized = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!text(file?.filename) || !text(file?.patch)) return { ok: false, reason: "A changed file has no inspectable textual patch" };
    const ranges = changedLineRanges(file.patch);
    if (!ranges.length) return { ok: false, reason: `Changed file ${file.filename} has no exact-head line ranges` };
    const bytes = Buffer.byteLength(file.patch, "utf8");
    totalBytes += bytes;
    if (totalBytes > MAX_REVIEW_DIFF_BYTES) return { ok: false, reason: `Pull request exceeds the ${MAX_REVIEW_DIFF_BYTES}-byte diff budget` };
    normalized.push({ path: file.filename, status: text(file.status) ? file.status : "modified", patch: file.patch, ranges });
  }
  const diffText = normalized.map((file) => `diff -- ${file.path}\n${file.patch}`).join("\n");
  return {
    ok: true,
    evidence: {
      repository: claim.pr.repositoryFullName,
      prNumber: claim.pr.prNumber,
      headSha: expectedHead,
      files: normalized,
      diffText,
      diffIdentity: {
        baseSha: pull.base.sha,
        headSha: expectedHead,
        diffHash: createHash("sha256").update(diffText).digest("hex"),
      },
    },
  };
}

/** Evidence refs must point to a known, non-deleted exact-head diff line. */
export function evidenceRefsFitBoundedDiff(evidenceRefs, evidence) {
  if (!Array.isArray(evidenceRefs)) return false;
  return evidenceRefs.every((ref) => {
    if (!ref || ref.headSha !== evidence?.headSha || !text(ref.path) || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine)) return false;
    const file = evidence.files.find((item) => item.path === ref.path);
    return Boolean(file?.ranges.some((range) => ref.startLine >= range.startLine && ref.endLine <= range.endLine));
  });
}
