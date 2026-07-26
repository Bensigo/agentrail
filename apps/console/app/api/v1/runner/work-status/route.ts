import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getWorkspaceRuns,
  getWorkspaceQueueEntries,
  findWorkspaceWorkByRef,
  WORKSPACE_RUNS_DEFAULT_LIMIT,
  type WorkspaceRun,
  type WorkspaceQueueEntry,
  type ResolvedRefKind,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/work-status
 *
 * Jace's read seam for answering any question whose intent is "how's that
 * going" — the workspace's own runs and queue entries, so Jace can talk
 * about real state instead of guessing. This replaces an older tool that
 * read every workspace's rows with no `WHERE` clause at all; the entire
 * point of this route is that it cannot repeat that mistake.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the SAME guard every other Jace-coordinator route uses (see that
 * helper's own doc-comment). It answers only "is the caller Jace", never
 * "which workspace".
 *
 * TENANT RESOLUTION (`eveSessionId`, NOT a caller-supplied `workspaceId`):
 * this route resolves the real workspace server-side from `eveSessionId`
 * through the `jace_sessions` ledger (`getJaceSessionByEveSessionId` ->
 * `getChatIdentityById`), the EXACT chain `runner/pr-review`, `runner/repos`
 * and `runner/goals` already use. A query-string `workspaceId`, if a caller
 * ever sent one, is never read and never trusted — the invariant this whole
 * feature exists to preserve is that Jace cannot be asked to answer "how's
 * that going" for a workspace it wasn't actually talking to. Every read
 * below (`getWorkspaceRuns`, `getWorkspaceQueueEntries`,
 * `findWorkspaceWorkByRef`, from `packages/db-postgres/src/queries/work_status.ts`)
 * takes the resolved `workspaceId` as its only tenancy input and carries the
 * workspace predicate on every query — see that module's own doc-comment.
 *
 * Unlike `runner/pr-review`, this route names no repo, so there is no
 * repo<->workspace ownership check to add — it stops once `workspaceId` is
 * resolved.
 *
 * `ref` (optional): a free-text run id, GitHub issue number, fully-qualified
 * `owner/repo#N`, or PR number/link. A `ref` that belongs to another
 * workspace, or does not exist at all, comes back as the SAME 200 with empty
 * arrays — never a 404 — so the response can never be used to probe whether
 * something exists in a workspace the caller isn't actually in. See
 * `findWorkspaceWorkByRef`'s own doc-comment for why this is enforced at the
 * query layer, not just here.
 *
 * `limit` (optional, list mode only — ignored when `ref` is given): page
 * size for the runs/queue-entries lists, clamped to 1..200, default 50 (see
 * `LIMIT_MIN`/`LIMIT_MAX` below). The response echoes the applied limit and
 * a per-collection `truncated` flag so a caller can tell a full page from a
 * complete one instead of silently under-reporting (Important 3). NOTE:
 * this does not compute exact workspace-wide SQL aggregate totals (e.g.
 * total spend) — that remains a follow-up; a truncated page means the
 * caller has SOME but not ALL of the workspace's runs/queue entries.
 *
 * Every DB read is wrapped in try/catch — a connection blip or statement
 * timeout returns 502 "Upstream storage error" (with the real error logged
 * server-side) instead of an unhandled rejection / Next's generic 500. Same
 * pattern as `runner/onboard-status` and `runner/workspace-memory`.
 */

const LIMIT_MIN = 1;
const LIMIT_MAX = 200;

function parseLimit(raw: string | null): number {
  if (!raw) return WORKSPACE_RUNS_DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return WORKSPACE_RUNS_DEFAULT_LIMIT;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, parsed));
}

function serialiseRun(run: WorkspaceRun) {
  return {
    ...run,
    // Minor 9: `runs.prUrl` is `text("pr_url").default("")` — normalise the
    // empty-string default to null so a consumer checking `!== null` isn't
    // fooled into thinking a PR exists.
    prUrl: run.prUrl ? run.prUrl : null,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt ? run.updatedAt.toISOString() : null,
    lastLivenessAt: run.lastLivenessAt ? run.lastLivenessAt.toISOString() : null,
  };
}

function serialiseQueueEntry(entry: WorkspaceQueueEntry) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const ref = params.get("ref")?.trim() ?? "";
  const limit = parseLimit(params.get("limit"));

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  // Tenant resolution: eveSessionId -> jace_sessions -> chat identity ->
  // workspaceId. NEVER a caller-supplied workspace id — same chain
  // runner/pr-review, runner/repos and runner/goals use.
  let session, identity;
  try {
    session = await getJaceSessionByEveSessionId(eveSessionId);
    const chatIdentityId = session?.chatIdentityId ?? null;
    identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  } catch (err) {
    console.error("[runner/work-status] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

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

  let runRows: WorkspaceRun[];
  let queueRows: WorkspaceQueueEntry[];
  let runsTruncated = false;
  let queueTruncated = false;
  let resolvedAs: ResolvedRefKind | null = null;

  try {
    if (ref) {
      const result = await findWorkspaceWorkByRef(workspaceId, ref);
      runRows = result.runs;
      queueRows = result.queueEntries;
      resolvedAs = result.resolvedAs;
    } else {
      // Minor 10: run the two independent list reads concurrently.
      const [runsResult, queueResult] = await Promise.all([
        getWorkspaceRuns(workspaceId, limit),
        getWorkspaceQueueEntries(workspaceId, limit),
      ]);
      runRows = runsResult.rows;
      queueRows = queueResult.rows;
      runsTruncated = runsResult.truncated;
      queueTruncated = queueResult.truncated;
    }
  } catch (err) {
    console.error("[runner/work-status] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json(
    {
      ref: ref || null,
      resolvedAs,
      // Minor 11: server-stamped freshness marker — the consuming tool must
      // never answer from memory because this state goes stale.
      generatedAt: new Date().toISOString(),
      limit,
      runs: runRows.map(serialiseRun),
      queueEntries: queueRows.map(serialiseQueueEntry),
      truncated: { runs: runsTruncated, queueEntries: queueTruncated },
    },
    { status: 200 }
  );
}
