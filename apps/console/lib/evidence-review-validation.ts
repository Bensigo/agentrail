import type { AcceptanceContract } from "@agentrail/contracts";

export type CriterionStatus = "proven" | "failed" | "not_proven" | "not_testable";
export type FindingBasis = "acceptance_contract" | "architecture_boundary" | "repository_convention" | "risk";
export type EvidenceRef = { path: string; startLine: number; endLine: number; detail: string; headSha: string };
export type RuntimeEvidence = {
  criterionId: string; headSha: string; environmentId: string; flow: string;
  expected: string; observed: string; artifactRef: string;
};
export type CriterionReviewInput = {
  criterionId: string; status: CriterionStatus; observedBehavior: string; expectedBehavior: string;
  evidenceRefs: EvidenceRef[]; runtimeEvidence?: RuntimeEvidence[]; reason: string;
};
export type BlockingFindingInput = {
  basis: FindingBasis; criterionId?: string; enforcedRuleId?: string; evidenceRefs: EvidenceRef[];
  ruleOrBoundary: string; concreteImpact: string; requiredCorrection: string; reverification: string; repairPath?: string;
};

export type CorrectionPacket = {
  criterionId: string; ruleOrBoundary: string; expectedBehavior: string; observedBehavior: string;
  headSha: string; environmentIds: string[]; evidenceRefs: EvidenceRef[]; concreteImpact: string;
  relevantLocations: Array<Pick<EvidenceRef, "path" | "startLine" | "endLine">>;
  requiredCorrection: string; reverification: string; repairPath?: string;
};

const statuses = new Set<CriterionStatus>(["proven", "failed", "not_proven", "not_testable"]);
const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Reject advisory chatter at the trust boundary. */
export function validateEvidenceReview(input: {
  contract: AcceptanceContract; headSha: string; criteria: CriterionReviewInput[]; findings: BlockingFindingInput[];
}): { ok: true; overallStatus: CriterionStatus } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const expected = new Map(input.contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();
  for (const result of input.criteria) {
    const criterion = expected.get(result.criterionId);
    if (!criterion) { errors.push(`unknown criterion ${result.criterionId}`); continue; }
    if (seen.has(result.criterionId)) { errors.push(`duplicate criterion ${result.criterionId}`); continue; }
    seen.add(result.criterionId);
    if (!statuses.has(result.status)) errors.push(`invalid status for ${result.criterionId}`);
    if (!hasText(result.observedBehavior) || !hasText(result.expectedBehavior) || !hasText(result.reason)) errors.push(`criterion ${result.criterionId} needs observed behavior, expected behavior, and reason`);
    if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.some((ref) => !hasText(ref.path) || !Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine || !hasText(ref.detail) || ref.headSha !== input.headSha)) errors.push(`criterion ${result.criterionId} has invalid or wrong-head evidence`);
    if (criterion.userVisible && result.status === "proven") {
      const runtime = result.runtimeEvidence ?? [];
      if (!runtime.some((artifact) => artifact.criterionId === criterion.id && artifact.headSha === input.headSha && hasText(artifact.environmentId) && hasText(artifact.flow) && hasText(artifact.expected) && hasText(artifact.observed) && hasText(artifact.artifactRef))) errors.push(`user-visible criterion ${criterion.id} cannot be proven without criterion-specific runtime evidence for this head`);
    }
  }
  for (const criterion of expected.values()) if (criterion.required && !seen.has(criterion.id)) errors.push(`missing required criterion ${criterion.id}`);
  for (const finding of input.findings) {
    if (!finding || !["acceptance_contract", "architecture_boundary", "repository_convention", "risk"].includes(finding.basis)) errors.push("finding has an invalid basis");
    if (finding.basis === "acceptance_contract" && !finding.criterionId) errors.push("acceptance-contract finding needs a criterion");
    if (finding.basis === "repository_convention" && !hasText(finding.enforcedRuleId)) errors.push("repository-convention finding needs an enforced rule id");
    if (!Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length === 0 || finding.evidenceRefs.some((ref) => ref.headSha !== input.headSha)) errors.push("finding needs exact evidence for this head");
    if (!hasText(finding.ruleOrBoundary) || !hasText(finding.concreteImpact) || !hasText(finding.requiredCorrection) || !hasText(finding.reverification)) errors.push("finding needs rule/boundary, concrete impact, required correction, and re-verification");
  }
  for (const failed of input.criteria.filter((result) => result.status === "failed" && expected.get(result.criterionId)?.required)) {
    if (!input.findings.some((finding) => finding.criterionId === failed.criterionId)) errors.push(`failed required criterion ${failed.criterionId} needs a correction packet`);
  }
  if (errors.length) return { ok: false, errors };
  const required = input.criteria.filter((result) => expected.get(result.criterionId)?.required);
  const overallStatus = required.some((result) => result.status === "failed") ? "failed" : required.some((result) => result.status === "not_proven") ? "not_proven" : required.some((result) => result.status === "not_testable") ? "not_testable" : "proven";
  return { ok: true, overallStatus };
}

/** Build the agent-usable packet only from a validated, blocking finding. */
export function buildCorrectionPacket(input: {
  headSha: string; criterion: CriterionReviewInput; finding: BlockingFindingInput;
}): CorrectionPacket {
  const runtime = input.criterion.runtimeEvidence ?? [];
  return {
    criterionId: input.criterion.criterionId,
    ruleOrBoundary: input.finding.ruleOrBoundary,
    expectedBehavior: input.criterion.expectedBehavior,
    observedBehavior: input.criterion.observedBehavior,
    headSha: input.headSha,
    environmentIds: [...new Set(runtime.filter((item) => item.headSha === input.headSha).map((item) => item.environmentId))],
    evidenceRefs: input.finding.evidenceRefs,
    relevantLocations: input.finding.evidenceRefs.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
    concreteImpact: input.finding.concreteImpact,
    requiredCorrection: input.finding.requiredCorrection,
    reverification: input.finding.reverification,
    ...(hasText(input.finding.repairPath) ? { repairPath: input.finding.repairPath } : {}),
  };
}
