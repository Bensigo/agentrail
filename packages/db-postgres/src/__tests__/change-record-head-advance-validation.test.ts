import { describe, expect, it } from "vitest";
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
