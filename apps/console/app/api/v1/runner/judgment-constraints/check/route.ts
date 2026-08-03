import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  listJudgmentConstraintMemoryItems,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import {
  evaluateJudgmentConstraints,
  parseJudgmentConstraintsMode,
} from "../../../../../../lib/judgment-constraints";

/**
 * POST /api/v1/runner/judgment-constraints/check
 *
 * E2 consumer for the judgment ledger arc. Jace calls this before
 * `create_issue` shells out to GitHub. Tenant resolution matches the other
 * runner routes: central Jace secret for caller auth, then `eveSessionId` ->
 * `jace_sessions.workspaceId` for scope. The caller supplies mode so rollout
 * can stage off -> warn -> block via AGENTRAIL_JUDGMENT_CONSTRAINTS_MODE.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const eveSessionId = String(payload.eveSessionId ?? "").trim();
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const mode = parseJudgmentConstraintsMode(payload.mode);
  if (mode === "off") {
    return NextResponse.json({ allow: true, mode, violations: [] }, { status: 200 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const workspaceId = session?.workspaceId ?? null;
  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const issue = payload.issue && typeof payload.issue === "object" ? payload.issue : {};

  let items;
  try {
    items = await listJudgmentConstraintMemoryItems(workspaceId);
  } catch (err) {
    console.error("[runner/judgment-constraints/check] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json(
    evaluateJudgmentConstraints({ mode, issue: issue as Record<string, unknown>, items }),
    { status: 200 },
  );
}
