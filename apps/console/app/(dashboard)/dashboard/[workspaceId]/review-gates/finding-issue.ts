export interface ReviewGateFinding {
  severity: "critical" | "major" | "minor";
  category: "tests" | "visual" | "citations" | "ac" | "blocked";
  description: string;
  suggested_fix: string;
}

interface IssueContext {
  runId: string;
  prUrl: string;
  gateId: string;
  index: number;
}

const VERIFICATION_BY_CATEGORY: Record<ReviewGateFinding["category"], string> = {
  tests: "The added/updated tests pass in CI.",
  visual: "Attach a screenshot showing the corrected UI.",
  citations: "The cited sources are present and resolve.",
  ac: "The acceptance criterion above is demonstrably met.",
  blocked: "The blocking condition is resolved and CI is green.",
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function buildFindingIssue(
  finding: ReviewGateFinding,
  ctx: IssueContext
): { title: string; body: string } {
  const title = `[review] ${truncate(finding.description, 80)}`;
  const body = [
    "## Parent",
    `Run ${ctx.runId} · PR ${ctx.prUrl}`,
    "",
    "## What to build",
    finding.description,
    "",
    `Suggested fix: ${finding.suggested_fix}`,
    "",
    "## Acceptance criteria",
    `- [ ] The issue described above is resolved and covered by a test.`,
    "",
    "## Verification",
    VERIFICATION_BY_CATEGORY[finding.category] ?? VERIFICATION_BY_CATEGORY.ac,
    "",
    `_Filed from the AgentRail review gate ${ctx.gateId}, finding #${ctx.index}._`,
  ].join("\n");
  return { title, body };
}
