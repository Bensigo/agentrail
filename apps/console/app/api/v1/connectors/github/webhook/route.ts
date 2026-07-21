import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { findWorkspaceByRepo, getConnector, enqueueGithubIssue } from "@agentrail/db-postgres";
import {
  postAlignmentBrief,
  reconcileAlignmentBriefs,
} from "../../../../../../lib/alignment-reconciler";

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
 * deployed it's the public webhook URL configured on the repo. HMAC
 * verification uses the delivering workspace's per-connector secret
 * (`connectors.config.webhookSecret`, written by the /setup wizard — #1233),
 * falling back to the global `GITHUB_WEBHOOK_SECRET` env var for local
 * dev/testing. Because the secret is per-workspace, the payload is parsed and
 * the workspace resolved BEFORE the signature check.
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

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  // Parse FIRST: the signing secret is per-workspace (#1233), resolvable only
  // from `repository.full_name` in the payload. An unparseable body still gets
  // signature-checked against the global fallback below.
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const repository = payload?.repository;
  const repoFullName =
    repository && typeof repository === "object"
      ? (repository as Record<string, unknown>).full_name
      : undefined;

  // Resolve which workspace owns this repo (via its GitHub connector).
  let workspaceId: string | null = null;
  let connector: Awaited<ReturnType<typeof getConnector>> = null;
  if (typeof repoFullName === "string") {
    workspaceId = await findWorkspaceByRepo(repoFullName);
    if (workspaceId) {
      connector = await getConnector(workspaceId, "github");
    }
  }

  // Per-workspace secret wins; the global env var is the local-dev fallback.
  const secret =
    connector?.config.webhookSecret ?? process.env["GITHUB_WEBHOOK_SECRET"];
  if (!verifySignature(raw, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Only `issues` events carry work; ack ping / others.
  const event = request.headers.get("x-github-event") ?? "";
  if (event !== "issues") {
    return NextResponse.json({ ignored: event || "unknown" });
  }

  if (!payload) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const action = payload.action;
  if (typeof action !== "string" || !TRIGGER_ACTIONS.has(action)) {
    return NextResponse.json({ matched: false, reason: `action ${String(action)} not a trigger` });
  }

  const issue = payload.issue;
  if (!issue || typeof issue !== "object" || !repository || typeof repository !== "object") {
    return NextResponse.json({ matched: false, reason: "missing issue or repository" });
  }
  const issueObj = issue as Record<string, unknown>;
  if (typeof repoFullName !== "string") {
    return NextResponse.json({ matched: false, reason: "missing repository.full_name" });
  }

  if (!workspaceId) {
    return NextResponse.json({ matched: false, reason: "no workspace owns this repo" });
  }

  // The trigger label is the connector's configured label.
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

  let responseBody: Record<string, unknown>;
  if (!result.enqueued) {
    responseBody = { matched: true, enqueued: 0, reason: result.reason };
  } else if (result.state === "parked" && result.parkedFor === "awaiting_alignment") {
    // #1274: this enqueue parked the entry via the alignment hold (not a
    // dependency/guardrail park — those never set parkedFor) — compose+post
    // Jace's alignment brief. The entry is ALREADY durably parked at this
    // point (enqueueGithubIssue's insert already committed), so any failure
    // below is caught inside postAlignmentBrief itself and never turns into a
    // silently-queued row.
    const alignmentBrief = await postAlignmentBrief({
      workspaceId,
      queueEntryId: result.id,
      repoFullName,
      number,
      title,
      body,
    });
    responseBody = { matched: true, enqueued: 1, id: result.id, alignmentBrief };
  } else {
    responseBody = { matched: true, enqueued: 1, id: result.id };
  }

  // #1274 PR③: this admission attempt is a "next queue activity" trigger to
  // sweep for OTHER stale, brief-less parked entries IN THIS WORKSPACE
  // (workspace-scoped by the sweep itself — I2 fix round; see
  // findAlignmentBriefCandidates' own doc-comment) — Python-admitted rows,
  // a prior postAlignmentBrief failure, a v2-guardrail park
  // unparkDependents relabeled. Runs AFTER the branch above, not before:
  // the branch above already gave the row THIS request just admitted its
  // own explicit postAlignmentBrief attempt — running the sweep first would
  // let it race that same call for the SAME entry within this one request
  // (the I1 created-gate now ALSO covers cross-request races at the send
  // itself, but keeping this request's own two calls ordered stays the
  // cleaner geometry: one obvious owner per entry per request). Bounded,
  // best-effort, and NON-FATAL: a reconciler failure must never fail this
  // webhook's response, so it is caught here regardless of what caused it
  // (findAlignmentBriefCandidates itself is also defensive, but this is
  // the outer belt-and-suspenders).
  try {
    await reconcileAlignmentBriefs(workspaceId, 5);
  } catch (err) {
    console.error("[github/webhook] alignment-reconciler sweep failed:", err);
  }

  return NextResponse.json(responseBody);
}
