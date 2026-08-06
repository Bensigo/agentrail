import { MAX_REVIEW_FILES, buildAcceptanceReviewEvidence } from "./acceptance_review_evidence.core.mjs";

const API_ROOT = "https://api.github.com";

function githubUrl(repository, suffix) {
  return `${API_ROOT}/repos/${repository.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

async function readJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${typeof body?.message === "string" ? body.message : "read failed"}`);
  return body;
}

/** Fetch only a claimed PR's metadata and bounded diff patches, never a repository checkout. */
export async function fetchAcceptanceReviewEvidence({ item, fetchImpl = fetch }) {
  const token = typeof item?.githubToken === "string" ? item.githubToken.trim() : "";
  const repository = item?.pr?.repositoryFullName;
  const prNumber = item?.pr?.prNumber;
  if (!token) return { ok: false, reason: "No GitHub installation token is available for the claimed review" };
  if (typeof repository !== "string" || !Number.isInteger(prNumber)) return { ok: false, reason: "Claim is missing a GitHub pull request identity" };
  try {
    const pull = await readJson(fetchImpl, githubUrl(repository, `/pulls/${prNumber}`), token);
    const files = await readJson(fetchImpl, githubUrl(repository, `/pulls/${prNumber}/files?per_page=${MAX_REVIEW_FILES + 1}`), token);
    return buildAcceptanceReviewEvidence({ claim: item, pull, files });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "GitHub review evidence fetch failed" };
  }
}
