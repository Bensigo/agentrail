import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  claimEvidenceReviewCorrectionDeliveryForGithubDispatch,
  getInstallationToken,
  getWorkspaceMembership,
  reportEvidenceReviewCorrectionGithubDispatch,
} from "@agentrail/db-postgres";

const MAX_COMMENT_LENGTH = 12_000;
const GITHUB_TIMEOUT_MS = 8_000;

const clip = (value: unknown, max = 2_000) => typeof value === "string" ? value.trim().slice(0, max) : "";

function githubTarget(value: unknown): { repo: string; prNumber: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  return typeof target.repo === "string" && target.repo.trim() && Number.isSafeInteger(target.prNumber) && Number(target.prNumber) > 0
    ? { repo: target.repo.trim(), prNumber: Number(target.prNumber) }
    : null;
}

function runtimeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const evidence = item as Record<string, unknown>;
    const environment = clip(evidence.environmentId, 200);
    const artifact = clip(evidence.artifactRef, 1_000);
    return environment || artifact ? [`- Environment: ${environment || "not recorded"}${artifact ? `; artifact: ${artifact}` : ""}`] : [];
  });
}

/** Render a correction packet only from persisted, exact-head evidence. */
export function formatGithubCorrection(item: any): string {
  const evidence = Array.isArray(item.correction.evidenceRefs) ? item.correction.evidenceRefs.slice(0, 12).flatMap((ref: unknown) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return [];
    const value = ref as Record<string, unknown>;
    const path = clip(value.path, 800);
    const detail = clip(value.detail, 1_500);
    const start = Number.isInteger(value.startLine) ? value.startLine : null;
    const end = Number.isInteger(value.endLine) ? value.endLine : null;
    return path ? [`- ${path}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}${detail ? ` — ${detail}` : ""}`] : [];
  }) : [];
  return [
    "## Jace merge blocker",
    "",
    `Acceptance criterion: ${clip(item.correction.criterionId, 300) || "not specified"}`,
    `Rule or boundary: ${clip(item.correction.scopeBoundary)}`,
    `Expected: ${clip(item.correction.expectedBehavior)}`,
    `Observed: ${clip(item.correction.observedBehavior)}`,
    `Exact revision: PR #${item.pr.prNumber}, head \`${clip(item.revision.headSha, 80)}\``,
    "",
    "### Evidence",
    ...(evidence.length ? evidence : ["- No file location was recorded; use the criterion-specific runtime evidence below."]),
    ...runtimeLines(item.criterion?.runtimeEvidence),
    "",
    `Impact: ${clip(item.correction.concreteImpact)}`,
    `Required correction: ${clip(item.correction.requiredCorrection)}`,
    `Re-verification: ${clip(item.correction.reverification)}`,
    item.correction.repairPath ? `Evidence-grounded repair path: ${clip(item.correction.repairPath)}` : "",
    "",
    "Jace has not changed code, approved this PR, or merged it. Acknowledgement is still required before Jace can claim the builder received this packet.",
  ].filter(Boolean).join("\n").slice(0, MAX_COMMENT_LENGTH);
}

/** Send an evidence-bound correction as a GitHub PR issue-comment. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; deliveryId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, deliveryId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return NextResponse.json({ error: "Only workspace owners or admins can dispatch correction delivery" }, { status: 403 });
  }
  const item = await claimEvidenceReviewCorrectionDeliveryForGithubDispatch({ workspaceId, deliveryId });
  if (!item) return NextResponse.json({ error: "No queued current-head GitHub correction delivery was found" }, { status: 409 });
  const fail = async (detail: string, status = 502) => {
    await reportEvidenceReviewCorrectionGithubDispatch({ workspaceId, deliveryId, reviewRevisionId: item.revision.id, outcome: "failed", detail });
    return NextResponse.json({ delivery: { id: deliveryId, outcome: "failed", attempt: item.attempt, detail } }, { status });
  };
  const target = githubTarget(item.delivery.target);
  if (!target || target.repo !== item.pr.repositoryFullName || target.prNumber !== item.pr.prNumber) {
    return fail("GitHub delivery target does not match the exact recorded PR revision", 409);
  }
  const token = await getInstallationToken(workspaceId);
  if (!token) return fail("GitHub App installation token is unavailable", 409);
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    response = await fetch(`https://api.github.com/repos/${target.repo}/issues/${target.prNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agentrail-console",
      },
      body: JSON.stringify({ body: formatGithubCorrection(item) }),
      signal: controller.signal,
    });
  } catch {
    return fail("GitHub could not be reached");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return fail(`GitHub rejected the correction comment (HTTP ${response.status})`, response.status === 404 ? 404 : 502);
  const delivery = await reportEvidenceReviewCorrectionGithubDispatch({
    workspaceId, deliveryId, reviewRevisionId: item.revision.id, outcome: "delivered",
    detail: `GitHub PR comment posted (HTTP ${response.status})`,
  });
  if (!delivery) return NextResponse.json({ error: "GitHub comment was posted but delivery state could not be recorded" }, { status: 503 });
  return NextResponse.json({ delivery: { id: delivery.id, outcome: delivery.outcome, attempt: delivery.attempt, attemptedAt: delivery.attemptedAt?.toISOString() ?? null } });
}
