import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  advanceConfirmedAcceptanceRecordPullRequestHead,
  CurrentReviewJobNotCurrentError,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  isGithubNativeBuilderRouteAdapter,
  queueSelectedCorrectionDispatch,
  reserveGithubCorrectionCarrierPreflight,
  reportGithubCorrectionCarrierPreflight,
  acceptanceCorrectionDispatchGithubPreflightId,
  recordAcceptanceBuilderRouteCapabilityProfile,
  recordAcceptanceBuilderRouteGithubClaudeAckProfile,
  recordGithubClaudeAgentAcknowledgement,
  githubClaudeAcknowledgementAudience,
  GithubClaudeAgentAcknowledgementConflictError,
  reconcileConfirmedAcceptanceRecordPullRequestHead,
  type AdvanceConfirmedAcceptanceRecordPullRequestHeadInput,
  type InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventInput,
} from "../queries/change_records.js";

const HEAD = "a".repeat(40);
const BEFORE = "b".repeat(40);
const BASE: AdvanceConfirmedAcceptanceRecordPullRequestHeadInput = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  recordId: "00000000-0000-4000-8000-000000000002",
  repo: "acme/widgets",
  prNumber: 42,
  headSha: HEAD,
  event: "opened",
  deliveryId: "delivery-1",
  admitReviewJob: true,
  headTransition: null,
  source: "github_webhook",
  prUrl: "https://github.com/acme/widgets/pull/42",
};
const TERMINAL_BASE: InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventInput = {
  workspaceId: BASE.workspaceId,
  recordId: BASE.recordId,
  repo: BASE.repo,
  prNumber: BASE.prNumber,
  headSha: HEAD,
  event: "merged",
  deliveryId: "delivery-terminal-1",
  source: "github_webhook",
};
const RECONCILE_BASE = {
  workspaceId: BASE.workspaceId,
  recordId: BASE.recordId,
  repo: BASE.repo,
  prNumber: BASE.prNumber,
  expectedBlockedHeadSha: HEAD,
  expectedBlockedCycleId: "00000000-0000-4000-8000-000000000003",
  expectedBlockedAuthorityGeneration: 1,
  observedHeadSha: "c".repeat(40),
  observedBaseSha: "d".repeat(40),
  observedState: "open" as const,
  observedDraft: false,
  observedMerged: false,
  source: "github_app_api" as const,
};

describe("confirmed Acceptance Record PR head advance boundary", () => {
  it("requires capability profiles only for the selected GitHub vendor adapters", () => {
    expect(isGithubNativeBuilderRouteAdapter("github_codex")).toBe(true);
    expect(isGithubNativeBuilderRouteAdapter("github_claude")).toBe(true);
    expect(isGithubNativeBuilderRouteAdapter("durable_github_fallback")).toBe(false);
    expect(isGithubNativeBuilderRouteAdapter("durable_jace_fallback")).toBe(false);
  });

  it("accepts only server-derived builder-route capability profile identity", async () => {
    const identity = {
      workspaceId: BASE.workspaceId,
      routeId: "00000000-0000-4000-8000-000000000010",
      recordedBy: "server:route-capability-profile",
    };
    for (const untrusted of [
      { mention: "@codex" },
      { recipient: "codex" },
      { carrier: "github_issue_comment" },
      { configuration: { arbitrary: "caller-controlled" } },
      { githubToken: "ghs-never-persist-or-accept" },
      { workspaceGithubInstallationId: "caller-controlled" },
    ]) {
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...identity,
        ...untrusted,
      } as never)).rejects.toThrow("requires only workspace, route, and server actor");
    }
    await expect(recordAcceptanceBuilderRouteCapabilityProfile({
      ...identity,
      recordedBy: "user:owner",
    } as never)).rejects.toThrow("requires only workspace, route, and server actor");
  });

  it("uses the exact hashed activation/run audience and exposes a typed receipt conflict", () => {
    const activationCommentId = "91002";
    const runId = "44001";
    const binding = ["github_claude_ack", "1", activationCommentId, runId, "1"].join(":");
    expect(githubClaudeAcknowledgementAudience({
      activationCommentId, runId, runAttempt: 1,
    })).toBe(`agentrail://correction-dispatch/github-claude/ack/v1/${createHash("sha256")
      .update(binding, "utf8").digest("hex")}`);
    expect(githubClaudeAcknowledgementAudience({
      activationCommentId, runId, runAttempt: 2,
    })).toBeNull();
    expect(new GithubClaudeAgentAcknowledgementConflictError()).toMatchObject({
      name: "GithubClaudeAgentAcknowledgementConflictError",
      code: "GITHUB_CLAUDE_ACK_CONFLICT",
    });
  });

  it("closes acknowledgement profile and receipt inputs before database access", async () => {
    const profile = {
      workspaceId: BASE.workspaceId,
      routeId: "00000000-0000-4000-8000-000000000010",
      githubRepositoryId: "1",
      githubRepositoryOwnerId: "2",
      githubAppBotUserId: "3",
      githubAppBotLogin: "jace[bot]",
      callerWorkflowRef: "acme/widgets/.github/workflows/caller.yml@refs/heads/main",
      jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"a".repeat(40)}`,
      jobWorkflowSha: "a".repeat(40),
      claudeActionSha: "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975",
      recordedBy: "server:github-claude-ack-profile",
    };
    await expect(recordAcceptanceBuilderRouteGithubClaudeAckProfile({
      ...profile, githubAppBotLogin: "other[bot]",
    })).rejects.toThrow("profile input is invalid");
    await expect(recordAcceptanceBuilderRouteGithubClaudeAckProfile({
      ...profile, claudeActionSha: "b".repeat(40),
    })).rejects.toThrow("profile input is invalid");

    const now = Math.floor(Date.now() / 1_000);
    const subject = "repo:acme/widgets:ref:refs/heads/main";
    const oidc = {
      issuer: "https://token.actions.githubusercontent.com" as const,
      audience: githubClaudeAcknowledgementAudience({
        activationCommentId: "91002", runId: "44001", runAttempt: 1,
      })!,
      subject,
      subjectSha256: createHash("sha256").update(subject).digest("hex"),
      jtiSha256: "b".repeat(64),
      issuedAt: now - 10,
      notBefore: now - 10,
      expiresAt: now + 100,
      repository: "acme/widgets",
      repositoryId: "1",
      repositoryOwner: "acme",
      repositoryOwnerId: "2",
      actor: "jace[bot]",
      actorId: "3",
      eventName: "issue_comment" as const,
      ref: "refs/heads/main",
      workflowRef: "acme/widgets/.github/workflows/caller.yml@refs/heads/main",
      workflowSha: "c".repeat(40),
      jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"a".repeat(40)}`,
      jobWorkflowSha: "a".repeat(40),
      runId: "44001",
      runAttempt: 1 as const,
      checkRunId: "55001",
    };
    await expect(recordGithubClaudeAgentAcknowledgement({
      activationCommentId: "91002",
      activationBodySha256: "d".repeat(64),
      conclusion: "success",
      providerSessionId: "session-1",
      oidc,
      dispatchId: BASE.recordId,
    } as never)).rejects.toThrow("input is invalid");
    await expect(recordGithubClaudeAgentAcknowledgement({
      activationCommentId: "91002",
      activationBodySha256: "d".repeat(64),
      conclusion: "success",
      providerSessionId: "session-1",
      oidc: { ...oidc, jti: "raw-token-id" },
    } as never)).rejects.toThrow("input is invalid");
  });

  it("accepts only an opaque compiled Pack reference for selected-route dispatch preparation", async () => {
    const opaque = {
      workspaceId: BASE.workspaceId,
      compiledPackId: "00000000-0000-4000-8000-000000000009",
    };
    await expect(queueSelectedCorrectionDispatch({
      ...opaque,
      headSha: HEAD,
      routeId: "00000000-0000-4000-8000-000000000010",
      packet: { arbitrary: "caller-controlled" },
    } as never)).rejects.toThrow("requires a workspace and compiled Pack");
    await expect(queueSelectedCorrectionDispatch({ workspaceId: BASE.workspaceId } as never))
      .rejects.toThrow("requires a workspace and compiled Pack");
  });

  it("admits only opaque server-bound GitHub carrier preflight coordinates and closed outcomes", async () => {
    const dispatchId = "00000000-0000-4000-8000-000000000009";
    const preflightId = acceptanceCorrectionDispatchGithubPreflightId({ dispatchId, attempt: 1 });
    expect(preflightId).toBe(acceptanceCorrectionDispatchGithubPreflightId({ dispatchId, attempt: 1 }));
    expect(preflightId).not.toBe(acceptanceCorrectionDispatchGithubPreflightId({ dispatchId, attempt: 2 }));
    await expect(reserveGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, dispatchId, githubToken: "never-accepted",
    } as never)).rejects.toThrow("requires only workspace and dispatch");
    await expect(reportGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, preflightId,
      outcome: { kind: "ready", headSha: HEAD, baseSha: BEFORE },
      rawError: "never-persisted",
    } as never)).rejects.toThrow("requires only workspace, preflight, and closed outcome");
    await expect(reportGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, preflightId,
      outcome: { kind: "ready", headSha: "short", baseSha: BEFORE },
    } as never)).rejects.toThrow("requires only workspace, preflight, and closed outcome");
    await expect(reportGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, preflightId,
      outcome: { kind: "github_unavailable", detail: "untrusted" },
    } as never)).rejects.toThrow("requires only workspace, preflight, and closed outcome");
    await expect(reportGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, preflightId,
      outcome: { kind: "storage_unavailable", detail: "untrusted" },
    } as never)).rejects.toThrow("requires only workspace, preflight, and closed outcome");
    await expect(reportGithubCorrectionCarrierPreflight({
      workspaceId: BASE.workspaceId, preflightId,
      outcome: { kind: "remote_base_mismatch", expectedBaseSha: "short", observedBaseSha: BEFORE },
    } as never)).rejects.toThrow("requires only workspace, preflight, and closed outcome");
  });

  it.each([
    ["abbreviated head", { headSha: "abc123def4567890" }],
    ["non-GitHub source", { source: "manual" }],
    ["unknown action", { event: "edited" }],
    ["arbitrary PR URL", { prUrl: "https://example.com/pull/42" }],
    ["non-synchronize transition", {
      headTransition: { beforeHeadSha: BEFORE, afterHeadSha: HEAD },
    }],
  ])("rejects %s before opening a transaction", async (_label, override) => {
    await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
      ...BASE,
      ...override,
    } as AdvanceConfirmedAcceptanceRecordPullRequestHeadInput)).rejects.toThrow(
      "bounded exact PR provenance"
    );
  });

  it("requires synchronize before/after and binds after to the exact head", async () => {
    await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
      ...BASE,
      event: "synchronize",
      headTransition: null,
    })).rejects.toThrow("bounded exact PR provenance");
    await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
      ...BASE,
      event: "synchronize",
      headTransition: { beforeHeadSha: BEFORE, afterHeadSha: "c".repeat(40) },
    })).rejects.toThrow("bounded exact PR provenance");
  });

  it("exports a stable typed noncurrent signal distinct from storage errors", () => {
    const error = new CurrentReviewJobNotCurrentError("record_not_current");
    expect(error).toMatchObject({
      name: "CurrentReviewJobNotCurrentError",
      code: "CURRENT_REVIEW_JOB_NOT_CURRENT",
      reason: "record_not_current",
    });
  });

  it.each([
    ["abbreviated observed head", { headSha: "abc123def4567890" }],
    ["unknown terminal action", { event: "synchronize" }],
    ["non-GitHub source", { source: "manual" }],
    ["unbounded delivery id", { deliveryId: ` ${"x".repeat(256)}` }],
  ])("rejects terminal invalidation with %s before opening a transaction", async (_label, override) => {
    await expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
      ...TERMINAL_BASE,
      ...override,
    } as InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventInput)).rejects.toThrow(
      "bounded exact GitHub provenance"
    );
  });

  it.each([
    ["negative authority generation", { expectedBlockedAuthorityGeneration: -1 }],
    ["abbreviated observed base", { observedBaseSha: "abc123" }],
    ["unknown observed state", { observedState: "merged" }],
    ["non-GitHub-App source", { source: "github_webhook" }],
  ])("rejects reconciliation with %s before opening a transaction", async (_label, override) => {
    await expect(reconcileConfirmedAcceptanceRecordPullRequestHead({
      ...RECONCILE_BASE,
      ...override,
    } as typeof RECONCILE_BASE)).rejects.toThrow(
      "bounded exact authenticated provenance"
    );
  });
});
