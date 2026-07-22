import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  findQueueEntryByExternalId,
  reviseAlignmentBrief,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { postAlignmentBrief } from "../../../../../../lib/alignment-reconciler";

/**
 * POST /api/v1/runner/queue-entries/revise
 *
 * The #1345 revise loop's re-briefing trigger: `update_issue`'s core module
 * (`apps/jace/agent/lib/update_issue.core.mjs::triggerReviseAlignmentBrief`)
 * calls this, best-effort, right after it successfully PATCHes a GitHub
 * issue's title/body. This route decides — and performs — everything about
 * "does this edited issue map to a DENIED alignment hold, and if so,
 * supersede that denial with a fresh brief":
 *
 *   1. Resolve the REAL tenant server-side from `eveSessionId` via the
 *      `jace_sessions` ledger (`getJaceSessionByEveSessionId`) — same
 *      resolution chain as `POST /api/v1/runner/approvals`, never trusting
 *      caller-supplied workspace input (owner rule: server-derived, never
 *      caller-supplied).
 *   2. Look up the queue entry this (repoFullName, number) address maps to
 *      in THAT workspace (`findQueueEntryByExternalId`).
 *   3. Ask `reviseAlignmentBrief` to supersede the denial — it is the ONLY
 *      function that performs the state transition, and it is a guarded,
 *      idempotent no-op unless the entry is CURRENTLY denied (see its own
 *      doc-comment in `@agentrail/db-postgres`).
 *   4. Only when that transition actually happened (`ok: true`) does this
 *      route compose+post a FRESH alignment brief — reusing
 *      `postAlignmentBrief`, the EXACT SAME composer/record/send path
 *      admission-time briefs and the PR③ reconciler already use — with a
 *      request id derived from the transition's own `updatedAt` so this
 *      NEW brief lands on a NEW `jace_approvals` row rather than colliding
 *      with the denied one (see `postAlignmentBrief`'s own `requestId`
 *      param doc for why that matters).
 *
 * EVERY non-actionable outcome (no workspace resolved, no matching queue
 * entry, entry not currently denied) responds 200 `{ revised: false, reason
 * }` — never an error. This is deliberate: `update_issue` is also a
 * general-purpose house-format edit tool independent of the revise loop, so
 * "this edit doesn't correspond to a denied alignment hold" is the COMMON
 * case, not a failure. The caller (`triggerReviseAlignmentBrief`) treats
 * this whole route as best-effort anyway and never surfaces its response to
 * the tool's own result either way.
 *
 * AC3 (the gate invariant): this route never itself decides the entry is
 * "aligned" or writes anything claimable — `reviseAlignmentBrief` never
 * touches `state` and never writes anything but `null` into
 * estimatedBudgetUsd/modelOverride/taskType (see that function's own
 * doc-comment). The ONLY path from here to a claimable `queued` row is a
 * human approving the FRESH brief this route posts, which resolves through
 * `applyAlignmentDecision` -> `confirmAlignmentBrief` — completely
 * untouched by this route.
 */

interface RawBody {
  eveSessionId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
}

function isRawBody(value: unknown): value is RawBody {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b["eveSessionId"] === "string" &&
    b["eveSessionId"].length > 0 &&
    typeof b["repoFullName"] === "string" &&
    b["repoFullName"].length > 0 &&
    typeof b["number"] === "number" &&
    Number.isFinite(b["number"]) &&
    typeof b["title"] === "string" &&
    typeof b["body"] === "string"
  );
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRawBody(raw)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), repoFullName (string), " +
          "number (number), title (string), and body (string)",
      },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(raw.eveSessionId);
  if (!session || !session.workspaceId) {
    // No workspace resolved yet (an intro/chat-identity-only session, or no
    // session at all) — there is no tenant to scope a queue-entry lookup to.
    // Best-effort, never an error: the caller only ever treats this route as
    // "ask, don't require."
    return NextResponse.json({ revised: false, reason: "no_workspace" });
  }

  const entry = await findQueueEntryByExternalId(
    session.workspaceId,
    raw.repoFullName,
    raw.number
  );
  if (!entry) {
    return NextResponse.json({ revised: false, reason: "not_found" });
  }

  const result = await reviseAlignmentBrief({
    queueEntryId: entry.id,
    title: raw.title,
    body: raw.body,
  });
  if (!result.ok) {
    // Either genuinely not denied (the common case for a plain house-format
    // edit) or a race that already resolved — either way, honest and
    // non-fatal.
    return NextResponse.json({ revised: false, reason: result.reason });
  }

  const outcome = await postAlignmentBrief({
    workspaceId: session.workspaceId,
    queueEntryId: entry.id,
    title: raw.title,
    body: raw.body,
    repoFullName: raw.repoFullName,
    number: raw.number,
    // Distinct per revise transition (this transition's own updatedAt), so
    // it can never collide with the denied approval's own deterministic
    // `alignment-brief:${queueEntryId}` request id, or with an EARLIER
    // revise round's request id for the SAME entry (deny -> revise -> deny
    // -> revise again produces a fresh timestamp each time).
    requestId: `alignment-brief:${entry.id}:revise-${result.updatedAt.getTime()}`,
  });

  return NextResponse.json({ revised: true, outcome });
}
