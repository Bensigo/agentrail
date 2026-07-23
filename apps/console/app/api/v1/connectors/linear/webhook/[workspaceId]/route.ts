import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getConnector, enqueueLinearIssue } from "@agentrail/db-postgres";
import {
  postAlignmentBrief,
  reconcileAlignmentBriefs,
} from "../../../../../../../lib/alignment-reconciler";

/**
 * Linear `Issue` webhook receiver (#1292) — Linear's real-time twin of the GitHub
 * `issues` webhook route. When a Linear issue reaches the workspace's trigger
 * label, it is admitted into the SAME durable Issue Queue in real time, instead
 * of only by the legacy `agentrail heartbeat` poll (which double-claims when run
 * alongside the runner path — the hazard this closes). The logged-in runner then
 * claims it via `/api/v1/runner/claim`, exactly as for a GitHub- or CLI-born
 * entry. Mirrors `apps/console/app/api/v1/connectors/github/webhook/route.ts`.
 *
 * PER-WORKSPACE URL (`/api/v1/connectors/linear/webhook/<workspaceId>`): a Linear
 * delivery carries no repo to resolve the owning workspace from (a GitHub
 * delivery carries `repository.full_name` -> `findWorkspaceByRepo`; Linear does
 * not), so the workspace is taken from the URL path — the same shape the Jace
 * inbound (`connectors/jace/inbound/[workspaceId]`) route uses. The HMAC signing
 * secret is then the per-workspace `connectors.config.webhookSecret` on the
 * `linear` row (persisted by the sibling
 * `workspaces/[workspaceId]/connectors/linear/webhook` route, mirroring how the
 * GitHub `/setup` action persists ITS secret into `config.webhookSecret`).
 *
 * SIGNATURE (verify-before-acting — MANDATORY): Linear signs each delivery with
 * an HMAC-SHA256 hex digest of the RAW request body, keyed by the webhook signing
 * secret, in the `linear-signature` header, plus a `linear-timestamp` header (ms
 * since epoch) echoed in the body's `webhookTimestamp`. We recompute the HMAC over
 * the raw body and timing-safe-compare, THEN reject a timestamp more than 60s from
 * now (replay window) — byte-for-byte the scheme Linear's own
 * `LinearWebhookClient.verify` uses (verified via the Linear SDK docs). Unlike the
 * GitHub route (which SKIPS verification when no secret is configured — "insecure
 * but convenient" for local dev), a Linear delivery with NO configured secret is
 * REFUSED (401): #1292's mandate is to never act on an unverified webhook. A
 * global `LINEAR_WEBHOOK_SECRET` env var is the only local-dev fallback.
 */

const SIGNATURE_HEADER = "linear-signature";
const TIMESTAMP_HEADER = "linear-timestamp";
// Matches LinearWebhookClient.verify's own 1-minute window.
const REPLAY_WINDOW_MS = 60_000;

// Linear issue-webhook `action`s that (re)admit work. `remove` is ignored (a
// deleted/archived issue is not queue work); a label added later arrives as
// `update`, so both `create` and `update` can carry the trigger label.
const TRIGGER_ACTIONS = new Set(["create", "update"]);

type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Verify a Linear webhook delivery: HMAC-SHA256 over the RAW body keyed by the
 * signing secret, timing-safe-compared against `linear-signature`, then a
 * replay-window check on the signed timestamp. Never acts on an unverified
 * delivery — a missing secret, missing/mismatched signature, or a stale/missing
 * timestamp all fail closed.
 */
function verifyLinearSignature(
  raw: string,
  signature: string | null,
  secret: string | undefined,
  timestamp: number | undefined
): VerifyResult {
  if (!secret) return { ok: false, error: "linear webhook secret not configured" };
  if (!signature) return { ok: false, error: "missing linear-signature header" };

  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "invalid signature" };
  }

  // Replay guard. The HMAC above already covers the raw body (which contains
  // `webhookTimestamp`), so the timestamp can't be altered without breaking the
  // signature — but a captured, still-valid delivery could be REPLAYED, so bound
  // its age exactly like Linear's SDK does (±60s).
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return { ok: false, error: "missing or invalid timestamp" };
  }
  if (Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
    return { ok: false, error: "stale timestamp (possible replay)" };
  }
  return { ok: true };
}

/**
 * The label names on a Linear issue webhook's `data`. Linear's Issue payload
 * carries `labels` as an array of `{ id, name, … }` objects; we collect the
 * names (also tolerating a plain-string array defensively), mirroring the GitHub
 * route's `labelNames`. The trigger check is a name match, exactly as the Python
 * poll path filters (`issues(filter: { labels: { name: { eq: $label } } })`).
 */
function linearLabelNames(issue: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const labels = issue["labels"];
  if (Array.isArray(labels)) {
    for (const lab of labels) {
      if (typeof lab === "string") names.add(lab);
      else if (
        lab &&
        typeof lab === "object" &&
        typeof (lab as Record<string, unknown>).name === "string"
      ) {
        names.add((lab as Record<string, string>).name);
      }
    }
  }
  return names;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestampHeader = request.headers.get(TIMESTAMP_HEADER);

  // Parse first so the Issue type/action and the body's `webhookTimestamp`
  // fallback are available; an unparseable body still goes through the signature
  // check (which will fail closed) rather than being silently accepted.
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const connector = await getConnector(workspaceId, "linear");
  if (!connector || !connector.enabled) {
    // Missing or disabled connector (operator kill switch): a benign no-op 200 so
    // Linear doesn't retry-storm. We also have no secret to verify against here.
    return NextResponse.json({ ignored: "linear connector not enabled" });
  }

  const secret =
    connector.config.webhookSecret ?? process.env["LINEAR_WEBHOOK_SECRET"];

  const bodyTimestamp =
    payload && typeof payload["webhookTimestamp"] === "number"
      ? (payload["webhookTimestamp"] as number)
      : undefined;
  const timestamp =
    timestampHeader !== null && timestampHeader !== ""
      ? Number(timestampHeader)
      : bodyTimestamp;

  const verified = verifyLinearSignature(raw, signature, secret, timestamp);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  if (!payload) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Only Issue events carry queue work; ack everything else (Comment, Project, …).
  if (payload["type"] !== "Issue") {
    const type = payload["type"];
    return NextResponse.json({ ignored: typeof type === "string" ? type : "unknown" });
  }

  const action = payload["action"];
  if (typeof action !== "string" || !TRIGGER_ACTIONS.has(action)) {
    return NextResponse.json({
      matched: false,
      reason: `action ${String(action)} not a trigger`,
    });
  }

  const issue = payload["data"];
  if (!issue || typeof issue !== "object") {
    return NextResponse.json({ matched: false, reason: "missing issue data" });
  }
  const issueObj = issue as Record<string, unknown>;

  const triggerLabel = connector.config.triggerLabel;
  if (!triggerLabel || !linearLabelNames(issueObj).has(triggerLabel)) {
    return NextResponse.json({ matched: false, reason: "trigger label not on issue" });
  }

  const issueId = typeof issueObj["id"] === "string" ? issueObj["id"] : "";
  const number = Number(issueObj["number"] ?? 0);
  const title = typeof issueObj["title"] === "string" ? issueObj["title"] : "";
  // Linear's issue body field is `description` (mirrors the Python poll's
  // `body=node["description"]`).
  const body = typeof issueObj["description"] === "string" ? issueObj["description"] : "";
  if (!issueId || !Number.isFinite(number) || number <= 0) {
    return NextResponse.json({ matched: false, reason: "missing issue id or number" });
  }

  const result = await enqueueLinearIssue({ workspaceId, issueId, number, title, body });

  let responseBody: Record<string, unknown>;
  if (!result.enqueued) {
    responseBody = { matched: true, enqueued: 0, reason: result.reason };
  } else if (result.state === "parked" && result.parkedFor === "awaiting_alignment") {
    // Compose+post Jace's alignment brief for the just-parked entry — #1274
    // parity (AC2). The entry is ALREADY durably parked (enqueueLinearIssue's
    // insert committed), and postAlignmentBrief never throws past itself. Linear
    // has no GitHub repo/issue URL, so repoFullName/number are omitted; the brief
    // still renders in full from the row's own title+body (postAlignmentBrief
    // appends an honest "no direct issue link" assumption for such entries).
    const alignmentBrief = await postAlignmentBrief({
      workspaceId,
      queueEntryId: result.id,
      title,
      body,
    });
    responseBody = { matched: true, enqueued: 1, id: result.id, alignmentBrief };
  } else {
    responseBody = { matched: true, enqueued: 1, id: result.id };
  }

  // "Next queue activity" opportunistic sweep — recover OTHER brief-less parked
  // entries in this workspace (Linear rows admitted by the legacy Python
  // heartbeat, which posts no brief itself, are the primary case here). Runs
  // AFTER the direct post above (same ordering rule the github route documents),
  // bounded, best-effort, and NON-FATAL.
  try {
    await reconcileAlignmentBriefs(workspaceId, 5);
  } catch (err) {
    console.error("[linear/webhook] alignment-reconciler sweep failed:", err);
  }

  return NextResponse.json(responseBody);
}
