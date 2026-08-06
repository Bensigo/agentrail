import { evidenceRefsFitBoundedDiff } from "./acceptance_review_evidence.core.mjs";

function notProven(item, reason) {
  const criteria = item.contract?.contract?.acceptanceCriteria ?? [];
  return {
    overallStatus: "not_proven",
    verifierName: "jace-bounded-reviewer", verifierVersion: "1", promptVersion: "1", environmentRung: "static_exact_head",
    diffIdentity: { headSha: item.request.headSha, unavailableReason: reason }, independentVerifier: { identity: "jace-bounded-reviewer" }, reviewabilityResult: { status: "not_proven", reason }, staticFindings: [], testResults: [], findings: [],
    criteria: criteria.map((criterion) => ({ criterionId: criterion.id, status: "not_proven", observedBehavior: reason, expectedBehavior: criterion.text, evidenceRefs: [], runtimeEvidence: [], reason })),
  };
}

/** Build a bounded model task and reject citations outside exact retained diff evidence. */
export function createAcceptanceReviewEvaluator({ fetchEvidence, generate }) {
  if (typeof fetchEvidence !== "function" || typeof generate !== "function") throw new TypeError("fetchEvidence and generate are required");
  return async (item) => {
    const fetched = await fetchEvidence(item);
    if (!fetched?.ok) return notProven(item, fetched?.reason || "Exact review evidence is unavailable");
    const output = await generate({
      contract: item.contract.contract,
      pr: { repository: item.pr.repositoryFullName, number: item.pr.prNumber, headSha: item.request.headSha },
      diff: fetched.evidence.diffText,
      instruction: "Return only criterion results and blocking findings requiring code changes. Never emit style advice. Cite only provided exact-head diff lines.",
    });
    if (!output || !Array.isArray(output.criteria) || !Array.isArray(output.findings)) throw new Error("Evaluator returned no structured review");
    if (!output.criteria.every((criterion) => evidenceRefsFitBoundedDiff(criterion.evidenceRefs ?? [], fetched.evidence))) throw new Error("Evaluator cited a line outside the bounded exact-head diff");
    if (!output.findings.every((finding) => Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0 && evidenceRefsFitBoundedDiff(finding.evidenceRefs, fetched.evidence))) throw new Error("Evaluator finding lacks bounded exact-head evidence");
    return {
      ...output,
      diffIdentity: fetched.evidence.diffIdentity,
      verifierName: "jace-bounded-reviewer", verifierVersion: "1", promptVersion: "1", environmentRung: "static_exact_head",
      independentVerifier: { identity: "jace-bounded-reviewer" }, reviewabilityResult: { status: "reviewed_bounded_diff" },
      staticFindings: output.staticFindings ?? [], testResults: output.testResults ?? [],
    };
  };
}
