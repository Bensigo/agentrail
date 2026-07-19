import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  findWorkspaceByRepo,
  getConnector,
  enqueueGithubIssue,
  githubIssueUrl,
  latestTelegramSessionForWorkspace,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { renderApprovalMessage } from "../../../../../../lib/approval-message";
import { composeAlignmentBrief } from "../../../../../../lib/alignment-brief";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../../workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * GitHub `issues` webhook receiver — the trigger that fills the queue.
 *
 * In the self-hosted-runner model the backend owns the queue, so admitting a
 * GitHub issue is a SERVER job: GitHub POSTs an `issues` delivery here, and when
 * the issue carries the workspace's trigger label we enqueue it (through the
 * input-contract gate). The logged-in runner then claims it via
 * `/api/v1/runner/claim`. Mirrors `agentrail/heartbeat/webhook.py`.
 *
 * Locally, point a tunnel (smee.io / `gh webhook forward`) at this route; when
 * deployed it's the public webhook URL configured on the repo. Optional HMAC
 * verification via `GITHUB_WEBHOOK_SECRET`.
 */

// Actions that (re)admit work; others (closed, edited, assigned, …) are ignored.
const TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled"]);
const SIGNATURE_HEADER = "x-hub-signature-256";

function verifySignature(
  raw: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!secret) return true; // no secret configured → skip (insecure but convenient)
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function labelNames(issue: Record<string, unknown>): Set<string> {
  const labels = issue.labels;
  const names = new Set<string>();
  if (Array.isArray(labels)) {
    for (const lab of labels) {
      if (typeof lab === "string") names.add(lab);
      else if (lab && typeof lab === "object" && typeof (lab as Record<string, unknown>).name === "string") {
        names.add((lab as Record<string, string>).name);
      }
    }
  }
  return names;
}

/**
 * The #1274 alignment-gate outcome, surfaced only for observability/tests —
 * the webhook response contract for a non-alignment enqueue is unchanged
 * (see the `matched: true, enqueued: 1, id` return below).
 */
type AlignmentBriefOutcome = "posted" | "no_session" | "record_failed" | "send_failed";

/**
 * Compose + record + (best-effort) send the alignment brief for a queue entry
 * `enqueueGithubIssue` just parked via the alignment hold.
 *
 * FAIL-SAFE ORDERING (locked design point 8): the queue entry is ALREADY
 * committed `parked` by the time this runs (enqueueGithubIssue's insert has
 * already happened) — every branch below either finishes the posting or logs
 * loudly and returns, but NEVER throws past this function and NEVER touches
 * `queue_entries` itself. A failure anywhere here leaves an honestly-labeled
 * parked entry, never a silently-queued one.
 */
async function postAlignmentBrief(params: {
  workspaceId: string;
  queueEntryId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
}): Promise<AlignmentBriefOutcome> {
  const brief = composeAlignmentBrief({
    title: params.title,
    body: params.body,
    repoFullName: params.repoFullName,
    issueNumber: params.number,
    issueUrl: githubIssueUrl(params.repoFullName, params.number),
  });

  // (b)-shaped posting (recon annex §6) needs an anchoring jace_sessions row.
  // For label-born work there is no live Eve turn to own one, so this
  // repurposes the (a)-side lookup (latestTelegramSessionForWorkspace) to
  // find an EXISTING, possibly-idle session to anchor a NEW, system-initiated
  // approval against — documented here rather than hidden, per the recon's
  // own flag. `eveSessionId` is NOT NULL on jace_approvals, so a session that
  // has never had a real Eve turn (eveSessionId still null) is just as
  // unusable as no session at all.
  const session = await latestTelegramSessionForWorkspace(params.workspaceId);
  if (!session || !session.eveSessionId) {
    console.error(
      `[github/webhook] no usable Telegram session to anchor the alignment brief for workspace ${params.workspaceId} (queue entry ${params.queueEntryId}) — entry stays parked ("awaiting alignment"), no approval row created. Recovery is PR ③'s revise/re-post path.`
    );
    return "no_session";
  }

  let approval: { id: string; callbackToken: string };
  try {
    const { approval: recorded } = await recordApprovalRequest({
      workspaceId: params.workspaceId,
      chatIdentityId: session.chatIdentityId ?? undefined,
      sessionId: session.id,
      eveSessionId: session.eveSessionId,
      // Deterministic per queue entry: a redelivered webhook is already
      // deduped at the enqueue step (ON CONFLICT DO NOTHING never reaches
      // this function twice for the same issue), so this mainly guards a
      // hypothetical retry of THIS function itself.
      requestId: `alignment-brief:${params.queueEntryId}`,
      toolName: "alignment_brief",
      toolInput: brief as unknown as Record<string, unknown>,
      approveOptionId: "approve",
      denyOptionId: "deny",
      queueEntryId: params.queueEntryId,
    });
    approval = recorded;
  } catch (err) {
    console.error(
      `[github/webhook] recordApprovalRequest failed while posting the alignment brief for queue entry ${params.queueEntryId}; entry stays parked ("awaiting alignment"):`,
      err
    );
    return "record_failed";
  }

  if (session.channel !== "telegram") {
    // Recorded, but v1 posting is Telegram-only (spec scope) — nothing to
    // send on this channel yet.
    return "posted";
  }

  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      `[github/webhook] TELEGRAM_BOT_TOKEN is not configured; alignment brief approval ${approval.id} was recorded but no message was sent`
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
        `[github/webhook] Telegram send failed for alignment brief approval ${approval.id}:`,
        result.error
      );
      return "send_failed";
    }
  } catch (err) {
    console.error(
      `[github/webhook] unexpected error sending the alignment brief for approval ${approval.id}:`,
      err
    );
    return "send_failed";
  }

  return "posted";
}

export async function POST(request: NextRequest) {
  const raw = await request.text();

  if (
    !verifySignature(
      raw,
      request.headers.get(SIGNATURE_HEADER),
      process.env["GITHUB_WEBHOOK_SECRET"]
    )
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Only `issues` events carry work; ack ping / others.
  const event = request.headers.get("x-github-event") ?? "";
  if (event !== "issues") {
    return NextResponse.json({ ignored: event || "unknown" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const action = payload.action;
  if (typeof action !== "string" || !TRIGGER_ACTIONS.has(action)) {
    return NextResponse.json({ matched: false, reason: `action ${String(action)} not a trigger` });
  }

  const issue = payload.issue;
  const repository = payload.repository;
  if (!issue || typeof issue !== "object" || !repository || typeof repository !== "object") {
    return NextResponse.json({ matched: false, reason: "missing issue or repository" });
  }
  const issueObj = issue as Record<string, unknown>;
  const repoFullName = (repository as Record<string, unknown>).full_name;
  if (typeof repoFullName !== "string") {
    return NextResponse.json({ matched: false, reason: "missing repository.full_name" });
  }

  // Resolve which workspace owns this repo (via its GitHub connector).
  const workspaceId = await findWorkspaceByRepo(repoFullName);
  if (!workspaceId) {
    return NextResponse.json({ matched: false, reason: "no workspace owns this repo" });
  }

  // The trigger label is the connector's configured label.
  const connector = await getConnector(workspaceId, "github");
  const triggerLabel = connector?.config.triggerLabel;
  if (!triggerLabel || !labelNames(issueObj).has(triggerLabel)) {
    return NextResponse.json({ matched: false, reason: "trigger label not on issue" });
  }

  const number = Number(issueObj.number ?? 0);
  const title = typeof issueObj.title === "string" ? issueObj.title : "";
  const body = typeof issueObj.body === "string" ? issueObj.body : "";
  const result = await enqueueGithubIssue({
    workspaceId,
    repoFullName,
    number,
    title,
    body,
  });

  if (!result.enqueued) {
    return NextResponse.json({ matched: true, enqueued: 0, reason: result.reason });
  }

  // #1274: this enqueue parked the entry via the alignment hold (not a
  // dependency/guardrail park — those never set parkedFor) — compose+post
  // Jace's alignment brief. The entry is ALREADY durably parked at this
  // point (enqueueGithubIssue's insert already committed), so any failure
  // below is caught inside postAlignmentBrief itself and never turns into a
  // silently-queued row.
  if (result.state === "parked" && result.parkedFor === "awaiting_alignment") {
    const alignmentBrief = await postAlignmentBrief({
      workspaceId,
      queueEntryId: result.id,
      repoFullName,
      number,
      title,
      body,
    });
    return NextResponse.json({
      matched: true,
      enqueued: 1,
      id: result.id,
      alignmentBrief,
    });
  }

  return NextResponse.json({ matched: true, enqueued: 1, id: result.id });
}
