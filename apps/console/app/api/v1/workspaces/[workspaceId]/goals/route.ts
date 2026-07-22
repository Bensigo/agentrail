import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  createGoal,
  findActiveGoalBySlug,
  getRepository,
  getWorkspaceMembership,
  isGoalLoopEnabled,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

const OBJECTIVE_MAX = 2000;
const CHECK_METRIC_MAX = 200;
const CHECK_COMMAND_MAX = 2000;
const SLUG_MAX = 40;
const SLUG_DEDUP_SUFFIX_LEN = 4;

const DEFAULT_MAX_ISSUES = 10;
const DEFAULT_MAX_SPEND_USD = 50;
const MIN_MAX_ISSUES = 1;
const MAX_MAX_ISSUES = 100;
const MIN_MAX_SPEND_USD = 1;
const MAX_MAX_SPEND_USD = 1000;

/**
 * lowercase, hyphenate, strip everything else, cap length. Deliberately
 * shorter (40 chars) than `runner/goals/route.ts`'s own 60-char cap — see
 * `SLUG_MAX`'s call site below, which appends a disambiguation suffix when
 * an active goal already owns the plain slug, and needs headroom to do that
 * without exceeding the column's practical length.
 */
function slugify(objective: string): string {
  return objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * Derive a workspace-scoped, best-effort-unique slug from `objective` — the
 * slug column carries no DB uniqueness constraint (see `schema/goals.ts`'s
 * own comment: "not enforced at the DB level"), but a human staring at two
 * "New goal" cards with the identical slug reads as a bug, so this route
 * checks `findActiveGoalBySlug` (the same lookup `create_issue`'s write path
 * uses) and appends a short disambiguator when the plain slug is already
 * owned by a currently-ACTIVE goal. A terminal (non-active) goal's slug is
 * never in the way — `findActiveGoalBySlug` only ever matches `active` ones.
 */
async function deriveUniqueSlug(workspaceId: string, objective: string): Promise<string> {
  const base = slugify(objective) || "goal";
  const existing = await findActiveGoalBySlug(workspaceId, base);
  if (!existing) return base;
  const suffix = randomUUID().replace(/-/g, "").slice(0, SLUG_DEDUP_SUFFIX_LEN);
  return `${base}-${suffix}`;
}

interface RawBody {
  objective?: unknown;
  repository_id?: unknown;
  max_issues?: unknown;
  max_spend_usd?: unknown;
  check_type?: unknown;
  check_metric?: unknown;
  check_threshold?: unknown;
  check_command?: unknown;
}

/** A finite, positive integer (max_issues/check_threshold are counts). */
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** A finite, positive amount (max_spend_usd is a dollar ceiling). */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * POST /api/v1/workspaces/:workspaceId/goals
 *
 * Owner-initiated goal creation (#1289 — the goal loop shipped with no way
 * for a HUMAN to start one from the console; the only creation path was
 * Jace's own `create_goal` tool, gated behind an in-chat confirmation). This
 * route is that missing console-side creation path — the "New goal" form on
 * the Goals page. It is its OWN endpoint, not a reuse of
 * `api/v1/runner/goals/*` — those routes authenticate the central Jace
 * coordinator secret (`requireJaceConsoleSecret`), a completely different
 * trust boundary than a signed-in console member.
 *
 * Deliberately NOT routed through Jace's `create_goal` tool or its
 * `consoleGatedApproval` gate: the human filling out this form on the
 * console IS the confirmation (they typed the objective, picked the repo,
 * set the leash themselves) — there is no second party whose approval is
 * being gated here, unlike a chat-originated goal where Jace proposes and a
 * human confirms.
 *
 * Role-gated owner/admin (mirrors `repos/route.ts`'s own `ADMIN_ROLES`
 * exactly): a goal commits real spend via its `maxSpendUsd` leash, the same
 * class of workspace-configuration action as connecting a repository, so a
 * plain member's request is rejected here even if the console UI never
 * rendered the form for them.
 *
 * `isGoalLoopEnabled` is checked BEFORE any goal-table read/write and
 * 404s when off (never 403 — same "the feature doesn't exist yet" posture
 * `isConsoleChatEnabled`'s gate on the chat route already established).
 *
 * `repositoryId` is caller-supplied (the human picks it from a select of
 * the workspace's OWN repos) rather than auto-resolved to "the first repo"
 * the way the Jace-chat path does. Validated with
 * `getRepository(workspaceId, repositoryId)` so a repo id from another
 * workspace (or a nonexistent one) 400s rather than silently creating a
 * goal against the wrong repo — a goal MUST be tied to a real repository in
 * this workspace; there is no "no repo" goal.
 *
 * `slug` is derived from `objective` server-side (never caller-supplied)
 * via `deriveUniqueSlug` above.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Owner or admin role required" }, { status: 403 });
  }

  if (!(await isGoalLoopEnabled(workspaceId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as RawBody;
  const errors: Record<string, string> = {};

  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective) {
    errors.objective = "objective is required";
  } else if (objective.length > OBJECTIVE_MAX) {
    errors.objective = `objective exceeds ${OBJECTIVE_MAX} characters`;
  }

  // Accepted as `repository_id` (snake_case) — matches every other
  // console route's own JSON body convention (e.g. `repos/route.ts`'s
  // `default_branch`), not the DB layer's camelCase `repositoryId`.
  const repositoryId = typeof body.repository_id === "string" ? body.repository_id.trim() : "";
  if (!repositoryId) {
    errors.repository_id = "repository_id is required";
  }

  const checkType = body.check_type === "command" ? "command" : "metric";

  const checkMetric =
    typeof body.check_metric === "string" && body.check_metric.trim()
      ? body.check_metric.trim().slice(0, CHECK_METRIC_MAX)
      : undefined;

  let checkThreshold: number | undefined;
  if (body.check_threshold !== undefined) {
    if (!isPositiveInt(body.check_threshold)) {
      errors.check_threshold = "check_threshold must be a positive integer";
    } else {
      checkThreshold = body.check_threshold;
    }
  }

  let checkCommand: string | undefined;
  if (checkType === "command") {
    const trimmed = typeof body.check_command === "string" ? body.check_command.trim() : "";
    if (!trimmed) {
      errors.check_command = "check_command is required for a command check";
    } else if (trimmed.length > CHECK_COMMAND_MAX) {
      errors.check_command = `check_command exceeds ${CHECK_COMMAND_MAX} characters`;
    } else {
      checkCommand = trimmed;
    }
  }

  let maxIssues = DEFAULT_MAX_ISSUES;
  if (body.max_issues !== undefined) {
    if (
      !isPositiveInt(body.max_issues) ||
      body.max_issues < MIN_MAX_ISSUES ||
      body.max_issues > MAX_MAX_ISSUES
    ) {
      errors.max_issues = `max_issues must be an integer between ${MIN_MAX_ISSUES} and ${MAX_MAX_ISSUES}`;
    } else {
      maxIssues = body.max_issues;
    }
  }

  let maxSpendUsd = DEFAULT_MAX_SPEND_USD;
  if (body.max_spend_usd !== undefined) {
    if (
      !isPositiveNumber(body.max_spend_usd) ||
      body.max_spend_usd < MIN_MAX_SPEND_USD ||
      body.max_spend_usd > MAX_MAX_SPEND_USD
    ) {
      errors.max_spend_usd = `max_spend_usd must be a number between ${MIN_MAX_SPEND_USD} and ${MAX_MAX_SPEND_USD}`;
    } else {
      maxSpendUsd = body.max_spend_usd;
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  // Repo-required rule (hard requirement — a goal is tied to a repo): a
  // caller-supplied id that doesn't resolve to a REAL repository IN THIS
  // WORKSPACE 400s here rather than silently creating an orphaned goal.
  const repository = await getRepository(workspaceId, repositoryId);
  if (!repository) {
    return NextResponse.json(
      { errors: { repository_id: "repository not found in this workspace" } },
      { status: 400 }
    );
  }

  const slug = await deriveUniqueSlug(workspaceId, objective);

  const goal = await createGoal({
    workspaceId,
    repositoryId,
    objective,
    slug,
    checkType,
    checkMetric: checkType === "metric" ? (checkMetric ?? "green_run_count") : checkMetric,
    checkThreshold,
    checkCommand,
    maxIssues,
    maxSpendUsd,
  });

  return NextResponse.json(
    {
      goal: {
        id: goal.id,
        objective: goal.objective,
        slug: goal.slug,
        repository_id: goal.repositoryId,
        status: goal.status,
        check_type: goal.checkType,
        check_metric: goal.checkMetric,
        check_threshold: goal.checkThreshold,
        check_command: goal.checkCommand,
        max_issues: goal.maxIssues,
        max_spend_usd: goal.maxSpendUsd,
        created_at: goal.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
