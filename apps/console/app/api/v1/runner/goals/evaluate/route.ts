import { NextRequest, NextResponse } from "next/server";
import { isGoalLoopEnabled, recordOutcomeAndTransition, type GoalOutcome } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

const GOAL_OUTCOMES: readonly GoalOutcome[] = ["green", "escalated-to-human", "blocked"];

interface RawBody {
  workspaceId: string;
  issueExternalId: string;
  outcome: GoalOutcome;
  costUsd?: number;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.workspaceId !== "string" || o.workspaceId.length === 0) return false;
  if (typeof o.issueExternalId !== "string" || o.issueExternalId.length === 0) return false;
  if (typeof o.outcome !== "string" || !GOAL_OUTCOMES.includes(o.outcome as GoalOutcome)) return false;
  if (o.costUsd !== undefined && typeof o.costUsd !== "number") return false;
  return true;
}

/**
 * POST /api/v1/runner/goals/evaluate
 *
 * THE evaluate-on-outcome entry point for the Jace goal loop (issue #1289,
 * PRD design point 4: "extend the run-outcome hand-off"). Jace's
 * `agent/channels/run-outcome.ts` calls this, right after forwarding the
 * existing terminal-outcome notification to the platform channel unchanged,
 * with the SAME structured fields the console's `notify.ts::notifyViaJace`
 * already sends over the wire today (`workspaceId`, `outcome`,
 * `issueNumber` -> here `issueExternalId`, `costUsd`) — this route is new,
 * but the DATA it consumes is not: no console-side sender change was needed
 * for this PR.
 *
 * FLAG-GATED FIRST, before any goal-table read: `isGoalLoopEnabled` is
 * checked before `recordOutcomeAndTransition` ever runs, so a workspace
 * that hasn't opted in gets a flat `{ matched: false }` no-op — no goal
 * lookup, no write, nothing (issue #1289's rollout-safety requirement).
 *
 * Auth: the same central Jace-coordinator secret every Jace-coordinator
 * route uses (`requireJaceConsoleSecret`) — this is a machine-to-machine
 * hand-off between Jace and the console's own database, not a user-facing
 * endpoint, same trust posture as `/api/v1/runner/approvals`.
 *
 * Response: 200 always (this is an internal decision hand-off, not a
 * REST resource) — `{ matched: false }` when the flag is off or no active
 * goal maps to this issue; otherwise `{ matched: true, action, goal:
 * { id, objective, slug, status, issuesFiled, maxIssues, spendUsd,
 * maxSpendUsd }, reason }`. `action` is one of `refill` | `reached` |
 * `escalate_leashed` | `escalate_stuck` | `noop` — see
 * `queries/goal_rules.ts` for what each means; Jace's own dispatch logic
 * (`agent/lib/goal_outcome_dispatch.core.mjs`) decides what to DO with it
 * (forward an escalation, or synthesize a decompose-and-file turn for
 * `refill` — still gated behind the existing `create_issue` approval seam,
 * never bypassed here).
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
      {
        error:
          "Body must have workspaceId (string), issueExternalId (string), " +
          "outcome ('green'|'escalated-to-human'|'blocked'); costUsd, if present, must be a number",
      },
      { status: 400 }
    );
  }

  const enabled = await isGoalLoopEnabled(body.workspaceId);
  if (!enabled) {
    return NextResponse.json({ matched: false });
  }

  const result = await recordOutcomeAndTransition({
    workspaceId: body.workspaceId,
    issueExternalId: body.issueExternalId,
    outcome: body.outcome,
    costUsd: body.costUsd ?? 0,
  });

  if (!result.matched || !result.goal) {
    return NextResponse.json({ matched: false });
  }

  return NextResponse.json({
    matched: true,
    action: result.action,
    reason: result.reason,
    goal: {
      id: result.goal.id,
      objective: result.goal.objective,
      slug: result.goal.slug,
      status: result.goal.status,
      issuesFiled: result.goal.issuesFiled,
      maxIssues: result.goal.maxIssues,
      spendUsd: result.goal.spendUsd,
      maxSpendUsd: result.goal.maxSpendUsd,
    },
  });
}
