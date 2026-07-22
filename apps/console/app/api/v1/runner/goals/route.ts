import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  listWorkspaceRepositories,
  createGoal,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const OBJECTIVE_MAX = 500;
const SLUG_SUFFIX_BYTES = 3;

interface RawBody {
  eveSessionId: string;
  objective: string;
  checkThreshold?: number;
  checkMetric?: string;
  maxIssues?: number;
  maxSpendUsd?: number;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string" || o.eveSessionId.length === 0) return false;
  if (typeof o.objective !== "string" || o.objective.trim().length === 0) return false;
  if (o.checkThreshold !== undefined && typeof o.checkThreshold !== "number") return false;
  if (o.checkMetric !== undefined && typeof o.checkMetric !== "string") return false;
  if (o.maxIssues !== undefined && typeof o.maxIssues !== "number") return false;
  if (o.maxSpendUsd !== undefined && typeof o.maxSpendUsd !== "number") return false;
  return true;
}

/**
 * lowercase, hyphenate, strip everything else, cap length. Mirrors
 * `runner/workspaces/route.ts`'s own `slugify` idiom exactly — duplicated
 * rather than imported, matching this codebase's "each route's small
 * helpers stay local" convention (see that file's own comment on why it
 * doesn't import the dashboard form's private `toSlug`).
 */
function slugify(objective: string): string {
  return objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function slugifyWithFallback(objective: string): string {
  const slug = slugify(objective);
  if (slug.length > 0) return slug;
  return `goal-${randomBytes(SLUG_SUFFIX_BYTES).toString("hex")}`;
}

/**
 * POST /api/v1/runner/goals
 *
 * Creates a real AgentRail goal for THIS conversation's workspace — Jace's
 * `create_goal` tool's own console endpoint (issue #1289), same gate class
 * and same auth/resolution pattern as `create_workspace`/`create_repo`:
 * central Jace-coordinator secret (`requireJaceConsoleSecret`), then
 * `{ eveSessionId }` resolved through the session ledger
 * (`getJaceSessionByEveSessionId` -> `getChatIdentityById`), NEVER a
 * caller-supplied workspace id. A human already approved this exact
 * objective in-chat (the tool's `consoleGatedApproval` gate) before this
 * route ever runs — this route performs no further approval, it only
 * persists.
 *
 * Repository resolution: v1 goals are single-repo (PRD non-goal: "No
 * multi-repo goals"). This route auto-resolves the workspace's connected
 * repo the SAME way `create_issue` does (never asks the model to supply
 * one) — the first repo `listWorkspaceRepositories` returns. A workspace
 * with zero connected repos returns `{ connected: false, message }`,
 * mirroring `create_issue.core.mjs`'s own `notConnectedGuidance` shape, so
 * the tool can relay the same "connect a repo first" guidance rather than a
 * confusing 409. A workspace with MULTIPLE connected repos (uncommon in
 * practice today) uses the first by name-sort order — a known v1
 * simplification, not a correctness issue: a future multi-repo goal PRD
 * would need an explicit repo selector here, out of scope for #1289.
 *
 * `slug` is derived from `objective`, never caller-supplied, capped at 60
 * chars. Unlike `workspaces.slug` this carries NO uniqueness constraint —
 * it is a human-facing label only (goal-stamped into filed issue bodies);
 * the actual issue<->goal mapping is `goal_events.issueExternalId`
 * (`findActiveGoalForIssue`), so a slug collision between two goals in the
 * same workspace is a cosmetic ambiguity, never a correctness bug.
 *
 * Response: 201 { goalId, objective, slug, status, maxIssues, maxSpendUsd }.
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
      { error: "Body must have eveSessionId (string) and objective (non-empty string)" },
      { status: 400 }
    );
  }

  const objective = body.objective.trim().slice(0, OBJECTIVE_MAX);

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;

  if (!session || !identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  const workspaceId = session.workspaceId ?? identity.workspaceId;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "this conversation has no workspace yet — create one first" },
      { status: 409 }
    );
  }

  const repos = await listWorkspaceRepositories(workspaceId);
  const repo = repos[0];
  if (!repo) {
    return NextResponse.json(
      {
        connected: false,
        message:
          "I can't create a goal yet — no GitHub repo is connected for this workspace. " +
          "Connect a repo on the AgentRail console (Settings → Connectors → GitHub), then try again.",
      },
      { status: 409 }
    );
  }

  const goal = await createGoal({
    workspaceId,
    repositoryId: repo.id,
    objective,
    slug: slugifyWithFallback(objective),
    checkType: "metric",
    checkMetric: body.checkMetric ?? "green_run_count",
    checkThreshold: body.checkThreshold,
    maxIssues: body.maxIssues,
    maxSpendUsd: body.maxSpendUsd,
    createdByEveSessionId: body.eveSessionId,
  });

  return NextResponse.json(
    {
      goalId: goal.id,
      objective: goal.objective,
      slug: goal.slug,
      status: goal.status,
      maxIssues: goal.maxIssues,
      maxSpendUsd: goal.maxSpendUsd,
    },
    { status: 201 }
  );
}
