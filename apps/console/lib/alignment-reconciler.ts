import {
  findAlignmentBriefCandidates,
  githubIssueUrl,
  latestTelegramSessionForWorkspace,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { composeAlignmentBrief } from "./alignment-brief";
import { renderApprovalMessage } from "./approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * Alignment-brief posting + the reconciliation sweep that recovers a queue
 * entry stuck with no brief and no recovery path (#1274 PR③).
 *
 * `postAlignmentBrief` is a PURE MOVE of the function PR① wrote inline in
 * `apps/console/app/api/v1/connectors/github/webhook/route.ts` — same
 * logic, same outcomes, same never-throws-past-this-function contract (see
 * its own doc-comment below); the route now imports it from here instead of
 * defining it locally (regression-pinned: `route.test.ts` is unchanged and
 * still green). The only shape change is additive: `repoFullName`/`number`
 * are now OPTIONAL, so `reconcileAlignmentBriefs` below can call the exact
 * same compose->record->send flow for a queue entry that has no GitHub
 * issue to point at (a Python/CLI/Linear-admitted row) — every existing
 * caller (the webhook route) always supplies real values, so this widening
 * changes nothing for it.
 */

/**
 * The #1274 alignment-gate outcome, surfaced for observability/tests — the
 * webhook response contract for a non-alignment enqueue is unchanged (see
 * that route's own `matched: true, enqueued: 1, id` return).
 *
 * `compose_failed`/`session_lookup_failed` (adversarial review finding 2 of
 * #1274 PR ①): `composeAlignmentBrief` and `latestTelegramSessionForWorkspace`
 * used to run OUTSIDE any try/catch, contradicting this function's own
 * doc-comment ("never throws past this function") — an exception from
 * either would have propagated as an unhandled 500. Distinct from the
 * pre-existing `no_session` (a clean, expected zero-result lookup, not a
 * failure) so a real lookup error is never mistaken for "this workspace
 * legitimately has no Telegram session yet".
 */
export type AlignmentBriefOutcome =
  | "posted"
  | "no_session"
  | "record_failed"
  | "send_failed"
  | "compose_failed"
  | "session_lookup_failed";

/**
 * Compose + record + (best-effort) send the alignment brief for an ALREADY
 * PARKED queue entry.
 *
 * FAIL-SAFE ORDERING (locked design point 8, #1274 PR ①): the queue entry is
 * assumed already committed `parked` by the time this runs — every step
 * below (compose, the session lookup, record, send) is wrapped in its own
 * try/catch and returns a specific outcome string; NOTHING in this function
 * is allowed to throw past it. A failure anywhere here leaves an
 * honestly-labeled parked entry, never a silently-queued one.
 *
 * `repoFullName`/`number` are OPTIONAL (#1274 PR③ widening — see this
 * module's own doc-comment): absent for a non-GitHub-sourced entry (or one
 * whose external id doesn't parse as `owner/repo#N`). `composeAlignmentBrief`
 * still needs SOME `repoFullName`/`issueNumber`/`issueUrl` to satisfy its
 * type (they exist for the admission-time confirmed-brief URL-match lookup
 * — `findConfirmedAlignmentBriefApproval` in `github_intake.ts` — which this
 * function never calls), so a missing pair degrades to `""`/`0`/`""`. This
 * is safe: `renderAlignmentBrief` (`./approval-message.ts`) never reads
 * `repoFullName`/`issueNumber`/`issueUrl` at all — only `title`, `taskType`,
 * `suggestedModel`, `estimateUsd`, `whatToBuild`, `acceptanceCriteria`, and
 * `assumptions` reach the rendered Telegram message.
 */
export async function postAlignmentBrief(params: {
  workspaceId: string;
  queueEntryId: string;
  title: string;
  body: string;
  repoFullName?: string;
  number?: number;
}): Promise<AlignmentBriefOutcome> {
  const repoFullName = params.repoFullName ?? "";
  const number = params.number ?? 0;

  let brief: ReturnType<typeof composeAlignmentBrief>;
  try {
    brief = composeAlignmentBrief({
      title: params.title,
      body: params.body,
      repoFullName,
      issueNumber: number,
      issueUrl: repoFullName ? githubIssueUrl(repoFullName, number) : "",
    });
    if (!repoFullName) {
      // #1274 PR③ locked design point 3: "say so in the brief's assumptions
      // list — honest, not blocked". A non-GitHub-sourced entry (or one
      // whose external id didn't parse) has no issue link to show; the
      // brief still renders in full (title/approach/AC/estimate all come
      // from the row's own title+body, always populated — see this PR's
      // report) — only the link is missing, and this says so explicitly
      // rather than silently omitting it.
      brief = {
        ...brief,
        assumptions: [
          ...brief.assumptions,
          "No direct issue link available for this entry (admitted outside the GitHub webhook path).",
        ],
      };
    }
  } catch (err) {
    console.error(
      `[alignment-reconciler] composeAlignmentBrief threw while posting the alignment brief for queue entry ${params.queueEntryId}; entry stays parked ("awaiting alignment"):`,
      err
    );
    return "compose_failed";
  }

  // (b)-shaped posting (recon annex §6) needs an anchoring jace_sessions
  // row. For label-born/Python-admitted work there is no live Eve turn to
  // own one, so this repurposes the (a)-side lookup
  // (latestTelegramSessionForWorkspace) to find an EXISTING, possibly-idle
  // session to anchor a NEW, system-initiated approval against —
  // documented here rather than hidden, per the recon's own flag.
  // `eveSessionId` is NOT NULL on jace_approvals, so a session that has
  // never had a real Eve turn (eveSessionId still null) is just as unusable
  // as no session at all.
  let session: Awaited<ReturnType<typeof latestTelegramSessionForWorkspace>>;
  try {
    session = await latestTelegramSessionForWorkspace(params.workspaceId);
  } catch (err) {
    console.error(
      `[alignment-reconciler] latestTelegramSessionForWorkspace threw while posting the alignment brief for workspace ${params.workspaceId} (queue entry ${params.queueEntryId}); entry stays parked ("awaiting alignment"):`,
      err
    );
    return "session_lookup_failed";
  }
  if (!session || !session.eveSessionId) {
    console.error(
      `[alignment-reconciler] no usable Telegram session to anchor the alignment brief for workspace ${params.workspaceId} (queue entry ${params.queueEntryId}) — entry stays parked ("awaiting alignment"), no approval row created. The next reconciler sweep retries.`
    );
    return "no_session";
  }

  let approval: { id: string; callbackToken: string };
  let created: boolean;
  try {
    const recorded = await recordApprovalRequest({
      workspaceId: params.workspaceId,
      chatIdentityId: session.chatIdentityId ?? undefined,
      sessionId: session.id,
      eveSessionId: session.eveSessionId,
      // Deterministic per queue entry: idempotent on
      // (eveSessionId, requestId) — a redelivered webhook, or a repeat
      // reconciler sweep over the SAME still-unresolved entry, converges on
      // the SAME approval row rather than creating a duplicate.
      requestId: `alignment-brief:${params.queueEntryId}`,
      toolName: "alignment_brief",
      toolInput: brief as unknown as Record<string, unknown>,
      approveOptionId: "approve",
      denyOptionId: "deny",
      queueEntryId: params.queueEntryId,
    });
    approval = recorded.approval;
    created = recorded.created;
  } catch (err) {
    console.error(
      `[alignment-reconciler] recordApprovalRequest failed while posting the alignment brief for queue entry ${params.queueEntryId}; entry stays parked ("awaiting alignment"):`,
      err
    );
    return "record_failed";
  }

  // #1274 PR③ fix round, review finding I1: send ONLY when THIS call
  // actually created the row (the house pattern — the approvals POST route
  // gates its send on `created:true` the same way). Two CONCURRENT triggers
  // (webhook + result route, or two results) can both pass the sweep's
  // NOT-EXISTS check and both reach this record call; onConflictDoNothing
  // converges them on ONE row, and this gate makes exactly ONE of them the
  // sender — without it, both sent the identical Telegram brief (the
  // same-request call-order fix in the webhook route covers only
  // single-request geometry, not cross-request races). `created:false` here
  // means a racer/replay: the creator owns the send, so this caller is done
  // — the brief IS recorded, which is what "posted" reports.
  if (!created) {
    return "posted";
  }

  if (session.channel !== "telegram") {
    // Recorded, but v1 posting is Telegram-only (spec scope) — nothing to
    // send on this channel yet.
    return "posted";
  }

  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      `[alignment-reconciler] TELEGRAM_BOT_TOKEN is not configured; alignment brief approval ${approval.id} was recorded but no message was sent`
    );
    return "send_failed";
  }

  try {
    const text = renderApprovalMessage(
      "alignment_brief",
      brief as unknown as Record<string, unknown>
    );
    const keyboard = buildApprovalKeyboard(approval.callbackToken);
    const result = await sendTelegramMessage(
      token,
      session.conversationKey,
      text,
      keyboard
    );
    if (!result.ok) {
      console.error(
        `[alignment-reconciler] Telegram send failed for alignment brief approval ${approval.id}:`,
        result.error
      );
      return "send_failed";
    }
  } catch (err) {
    console.error(
      `[alignment-reconciler] unexpected error sending the alignment brief for approval ${approval.id}:`,
      err
    );
    return "send_failed";
  }

  return "posted";
}

/** The stable `owner/repo` + issue number a GitHub-sourced entry's
 * `external_id` (`owner/repo#N`) encodes — mirrors `unparkDependents`'s own
 * parsing in `github_intake.ts`. Returns nulls for a non-GitHub source, or a
 * malformed/unparseable external id (defensive; should not happen for a row
 * that passed the AC gate, but this function never throws either way). */
function deriveGithubRef(
  source: string,
  externalId: string
): { repoFullName: string; number: number } | null {
  if (source !== "github") return null;
  const hash = externalId.lastIndexOf("#");
  if (hash < 0) return null;
  const repoFullName = externalId.slice(0, hash);
  const number = Number(externalId.slice(hash + 1));
  if (!repoFullName || !Number.isFinite(number)) return null;
  return { repoFullName, number };
}

/** One reconciler sweep's outcome for one candidate entry. */
export interface ReconcileEntryOutcome {
  id: string;
  outcome: AlignmentBriefOutcome | "error";
}

/**
 * Find entries parked awaiting alignment with no recovery path IN THE GIVEN
 * WORKSPACE and post a fresh brief for each (#1274 PR③) — the recovery for:
 * Python-admitted rows (the Python admission funnel never posts a brief
 * itself, by design — see `agentrail/afk/queue_store.py`), PR①'s
 * no-session/compose-failed/record-failed paths, and a v2-guardrail park
 * whose reason `unparkDependents` later overwrote to
 * `ALIGNMENT_PARK_REASON` (the case the #1274 PR② reviewer flagged — see
 * `findAlignmentBriefCandidates`'s own doc-comment in `github_intake.ts`
 * for the full criterion, and its I2 fix-round note for why the sweep is
 * workspace-scoped, never global).
 *
 * Bounded (`limit`), oldest-first, and per-entry failure-isolated: one
 * entry throwing (from `postAlignmentBrief` itself, or from the surrounding
 * bookkeeping) is caught, logged loudly, and does not stop the sweep over
 * the rest. The CALLER (a route handler) is expected to treat the WHOLE
 * sweep as non-fatal too — see the github-webhook and runner-result routes,
 * both of which wrap this call in their own try/catch so a reconciler
 * failure never fails the webhook/result response.
 *
 * Denied entries are out of scope by construction: a denied row always
 * carries the approval that denied it, so `findAlignmentBriefCandidates`'s
 * own "no approval row" criterion already excludes them — no separate
 * denied-status check is needed here.
 *
 * CALL-ORDER WARNING for any caller that ALSO calls `postAlignmentBrief`
 * directly for a specific entry within the SAME request (as the
 * github-webhook route does, for the entry it just admitted): call THIS
 * function AFTER that direct call, never before. Before the direct call
 * resolves, the just-admitted entry has no approval row yet and would
 * match this sweep's own candidate query — `postAlignmentBrief`'s own
 * `recordApprovalRequest` is idempotent (same deterministic `requestId`),
 * so a same-request race can't create a second DB row, but it sends the
 * Telegram message unconditionally after recording (no created-vs-found
 * check) — so racing the two would send the identical brief twice. See the
 * github-webhook route's own comment at its call site.
 */
export async function reconcileAlignmentBriefs(
  workspaceId: string,
  limit: number
): Promise<ReconcileEntryOutcome[]> {
  const candidates = await findAlignmentBriefCandidates(workspaceId, limit);

  const outcomes: ReconcileEntryOutcome[] = [];
  for (const row of candidates) {
    try {
      const ref = deriveGithubRef(row.source, row.externalId);
      const outcome = await postAlignmentBrief({
        workspaceId: row.workspaceId,
        queueEntryId: row.id,
        title: row.title,
        body: row.body,
        repoFullName: ref?.repoFullName,
        number: ref?.number,
      });
      console.log(
        `[alignment-reconciler] queue entry ${row.id} (source=${row.source}): ${outcome}`
      );
      outcomes.push({ id: row.id, outcome });
    } catch (err) {
      console.error(
        `[alignment-reconciler] queue entry ${row.id} threw during reconciliation:`,
        err
      );
      outcomes.push({ id: row.id, outcome: "error" });
    }
  }
  return outcomes;
}
