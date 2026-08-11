/**
 * Server-internal preparation seam for a possible GitHub correction carrier.
 * It proves only a scoped repository credential plus current PR eligibility;
 * it never publishes a comment, activates a recipient, or asserts vendor
 * availability.
 */
import {
  getGithubCorrectionCarrierCredential,
  reportGithubCorrectionCarrierPreflight,
  reserveGithubCorrectionCarrierPreflight,
} from "@agentrail/db-postgres";
import { readCurrentGithubPullRequest } from "./github-current-pr";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GithubCorrectionCarrierPreflightInput = {
  workspaceId: string;
  dispatchId: string;
};

export type GithubCorrectionCarrierPreflightProof = {
  wording: "Scoped repository grant and current pull request metadata were verified for a possible future GitHub carrier attempt. No comment was sent; delivery, recipient activation, acknowledgement, and vendor availability remain unproven.";
  repositoryGrant: "scoped_installation_token";
  issueCommentPermission: "issues_write";
  pullRequestPermission: "pull_requests_write";
  delivery: "not_attempted";
  activation: "not_started";
  acknowledgement: "not_observed";
  vendorAvailability: "not_asserted";
};

export type GithubCorrectionCarrierPreflightResult =
  | {
      kind: "ready";
      preflightId: string;
      repo: string;
      prNumber: number;
      headSha: string;
      baseSha: string;
      dispatchId: string;
      dispatchIdentitySha256: string;
      headCycleId: string;
      authorityGeneration: number;
      capabilityProfileId: string;
      capabilityProfileSnapshotSha256: string;
      permissionContract: string;
      proof: GithubCorrectionCarrierPreflightProof;
    }
  | { kind: "held" | "terminal" | "not_current" }
  | {
      kind: "unavailable" | "indeterminate";
      reason:
        | "invalid_input"
        | "installation_or_permission_denied"
        | "remote_pr_not_active"
        | "remote_head_mismatch"
        | "remote_base_mismatch"
        | "github_unavailable"
        | "invalid_github_response"
        | "storage_unavailable";
    };

function isInput(value: unknown): value is GithubCorrectionCarrierPreflightInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 2 &&
    typeof input.workspaceId === "string" &&
    typeof input.dispatchId === "string" &&
    UUID.test(input.workspaceId) &&
    UUID.test(input.dispatchId)
  );
}

const proof: GithubCorrectionCarrierPreflightProof = {
  wording:
    "Scoped repository grant and current pull request metadata were verified for a possible future GitHub carrier attempt. No comment was sent; delivery, recipient activation, acknowledgement, and vendor availability remain unproven.",
  repositoryGrant: "scoped_installation_token",
  issueCommentPermission: "issues_write",
  pullRequestPermission: "pull_requests_write",
  delivery: "not_attempted",
  activation: "not_started",
  acknowledgement: "not_observed",
  vendorAvailability: "not_asserted",
};

type ReportDisposition = "reported" | "not_current" | "storage_unavailable";

async function report(
  workspaceId: string,
  preflightId: string,
  outcome:
    | { kind: "ready"; headSha: string; baseSha: string }
    | { kind: "installation_or_permission_denied" }
    | { kind: "remote_pr_not_active"; headSha: string; baseSha: string }
    | { kind: "remote_head_mismatch"; expectedHeadSha: string; observedHeadSha: string }
    | { kind: "remote_base_mismatch"; expectedBaseSha: string; observedBaseSha: string }
    | { kind: "github_unavailable" }
    | { kind: "invalid_github_response" }
    | { kind: "storage_unavailable" }
): Promise<ReportDisposition> {
  try {
    const result = await reportGithubCorrectionCarrierPreflight({
      workspaceId,
      preflightId,
      outcome,
    });
    return result.kind === "reported" || result.kind === "replayed"
      ? "reported"
      : "not_current";
  } catch {
    return "storage_unavailable";
  }
}

function resultAfterUnreportedReport(
  disposition: ReportDisposition
): GithubCorrectionCarrierPreflightResult | null {
  if (disposition === "reported") return null;
  return disposition === "not_current"
    ? { kind: "not_current" }
    : { kind: "indeterminate", reason: "storage_unavailable" };
}

type PreflightBinding = {
  id: string;
  dispatchId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  headCycleId: string;
  authorityGeneration: number;
  dispatchIdentitySha256: string;
  capabilityProfileId: string;
  capabilityProfileSnapshotSha256: string;
  permissionContract: string;
  status: string;
  result: unknown;
};

function readyResult(preflight: PreflightBinding): GithubCorrectionCarrierPreflightResult {
  return {
    kind: "ready",
    preflightId: preflight.id,
    dispatchId: preflight.dispatchId,
    repo: preflight.repo,
    prNumber: preflight.prNumber,
    headSha: preflight.headSha,
    baseSha: preflight.baseSha,
    dispatchIdentitySha256: preflight.dispatchIdentitySha256,
    headCycleId: preflight.headCycleId,
    authorityGeneration: preflight.authorityGeneration,
    capabilityProfileId: preflight.capabilityProfileId,
    capabilityProfileSnapshotSha256: preflight.capabilityProfileSnapshotSha256,
    permissionContract: preflight.permissionContract,
    proof,
  };
}

function replayTerminal(preflight: PreflightBinding): GithubCorrectionCarrierPreflightResult {
  const outcome = preflight.result as { kind?: unknown } | null;
  if (preflight.status === "ready" && outcome?.kind === "ready") {
    return readyResult(preflight);
  }
  if (!outcome || typeof outcome.kind !== "string") {
    return { kind: "not_current" };
  }
  if (preflight.status === "indeterminate"
    && (outcome.kind === "github_unavailable"
      || outcome.kind === "invalid_github_response"
      || outcome.kind === "storage_unavailable")) {
    return { kind: "indeterminate", reason: outcome.kind };
  }
  if (preflight.status !== "unavailable") return { kind: "not_current" };
  if (outcome.kind === "installation_or_permission_denied") {
    return { kind: "unavailable", reason: outcome.kind };
  }
  if (
    outcome.kind === "remote_pr_not_active" ||
    outcome.kind === "remote_head_mismatch" ||
    outcome.kind === "remote_base_mismatch"
  ) return { kind: "unavailable", reason: outcome.kind };
  return { kind: "not_current" };
}

/**
 * Reserve and run one carrier preflight. Only the winning reservation reaches
 * token minting or GitHub; duplicate, held, terminal, and stale reservations
 * return without network work.
 */
export async function preflightGithubCorrectionCarrier(
  input: GithubCorrectionCarrierPreflightInput
): Promise<GithubCorrectionCarrierPreflightResult> {
  if (!isInput(input)) return { kind: "unavailable", reason: "invalid_input" };

  let reservation: Awaited<ReturnType<typeof reserveGithubCorrectionCarrierPreflight>>;
  try {
    reservation = await reserveGithubCorrectionCarrierPreflight({
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
    });
  } catch {
    return { kind: "indeterminate", reason: "storage_unavailable" };
  }
  if (reservation.kind === "terminal") return replayTerminal(reservation.preflight as PreflightBinding);
  if (reservation.kind !== "reserved") return { kind: reservation.kind };

  const { preflight } = reservation as { kind: "reserved"; preflight: PreflightBinding };
  let credential: Awaited<ReturnType<typeof getGithubCorrectionCarrierCredential>>;
  try {
    credential = await getGithubCorrectionCarrierCredential({
      workspaceId: input.workspaceId,
      repo: preflight.repo,
    });
  } catch {
    const reported = resultAfterUnreportedReport(
      await report(input.workspaceId, preflight.id, { kind: "storage_unavailable" })
    );
    return reported ?? { kind: "indeterminate", reason: "storage_unavailable" };
  }
  if (!credential.ok) {
    if (credential.kind === "indeterminate" && credential.reason === "storage_unavailable") {
      const reported = resultAfterUnreportedReport(
        await report(input.workspaceId, preflight.id, { kind: "storage_unavailable" })
      );
      return reported ?? { kind: "indeterminate", reason: "storage_unavailable" };
    }
    const outcome =
      credential.kind === "unavailable"
        ? { kind: "installation_or_permission_denied" as const }
        : credential.reason === "github_unavailable"
          ? { kind: "github_unavailable" as const }
          : { kind: "invalid_github_response" as const };
    const reported = resultAfterUnreportedReport(
      await report(input.workspaceId, preflight.id, outcome)
    );
    if (reported) return reported;
    return credential.kind === "unavailable"
      ? { kind: "unavailable", reason: "installation_or_permission_denied" }
      : { kind: "indeterminate", reason: outcome.kind };
  }

  let current: Awaited<ReturnType<typeof readCurrentGithubPullRequest>>;
  try {
    current = await readCurrentGithubPullRequest({
      token: credential.token,
      repo: preflight.repo,
      prNumber: preflight.prNumber,
    });
  } catch {
    const reported = resultAfterUnreportedReport(
      await report(input.workspaceId, preflight.id, { kind: "github_unavailable" })
    );
    return reported ?? { kind: "indeterminate", reason: "github_unavailable" };
  }
  if (!current.ok) {
    const outcome =
      current.reason === "github_unavailable"
        ? { kind: "github_unavailable" as const }
        : { kind: "invalid_github_response" as const };
    const reported = resultAfterUnreportedReport(
      await report(input.workspaceId, preflight.id, outcome)
    );
    if (reported) return reported;
    return { kind: "indeterminate", reason: outcome.kind };
  }

  const remote = current.pullRequest;
  if (remote.state !== "open" || remote.merged || remote.draft) {
    const reported = resultAfterUnreportedReport(await report(input.workspaceId, preflight.id, {
      kind: "remote_pr_not_active",
      headSha: remote.headSha,
      baseSha: remote.baseSha,
    }));
    return reported ?? { kind: "unavailable", reason: "remote_pr_not_active" };
  }
  if (remote.headSha !== preflight.headSha) {
    const reported = resultAfterUnreportedReport(await report(input.workspaceId, preflight.id, {
      kind: "remote_head_mismatch",
      expectedHeadSha: preflight.headSha,
      observedHeadSha: remote.headSha,
    }));
    return reported ?? { kind: "unavailable", reason: "remote_head_mismatch" };
  }
  if (remote.baseSha !== preflight.baseSha) {
    const reported = resultAfterUnreportedReport(await report(input.workspaceId, preflight.id, {
      kind: "remote_base_mismatch",
      expectedBaseSha: preflight.baseSha,
      observedBaseSha: remote.baseSha,
    }));
    return reported ?? { kind: "unavailable", reason: "remote_base_mismatch" };
  }
  const reported = resultAfterUnreportedReport(await report(input.workspaceId, preflight.id, {
    kind: "ready",
    headSha: preflight.headSha,
    baseSha: preflight.baseSha,
  }));
  return reported ?? readyResult(preflight);
}
