import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { attachExternalPullRequest, getWorkspaceMembership, readAcceptanceContracts } from "@agentrail/db-postgres";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

function isMatchingGitHubPrUrl(value: unknown, repo: string, prNumber: number): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname === `/${repo}/pull/${prNumber}`;
  } catch { return false; }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, recordId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const prNumber = body.prNumber;
  const baseSha = typeof body.baseSha === "string" ? body.baseSha.toLowerCase() : "";
  const headSha = typeof body.headSha === "string" ? body.headSha.toLowerCase() : "";
  if (!repo || !Number.isSafeInteger(prNumber) || (prNumber as number) < 1 || !SHA.test(baseSha) || !SHA.test(headSha) || !isMatchingGitHubPrUrl(body.prUrl, repo, prNumber as number)) {
    return NextResponse.json({ error: "repo, GitHub pull-request URL, positive prNumber, and exact 40/64-character baseSha/headSha are required" }, { status: 400 });
  }
  const contracts = await readAcceptanceContracts({ workspaceId, recordId });
  if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!contracts.some((contract) => contract.status === "confirmed")) {
    return NextResponse.json({ error: "A confirmed Acceptance Contract is required before attaching an external PR" }, { status: 409 });
  }
  try {
    const record = await attachExternalPullRequest({
      workspaceId, recordId, repo, prNumber: prNumber as number, prUrl: body.prUrl,
      baseSha, headSha, attachedBy: `user:${session.user.id}`,
    });
    return NextResponse.json({ record: { id: record.id, repo: record.repo, prNumber: record.prNumber, headShas: record.headShas }, exactHeadSha: headSha }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to attach external PR";
    return NextResponse.json({ error: message }, { status: message.includes("different pull request") ? 409 : 500 });
  }
}
