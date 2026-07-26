import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getWorkspaceRuns,
  getWorkspaceQueueEntries,
  findWorkspaceWorkByRef,
  type WorkspaceRun,
  type WorkspaceQueueEntry,
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
 * `ref` (optional): a free-text run id or queue entry externalId (e.g. a
 * GitHub issue number). A `ref` that belongs to another workspace, or does
 * not exist at all, comes back as the SAME 200 with empty arrays — never a
 * 404 — so the response can never be used to probe whether something exists
 * in a workspace the caller isn't actually in. See
 * `findWorkspaceWorkByRef`'s own doc-comment for why this is enforced at the
 * query layer, not just here.
 */

function serialiseRun(run: WorkspaceRun) {
  return {
    ...run,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
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

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  // Tenant resolution: eveSessionId -> jace_sessions -> chat identity ->
  // workspaceId. NEVER a caller-supplied workspace id — same chain
  // runner/pr-review, runner/repos and runner/goals use.
  const session = await getJaceSessionByEveSessionId(eveSessionId);
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

  const { runs, queueEntries } = ref
    ? await findWorkspaceWorkByRef(workspaceId, ref)
    : {
        runs: await getWorkspaceRuns(workspaceId),
        queueEntries: await getWorkspaceQueueEntries(workspaceId),
      };

  return NextResponse.json(
    {
      ref: ref || null,
      runs: runs.map(serialiseRun),
      queueEntries: queueEntries.map(serialiseQueueEntry),
    },
    { status: 200 }
  );
}
