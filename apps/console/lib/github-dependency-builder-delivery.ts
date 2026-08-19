import {
  getGithubDependencyBuilderCredential,
  reportAcceptanceDependencyBuilderDelivery,
  reserveAcceptanceDependencyBuilderDelivery,
} from "@agentrail/db-postgres";
import { postGithubDependencyBuilderComment } from "./github-dependency-builder-comment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GithubDependencyBuilderDeliveryResult =
  | { kind: "carrier_accepted"; deliveryId: string; githubCommentId: string; githubCommentUrl: string }
  | { kind: "held"; reason: "reserved" | "ambiguous_hold" | "storage_unavailable" }
  | { kind: "bounded_failed"; deliveryId: string }
  | { kind: "terminal"; deliveryId: string; status: "carrier_accepted" | "bounded_failed" }
  | { kind: "not_found" | "not_current" | "not_authorized" | "not_ready" | "invalid_input" };

async function close(input: Parameters<typeof reportAcceptanceDependencyBuilderDelivery>[0]): Promise<boolean> {
  try {
    return (await reportAcceptanceDependencyBuilderDelivery(input)).kind !== "not_current";
  } catch {
    return false;
  }
}

/** Reserve first, perform one selected-recipient write, then close custody. */
export async function runGithubDependencyBuilderDelivery(input: {
  workspaceId: string;
  recordId: string;
  externalBuilderPackEventId: string;
  requestedBy: string;
}): Promise<GithubDependencyBuilderDeliveryResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 4 || !UUID.test(input.workspaceId)
    || !UUID.test(input.recordId) || !UUID.test(input.externalBuilderPackEventId)
    || !/^user:[0-9a-f-]{36}$/i.test(input.requestedBy)) return { kind: "invalid_input" };
  let reservation: Awaited<ReturnType<typeof reserveAcceptanceDependencyBuilderDelivery>>;
  try {
    reservation = await reserveAcceptanceDependencyBuilderDelivery(input);
  } catch {
    return { kind: "held", reason: "storage_unavailable" };
  }
  if (reservation.kind === "not_found" || reservation.kind === "not_current" || reservation.kind === "not_authorized") return reservation;
  if (reservation.kind === "not_ready") return { kind: "not_ready" };
  if (reservation.kind === "held") return reservation;
  if (reservation.kind === "terminal") return reservation;
  if (reservation.kind !== "reserved") return { kind: "not_current" };
  const { delivery, body } = reservation;
  let credential: Awaited<ReturnType<typeof getGithubDependencyBuilderCredential>>;
  try {
    credential = await getGithubDependencyBuilderCredential({
      workspaceId: input.workspaceId,
      repo: delivery.repo,
      expectedInstallationIdentitySha256: delivery.githubInstallationIdentitySha256,
    });
  } catch {
    const closed = await close({ workspaceId: input.workspaceId, deliveryId: delivery.id, outcome: { kind: "unknown_post_outcome", reason: "storage_unavailable" } });
    return closed ? { kind: "held", reason: "ambiguous_hold" } : { kind: "held", reason: "storage_unavailable" };
  }
  if (!credential.ok) {
    const outcome = credential.kind === "unavailable"
      ? { kind: "bounded_failed" as const, reason: "credential_unavailable" as const }
      : { kind: "unknown_post_outcome" as const, reason: credential.reason === "storage_unavailable" ? "storage_unavailable" as const : "github_unavailable" as const };
    const closed = await close({ workspaceId: input.workspaceId, deliveryId: delivery.id, outcome });
    if (!closed) return { kind: "held", reason: "storage_unavailable" };
    return outcome.kind === "bounded_failed"
      ? { kind: "bounded_failed", deliveryId: delivery.id }
      : { kind: "held", reason: "ambiguous_hold" };
  }
  const posted = await postGithubDependencyBuilderComment({
    token: credential.token,
    repo: delivery.repo,
    prNumber: delivery.prNumber,
    body,
  });
  const outcome: Parameters<typeof reportAcceptanceDependencyBuilderDelivery>[0]["outcome"] = posted.kind === "published"
    ? { kind: "carrier_accepted", githubCommentId: posted.commentId, githubCommentUrl: posted.commentUrl, bodySha256: posted.bodySha256 }
    : posted.kind === "known_failure"
      ? { kind: "bounded_failed", reason: posted.reason === "invalid_input" ? "invalid_db_issued_body" : "github_rejected" }
      : { kind: "unknown_post_outcome", reason: posted.reason };
  const closed = await close({ workspaceId: input.workspaceId, deliveryId: delivery.id, outcome });
  if (!closed) return { kind: "held", reason: "storage_unavailable" };
  if (posted.kind === "unknown") return { kind: "held", reason: "ambiguous_hold" };
  if (posted.kind === "known_failure") return { kind: "bounded_failed", deliveryId: delivery.id };
  return { kind: "carrier_accepted", deliveryId: delivery.id, githubCommentId: posted.commentId, githubCommentUrl: posted.commentUrl };
}
