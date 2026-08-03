import { NextRequest, NextResponse } from "next/server";
import {
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  listReviewerSuppressionRules,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const REPO_FORMAT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function validateRepo(repo: string): { ok: true } | { ok: false; reason: string } {
  if (!repo) return { ok: false, reason: "repo is required" };
  if (!REPO_FORMAT_RE.test(repo)) {
    return { ok: false, reason: "repo must be in the form owner/name" };
  }
  return { ok: true };
}

/**
 * GET /api/v1/runner/reviewer-suppressions
 *
 * Arc E2 reviewer consumer. Resolves eveSessionId -> workspace server-side,
 * validates the requested repo is connected to that workspace, then returns
 * deterministic read-only suppression rules derived from dismissed
 * review_outcome judgment events. Storage failures degrade to an empty rule
 * set so the reviewer never blocks or fails a review because the ledger is
 * unavailable.
 */
export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }
  const repoValidation = validateRepo(repo);
  if (!repoValidation.ok) {
    return NextResponse.json({ error: repoValidation.reason }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const identity = session?.chatIdentityId
    ? await getChatIdentityById(session.chatIdentityId)
    : null;
  const workspaceId = session?.workspaceId ?? identity?.workspaceId ?? null;
  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const repository = await getRepositoryByName(workspaceId, repo);
  if (!repository) {
    return NextResponse.json(
      { error: "repo not connected to this workspace" },
      { status: 404 }
    );
  }

  try {
    const rules = await listReviewerSuppressionRules({
      workspaceId,
      repo: repository.name,
    });
    return NextResponse.json({ repo: repository.name, rules, degraded: null });
  } catch (error) {
    console.error("[reviewer-suppressions] failed to load rules:", error);
    return NextResponse.json({
      repo: repository.name,
      rules: [],
      degraded: { reason: "storage_error" },
    });
  }
}
