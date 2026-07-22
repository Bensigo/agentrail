import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  isGoalLoopEnabled,
  findActiveGoalBySlug,
  canFileNextIssue,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

interface RawBody {
  eveSessionId: string;
  slug: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.eveSessionId === "string" &&
    o.eveSessionId.length > 0 &&
    typeof o.slug === "string" &&
    o.slug.length > 0
  );
}

/**
 * POST /api/v1/runner/goals/file-check
 *
 * The PRE-FILE leash gate (adversarial-review fix, issue #1289): Jace's
 * `create_issue` write path (`agent/lib/create_issue.core.mjs`) calls this
 * BEFORE ever shelling out to create a GitHub issue, whenever the issue
 * body/title it's about to create carries a goal stamp
 * ("Goal: <objective> (goal:<slug>)" — see
 * `agent/lib/goal_outcome_dispatch.core.mjs::buildRefillMessage`, the
 * synthetic message that asks the model to include this stamp). This is
 * what makes `canFileNextIssue`'s stated contract ("check this FIRST and
 * only actually file when allow:true") real: without this call, the
 * (maxIssues+1)-th goal-stamped issue would be filed before anything ever
 * noticed the leash was exhausted.
 *
 * FLAG-GATED FIRST, before any goal lookup: `isGoalLoopEnabled` is checked
 * before `findActiveGoalBySlug` ever runs. A workspace that hasn't opted
 * into the goal loop gets `{ allow: true }` UNCONDITIONALLY — a coincidental
 * "(goal:xyz)"-shaped substring in an unrelated issue body must never block
 * normal issue creation for a workspace that has never used this feature at
 * all. Only once the flag is ON does an unresolved/terminal slug actually
 * refuse (see `findActiveGoalBySlug`'s own "active-only" contract).
 *
 * Auth: the same central Jace-coordinator secret every Jace-coordinator
 * route uses (`requireJaceConsoleSecret`).
 *
 * Response: `{ allow: true }` (flag off, OR an active goal with leash room
 * — includes `goalId` in this case so the caller can pass it straight to
 * `/api/v1/runner/goals/file-recorded` after the issue is actually
 * created, with no second slug resolution needed) or `{ allow: false,
 * reason }` (flag on but no ACTIVE goal matches the slug — includes a
 * goal that's already gone leashed/paused/reached/abandoned — or the
 * matched goal's own leash is exhausted).
 *
 * KNOWN RESIDUAL (documented, not fixed here): this check and the later
 * `file-recorded` increment are two separate calls, not one atomic
 * check-and-increment — two concurrent goal-stamped `create_issue` calls
 * for the SAME goal near its cap could both pass this check before either
 * records, overshooting `maxIssues` by at most one. Accepted for v1: every
 * goal-stamped issue is filed in response to ONE evaluate-on-outcome
 * decision, itself gated by a human's real-time approval on `create_issue`
 * — genuine concurrent goal-stamped filings for the same goal are not a
 * realistic v1 scenario. A future PR could close this with a single
 * atomic `UPDATE ... WHERE issues_filed < max_issues RETURNING *` if it
 * ever becomes one.
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

  if (!isRawBody(body)) {
    return NextResponse.json(
      { error: "Body must have eveSessionId (string) and slug (non-empty string)" },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session?.workspaceId ?? identity?.workspaceId ?? null;

  if (!workspaceId) {
    // Fail closed: a goal stamp was detected, but there is no tenant to
    // scope the check against. Practically unreachable — create_issue
    // itself already requires a connected repo, which requires a
    // workspace — but this is a safety-relevant gate, so an unresolvable
    // tenant refuses rather than silently allowing.
    return NextResponse.json({
      allow: false,
      reason: "could not resolve a workspace for this goal check",
    });
  }

  const enabled = await isGoalLoopEnabled(workspaceId);
  if (!enabled) {
    return NextResponse.json({ allow: true });
  }

  const goal = await findActiveGoalBySlug(workspaceId, body.slug);
  if (!goal) {
    return NextResponse.json({
      allow: false,
      reason: `no active goal matches "${body.slug}" — it may not exist, or may have already reached/leashed/paused`,
    });
  }

  const check = canFileNextIssue(goal);
  if (!check.allow) {
    return NextResponse.json({ allow: false, goalId: goal.id, reason: check.reason });
  }

  return NextResponse.json({ allow: true, goalId: goal.id });
}
