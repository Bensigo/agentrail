import { NextRequest, NextResponse } from "next/server";
import {
  evaluateJudgmentConstraints,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  listJudgmentConstraints,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

type RawBody = {
  eveSessionId: string;
  repo?: string;
  text: string;
};

function isRawBody(value: unknown): value is RawBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.eveSessionId === "string" && body.eveSessionId.trim().length > 0 &&
    (body.repo === undefined || typeof body.repo === "string") &&
    typeof body.text === "string" && body.text.trim().length > 0
  );
}

/**
 * POST /api/v1/runner/judgment-constraints/check
 *
 * E2's first enforcement seam. `create_issue` calls this after hardening the
 * final title/body and before invoking the GitHub CLI. Rejected approaches
 * become deterministic blocks only when their event payload carries
 * `blockedTerms: string[]`; malformed or older events are ignored by the
 * storage query. The route resolves the tenant from the Jace session and
 * never trusts a caller-supplied workspace id.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRawBody(raw)) {
    return NextResponse.json(
      { error: "Body must have eveSessionId, text, and optional repo" },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(raw.eveSessionId);
  const identity = session?.chatIdentityId
    ? await getChatIdentityById(session.chatIdentityId)
    : null;
  const workspaceId = session?.workspaceId ?? identity?.workspaceId ?? null;
  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const requestedRepo = raw.repo?.trim() ?? "";
    const repositories = requestedRepo
      ? [await getRepositoryByName(workspaceId, requestedRepo)]
      : await listWorkspaceRepositories(workspaceId);
    const repository = repositories.filter(Boolean)[0];
    if (!repository) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }
    if (!requestedRepo && repositories.filter(Boolean).length !== 1) {
      return NextResponse.json(
        { error: "repo is required when the workspace has multiple repositories" },
        { status: 409 }
      );
    }

    const constraints = await listJudgmentConstraints({
      workspaceId,
      repo: repository.name,
    });
    return NextResponse.json({
      repo: repository.name,
      ...evaluateJudgmentConstraints({
        proposalText: raw.text,
        constraints,
      }),
    });
  } catch (error) {
    console.error("[judgment-constraints] check failed:", error);
    return NextResponse.json(
      { error: "Failed to verify judgment constraints" },
      { status: 503 }
    );
  }
}
