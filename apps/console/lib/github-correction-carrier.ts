/**
 * Server-internal two-stage selected-route carrier. DB reservations own every
 * target, body, packet bundle, terminal state, and retry decision; Console
 * only posts the exact DB-issued bodies and reports bounded receipts.
 */
import {
  getGithubCorrectionCarrierCredential,
  reportGithubCorrectionActivation,
  reportGithubCorrectionFindingPublication,
  reserveGithubCorrectionActivation,
  reserveNextGithubCorrectionFindingPublication,
} from "@agentrail/db-postgres";
import { preflightGithubCorrectionCarrier } from "./github-correction-carrier-preflight";
import { readCurrentGithubPullRequest } from "./github-current-pr";
import {
  postGithubCorrectionCarrierComment,
  validateDbIssuedGithubCorrectionActivationBody,
} from "./github-correction-carrier-comment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FINDING_PUBLICATIONS = 128;

export type GithubCorrectionCarrierInput = { workspaceId: string; dispatchId: string };
export type GithubCorrectionCarrierResult =
  | { kind: "carrier_accepted"; githubCommentId: string; githubCommentUrl: string }
  | { kind: "bounded_failed" }
  | { kind: "fallback_candidate"; reason: "carrier_unavailable" }
  | { kind: "held"; reason: "unknown_post_outcome" | "storage_unavailable" }
  | { kind: "not_ready" | "not_current" | "invalid_input" };

function isInput(value: unknown): value is GithubCorrectionCarrierInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2
    && typeof input.workspaceId === "string" && UUID.test(input.workspaceId)
    && typeof input.dispatchId === "string" && UUID.test(input.dispatchId);
}

async function reportFinding(input: {
  workspaceId: string;
  publicationId: string;
  outcome: Parameters<typeof reportGithubCorrectionFindingPublication>[0]["outcome"];
}): Promise<"reported" | "not_current" | "storage_unavailable"> {
  try {
    const result = await reportGithubCorrectionFindingPublication(input);
    return result.kind === "not_current" ? "not_current" : "reported";
  } catch {
    return "storage_unavailable";
  }
}

async function reportActivation(input: {
  workspaceId: string;
  activationId: string;
  outcome: Parameters<typeof reportGithubCorrectionActivation>[0]["outcome"];
}): Promise<"reported" | "not_current" | "storage_unavailable"> {
  try {
    const result = await reportGithubCorrectionActivation(input);
    return result.kind === "not_current" ? "not_current" : "reported";
  } catch {
    return "storage_unavailable";
  }
}

/**
 * Publishes all DB-reserved ordinary findings first, then only a DB-gated final
 * selected-recipient activation. It does not accept route, recipient, body,
 * packet, head, or repository input from any caller and makes no acknowledgement
 * or repair claim.
 */
export async function runGithubCorrectionCarrier(
  input: GithubCorrectionCarrierInput
): Promise<GithubCorrectionCarrierResult> {
  if (!isInput(input)) return { kind: "invalid_input" };
  const preflight = await preflightGithubCorrectionCarrier(input);
  if (preflight.kind === "not_current") return { kind: "not_current" };
  if (preflight.kind === "unavailable") {
    if (preflight.reason === "remote_pr_not_active"
      || preflight.reason === "remote_head_mismatch"
      || preflight.reason === "remote_base_mismatch") return { kind: "not_current" };
    if (preflight.reason === "invalid_input") return { kind: "invalid_input" };
    if (preflight.reason === "storage_unavailable") {
      return { kind: "held", reason: "storage_unavailable" };
    }
    return { kind: "fallback_candidate", reason: "carrier_unavailable" };
  }
  if (preflight.kind === "indeterminate") {
    return preflight.reason === "storage_unavailable"
      ? { kind: "held", reason: "storage_unavailable" }
      : { kind: "fallback_candidate", reason: "carrier_unavailable" };
  }
  if (preflight.kind !== "ready") return { kind: "not_ready" };

  // Mint after ready preflight but before any delivery reservation. A failed
  // credential therefore cannot strand a publication row in reserved state.
  let credential: Awaited<ReturnType<typeof getGithubCorrectionCarrierCredential>>;
  try {
    credential = await getGithubCorrectionCarrierCredential({
      workspaceId: input.workspaceId,
      repo: preflight.repo,
    });
  } catch {
    return { kind: "held", reason: "storage_unavailable" };
  }
  if (!credential.ok) {
    return credential.kind === "indeterminate" && credential.reason === "storage_unavailable"
      ? { kind: "held", reason: "storage_unavailable" }
      : { kind: "fallback_candidate", reason: "carrier_unavailable" };
  }

  for (let count = 0; count < MAX_FINDING_PUBLICATIONS; count += 1) {
    let reservation: Awaited<ReturnType<typeof reserveNextGithubCorrectionFindingPublication>>;
    try {
      reservation = await reserveNextGithubCorrectionFindingPublication({
        workspaceId: input.workspaceId,
        dispatchId: input.dispatchId,
      });
    } catch {
      return { kind: "held", reason: "storage_unavailable" };
    }
    if (reservation.kind === "not_current") return { kind: "not_current" };
    if (reservation.kind === "held") return { kind: "held", reason: "unknown_post_outcome" };
    if (reservation.kind === "complete") break;

    const { publication, body } = reservation;
    const post = await postGithubCorrectionCarrierComment({
      token: credential.token,
      repo: preflight.repo,
      prNumber: preflight.prNumber,
      kind: "finding",
      body,
    });
    const outcome: Parameters<typeof reportGithubCorrectionFindingPublication>[0]["outcome"] = post.kind === "published"
      ? { kind: "published", githubCommentId: post.commentId, githubCommentUrl: post.commentUrl }
      : post.kind === "known_failure"
        ? {
          kind: "bounded_failed",
          reason: post.reason === "invalid_input" ? "invalid_db_issued_body" : post.reason,
        }
        : { kind: "unknown_post_outcome", reason: post.reason };
    const reported = await reportFinding({
      workspaceId: input.workspaceId,
      publicationId: publication.id,
      outcome,
    });
    if (reported === "not_current") return { kind: "not_current" };
    if (reported === "storage_unavailable") return { kind: "held", reason: "storage_unavailable" };
    if (post.kind === "unknown") return { kind: "held", reason: "unknown_post_outcome" };
  }

  // Findings may take long enough for the PR head to advance after the
  // original preflight. Re-read the authenticated remote immediately before
  // reserving the sole irreversible vendor mention. GitHub issue comments do
  // not offer a head-SHA precondition, so the remaining GET-to-POST interval
  // is an explicit carrier limitation rather than an atomicity claim.
  let remote: Awaited<ReturnType<typeof readCurrentGithubPullRequest>>;
  try {
    remote = await readCurrentGithubPullRequest({
      token: credential.token,
      repo: preflight.repo,
      prNumber: preflight.prNumber,
    });
  } catch {
    return { kind: "fallback_candidate", reason: "carrier_unavailable" };
  }
  if (!remote.ok) return { kind: "fallback_candidate", reason: "carrier_unavailable" };
  if (remote.pullRequest.state !== "open" || remote.pullRequest.draft || remote.pullRequest.merged
    || remote.pullRequest.headSha !== preflight.headSha
    || remote.pullRequest.baseSha !== preflight.baseSha) {
    return { kind: "not_current" };
  }

  let activationReservation: Awaited<ReturnType<typeof reserveGithubCorrectionActivation>>;
  try {
    activationReservation = await reserveGithubCorrectionActivation({
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
    });
  } catch {
    return { kind: "held", reason: "storage_unavailable" };
  }
  if (activationReservation.kind === "not_current") return { kind: "not_current" };
  if (activationReservation.kind === "held") return { kind: "held", reason: "unknown_post_outcome" };
  if (activationReservation.kind === "not_ready") return { kind: "not_ready" };
  if (activationReservation.kind === "carrier_accepted") {
    return {
      kind: "carrier_accepted",
      githubCommentId: activationReservation.githubCommentId,
      githubCommentUrl: activationReservation.githubCommentUrl,
    };
  }
  if (activationReservation.kind === "bounded_failed") return { kind: "bounded_failed" };

  const { activation, body, packetBundleBase64url, packetBundleSha256, recipient } = activationReservation;
  if (!validateDbIssuedGithubCorrectionActivationBody({
    body,
    recipient,
    packetBundleBase64url,
    packetBundleSha256,
  })) {
    const reported = await reportActivation({
      workspaceId: input.workspaceId,
      activationId: activation.id,
      outcome: { kind: "bounded_failed", reason: "invalid_db_issued_body" },
    });
    return reported === "not_current" ? { kind: "not_current" }
      : reported === "storage_unavailable" ? { kind: "held", reason: "storage_unavailable" }
        : { kind: "bounded_failed" };
  }
  const post = await postGithubCorrectionCarrierComment({
    token: credential.token,
    repo: preflight.repo,
    prNumber: preflight.prNumber,
    kind: "activation",
    body,
  });
  const outcome: Parameters<typeof reportGithubCorrectionActivation>[0]["outcome"] = post.kind === "published"
    ? { kind: "carrier_accepted", githubCommentId: post.commentId, githubCommentUrl: post.commentUrl }
    : post.kind === "known_failure"
      ? {
        kind: "bounded_failed",
        reason: post.reason === "invalid_input" ? "invalid_db_issued_body" : post.reason,
      }
      : { kind: "unknown_post_outcome", reason: post.reason };
  const reported = await reportActivation({
    workspaceId: input.workspaceId,
    activationId: activation.id,
    outcome,
  });
  if (reported === "not_current") return { kind: "not_current" };
  if (reported === "storage_unavailable") return { kind: "held", reason: "storage_unavailable" };
  if (post.kind === "unknown") return { kind: "held", reason: "unknown_post_outcome" };
  if (post.kind === "known_failure") return { kind: "bounded_failed" };
  return {
    kind: "carrier_accepted",
    githubCommentId: post.commentId,
    githubCommentUrl: post.commentUrl,
  };
}
