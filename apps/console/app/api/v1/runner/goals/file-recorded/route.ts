import { NextRequest, NextResponse } from "next/server";
import { recordIssueFiled } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

interface RawBody {
  goalId: string;
  issueExternalId: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.goalId === "string" &&
    o.goalId.length > 0 &&
    typeof o.issueExternalId === "string" &&
    o.issueExternalId.length > 0
  );
}

/**
 * POST /api/v1/runner/goals/file-recorded
 *
 * The POST-file bookkeeping half of the adversarial-review fix (issue
 * #1289): `create_issue`'s write path (`agent/lib/create_issue.core.mjs`)
 * calls this AFTER a goal-stamped issue has ACTUALLY been created on
 * GitHub, using the `goalId` the earlier `/file-check` call already
 * resolved (no second slug lookup needed). This is the ONE call in
 * production that increments `goals.issues_filed` and writes the
 * `goal_events` `issue_filed` row `findActiveGoalForIssue` depends on for
 * the evaluate-on-outcome mapping — before this fix, NOTHING in production
 * called `recordIssueFiled` at all, so `issues_filed` was frozen at 0 and
 * the issue<->goal mapping never resolved.
 *
 * BEST-EFFORT, mirrors `stampCreatedIssueUrl`'s own contract: a failure
 * here must NEVER retroactively undo an already-created GitHub issue (that
 * is not even possible) and must never be surfaced as a tool failure to
 * the model — `create_issue.core.mjs` awaits this but ignores its result
 * beyond logging, exactly like the existing stamp call. `recordIssueFiled`
 * itself already no-ops safely if `goalId` doesn't resolve to a real row.
 *
 * Auth: the same central Jace-coordinator secret every Jace-coordinator
 * route uses. No further tenant scoping is needed here (unlike
 * `/file-check`): `goalId` is an opaque, non-guessable uuid the caller only
 * ever has because IT (Jace) is the one that just received it from this
 * exact workspace's own `/file-check` response a moment earlier in the SAME
 * tool call — same "no anti-enumeration reason to hide the reason"
 * posture the create_workspace route's own doc-comment already accepts for
 * an analogous internal hand-off.
 *
 * Response: `{ ok: true }` always (this is an internal bookkeeping
 * hand-off, not a REST resource with meaningful failure states to
 * distinguish).
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
      { error: "Body must have goalId (string) and issueExternalId (string)" },
      { status: 400 }
    );
  }

  await recordIssueFiled(body.goalId, body.issueExternalId);

  return NextResponse.json({ ok: true });
}
