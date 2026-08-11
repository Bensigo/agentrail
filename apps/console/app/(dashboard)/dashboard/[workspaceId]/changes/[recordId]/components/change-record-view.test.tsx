import { describe, expect, it } from "vitest";
import {
  ChangeRecordAnchors,
  CorrectionsSection,
  DependencyObservationsPanel,
  FinalDecisionPanel,
  LifecycleTimeline,
  ReviewMetricsPanel,
  changeRecordApiPath,
  dependencyObservationApprovalPatchBody,
  finalDecisionPatchBody,
  formatChangeRecordDate,
  isCorrectionPacketsEnvelope,
  isChangeRecordResponse,
  isDependencyObservationsEnvelope,
  isFinalDecisionEnvelope,
  isReviewMetricsEnvelope,
  reviewEffortPatchBody,
  type AcceptanceCorrectionPacketsEnvelope,
  type AcceptanceDependencyObservationsEnvelope,
  type AcceptanceFinalDecisionEnvelope,
  type AcceptancePrReviewMetricsEnvelope,
  type ChangeRecord,
  type ChangeRecordEvent,
} from "./change-record-view";

type ElementLike = {
  type?: unknown;
  props?: Record<string, unknown>;
};

function textContent(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  const element = node as ElementLike;
  if (typeof element.type === "function") {
    return textContent((element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {}));
  }
  return textContent(element.props?.children)
    .replace(/\s+/g, " ")
    .replace(/\s*([#()])\s*/g, "$1")
    .trim();
}

function links(node: unknown): string[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(links);
  const element = node as ElementLike;
  const href = typeof element.props?.href === "string" ? [element.props.href] : [];
  return [...href, ...links(element.props?.children)];
}

function elementTypes(node: unknown): string[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elementTypes);
  const element = node as ElementLike;
  if (typeof element.type === "function") {
    return elementTypes((element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {}));
  }
  const own = typeof element.type === "string" ? [element.type] : [];
  return [...own, ...elementTypes(element.props?.children)];
}

function elementsOfType(node: unknown, type: string): ElementLike[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => elementsOfType(child, type));
  const element = node as ElementLike;
  if (typeof element.type === "function") {
    return elementsOfType(
      (element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {}),
      type,
    );
  }
  const own = element.type === type ? [element] : [];
  return [...own, ...elementsOfType(element.props?.children, type)];
}

function buttonLabels(node: unknown): string[] {
  return elementsOfType(node, "button").map((button) => textContent(button.props?.children));
}

const record: ChangeRecord = {
  id: "00000000-0000-4000-8000-000000000010",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  repo: "ada/widgets",
  issueNumber: 41,
  prNumber: 98,
  headShas: ["abcdef1234567890"],
  mergedSha: null,
  state: "open",
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:05:00.000Z",
};

const PACKET_ID = `correction-${"d".repeat(48)}`;
const CONTRACT_SHA256 = "a".repeat(64);
const PACKET_SET_SHA256 = "b".repeat(64);
const PACKET_PAYLOAD_SET_SHA256 = "c".repeat(64);

const events: ChangeRecordEvent[] = [
  {
    id: "event-1",
    recordId: record.id,
    eventKey: "run-1",
    stage: "implementation",
    actor: "factory",
    payloadRef: { runId: "run-1" },
    at: "2026-08-03T10:01:00.000Z",
    createdAt: "2026-08-03T10:01:00.000Z",
  },
  {
    id: "event-2",
    recordId: record.id,
    eventKey: "review-1",
    stage: "review",
    actor: "jace",
    payloadRef: { postedReviewUrl: "https://github.com/ada/widgets/pull/98" },
    at: "2026-08-03T10:02:00.000Z",
    createdAt: "2026-08-03T10:02:00.000Z",
  },
];

const currentCorrections: AcceptanceCorrectionPacketsEnvelope = {
  kind: "current",
  binding: {
    workspaceId: record.workspaceId,
    recordId: record.id,
    reviewJobId: "00000000-0000-4000-8000-000000000099",
    repo: record.repo,
    prNumber: 98,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    headCycleId: "00000000-0000-4000-8000-000000000099",
    authorityGeneration: 7,
    acceptanceContract: {
      id: "00000000-0000-4000-8000-000000000088",
      version: 3,
      sha256: CONTRACT_SHA256,
    },
  },
  packetIds: [PACKET_ID],
  packetSetSha256: PACKET_SET_SHA256,
  correctionPacketPayloadSetSha256: PACKET_PAYLOAD_SET_SHA256,
  packets: [
    {
      kind: "review_job_correction_packet",
      version: 1,
      packetId: PACKET_ID,
      workspaceId: record.workspaceId,
      repo: record.repo,
      prNumber: 98,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      recordId: record.id,
      jobId: "00000000-0000-4000-8000-000000000099",
      acceptanceContract: {
        id: "00000000-0000-4000-8000-000000000088",
        version: 3,
      },
      criterion: {
        id: "criterion-login",
        snapshot: "A signed-in member can open the protected page.",
      },
      basis: "acceptance_contract",
      state: "failed",
      expected: "A signed-in member can open the protected page.",
      observed: "The protected page returned HTTP 500.",
      affectedContext: {
        modality: "ui",
        environmentKind: "isolated_preview",
        flow: "member-opens-protected-page",
        reproduction: {
          modality: "ui",
          steps: [
            { action: "open", path: "/protected" },
            { action: "expect_text", text: "Account" },
          ],
        },
      },
      evidence: {
        evidenceRef: "criterion:criterion-login:ui-result",
        artifactKey: "artifacts/ui/protected.png",
        executionId: "execution-17",
        previewBootId: "preview-boot-9",
      },
      scopeBoundary: "Only criterion-login at the exact PR head.",
      impact: "The confirmed member journey is blocked.",
      requiredCorrection: "Make the protected page return the saved account view.",
      reverification: "Rerun the persisted UI plan against the next exact head.",
    },
  ],
};

const currentFinalDecision: AcceptanceFinalDecisionEnvelope = {
  kind: "current",
  binding: {
    bindingId: "00000000-0000-4000-8000-000000000055",
    workspaceId: record.workspaceId,
    recordId: record.id,
    repo: record.repo,
    prNumber: 98,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    headCycleId: "00000000-0000-4000-8000-000000000099",
    authorityGeneration: 7,
    reviewJobId: "00000000-0000-4000-8000-000000000099",
    reviewVerdict: "failed",
    postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-5",
    postedAttestationEventId: "00000000-0000-4000-8000-000000000077",
    acceptanceContract: {
      id: "00000000-0000-4000-8000-000000000088",
      version: 3,
      sha256: CONTRACT_SHA256,
    },
  },
  decision: null,
};

const HISTORICAL_CYCLE = "00000000-0000-4000-8000-000000000098";
const HISTORICAL_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

const currentReviewMetrics: AcceptancePrReviewMetricsEnvelope = {
  kind: "record",
  workspaceId: record.workspaceId,
  recordId: record.id,
  repo: record.repo,
  prNumber: 98,
  currentCycle: {
    headSha: currentFinalDecision.binding.headSha,
    headCycleId: currentFinalDecision.binding.headCycleId,
    authorityGeneration: 7,
  },
  cycles: [
    {
      binding: {
        workspaceId: record.workspaceId,
        recordId: record.id,
        repo: record.repo,
        prNumber: 98,
        headSha: HISTORICAL_HEAD,
        headCycleId: HISTORICAL_CYCLE,
        reviewJobId: HISTORICAL_CYCLE,
        reviewVerdict: "proven",
        postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-4",
        postedAttestationEventId: "00000000-0000-4000-8000-000000000076",
        acceptanceContract: {
          id: "00000000-0000-4000-8000-000000000088",
          version: 3,
          sha256: CONTRACT_SHA256,
        },
      },
      current: false,
      reviewedAt: "2026-08-10T08:00:00.000Z",
      effort: {
        kind: "known",
        value: {
          eventId: "00000000-0000-4000-8000-000000000075",
          eventKey: `acceptance-pr-review-effort:${HISTORICAL_CYCLE}`,
          minutes: 42,
          source: "human_input",
          recordedBy: "user:00000000-0000-4000-8000-000000000002",
          recordedRole: "owner",
          recordedAt: "2026-08-10T08:05:00.000Z",
        },
      },
      decision: {
        kind: "known",
        value: {
          eventId: "00000000-0000-4000-8000-000000000074",
          eventKey: `acceptance-pr-decision:${HISTORICAL_CYCLE}`,
          decision: "approved",
          rationale: null,
          decidedBy: "user:00000000-0000-4000-8000-000000000002",
          decidedRole: "owner",
          decidedAt: "2026-08-10T08:06:00.000Z",
        },
      },
      signedMerge: {
        kind: "known",
        value: {
          mergeEventId: "00000000-0000-4000-8000-000000000073",
          deliveryEventId: "00000000-0000-4000-8000-000000000072",
          mergeSha: "fedcba9876543210fedcba9876543210fedcba98",
          mergedAt: "2026-08-10T08:07:00.000Z",
          decisionAlignment: "aligned",
        },
      },
      postMergeOutcomes: {
        kind: "known",
        values: [{
          eventId: "00000000-0000-4000-8000-000000000071",
          eventKey: "acceptance-post-merge:deployed:deploy-17",
          outcome: {
            kind: "deployed",
            revisionSha: "fedcba9876543210fedcba9876543210fedcba98",
            environment: "production",
            deploymentReference: "deploy-17",
          },
          recordedBy: "user:00000000-0000-4000-8000-000000000002",
          recordedAt: "2026-08-10T08:08:00.000Z",
        }],
      },
    },
    {
      binding: {
        workspaceId: currentFinalDecision.binding.workspaceId,
        recordId: currentFinalDecision.binding.recordId,
        repo: currentFinalDecision.binding.repo,
        prNumber: currentFinalDecision.binding.prNumber,
        headSha: currentFinalDecision.binding.headSha,
        headCycleId: currentFinalDecision.binding.headCycleId,
        reviewJobId: currentFinalDecision.binding.reviewJobId,
        reviewVerdict: currentFinalDecision.binding.reviewVerdict,
        postedReviewUrl: currentFinalDecision.binding.postedReviewUrl,
        postedAttestationEventId: currentFinalDecision.binding.postedAttestationEventId,
        acceptanceContract: currentFinalDecision.binding.acceptanceContract,
      },
      current: true,
      reviewedAt: "2026-08-11T09:00:00.000Z",
      effort: { kind: "unknown" },
      decision: { kind: "unknown" },
      signedMerge: { kind: "unknown" },
      postMergeOutcomes: { kind: "unknown" },
    },
  ],
  summary: {
    reviewEffort: {
      eligible: 2,
      known: 1,
      unknown: 1,
      totalMinutes: 42,
      averageMinutes: 42,
    },
    decisions: { eligible: 2, known: 1, unknown: 1 },
    signedMerges: { eligible: 2, known: 1, unknown: 1 },
    postMergeOutcomes: { eligible: 1, known: 1, unknown: 0 },
  },
};

const DEPENDENCY_OBSERVATION_EVENT = "00000000-0000-4000-8000-000000000067";
const DEPENDENCY_APPROVAL_EVENT = "00000000-0000-4000-8000-000000000066";
const DEPENDENCY_PACK_EVENT = "00000000-0000-4000-8000-000000000065";
const DEPENDENCY_PACK_ID = "00000000-0000-4000-8000-000000000064";
const DEPENDENCY_FINGERPRINT_VALUE = `sha256:${"9".repeat(64)}`;
const dependencyBinding = {
  workspaceId: record.workspaceId,
  recordId: record.id,
  repo: record.repo,
  prNumber: 98,
  headSha: currentFinalDecision.binding.headSha,
  headCycleId: currentFinalDecision.binding.headCycleId,
  authorityGeneration: 7,
  reviewJobId: currentFinalDecision.binding.reviewJobId,
  acceptanceContract: currentFinalDecision.binding.acceptanceContract,
  compiledPack: {
    id: "00000000-0000-4000-8000-000000000063",
    sha256: "d".repeat(64),
    sourceSnapshotId: "00000000-0000-4000-8000-000000000062",
    sourceCustodyIdentitySha256: "e".repeat(64),
    compilerVersion: "acceptance-context-pack-compiler-v2",
    policyVersion: "acceptance-context-pack-policy-v2",
    exactHeadDependencyTreeProofsSha256: "f".repeat(64),
  },
};
const dependencyCandidate = {
  package: "@acme/widget",
  dependencyKind: "dependencies" as const,
  specifier: "^1.2.0",
  currentVersion: "1.2.3",
  targetVersion: "1.3.0",
};
const dependencyEvidence = {
  runtime: { disposition: "safe" as const, nodeVersion: "22.14.0", evidenceSha256: "1".repeat(64) },
  packageManager: {
    disposition: "safe" as const,
    name: "pnpm",
    version: "10.14.0",
    profile: "pnpm_lockfile_only_v1",
    updateArgv: ["pnpm", "update", "@acme/widget@1.3.0", "--lockfile-only", "--ignore-scripts"],
    evidenceSha256: "2".repeat(64),
  },
  manifest: { path: "packages/widget/package.json", blobSha: "3".repeat(40) },
  lockfile: {
    disposition: "present" as const,
    path: "pnpm-lock.yaml",
    blobSha: "4".repeat(40),
    evidenceSha256: "5".repeat(64),
  },
  baseline: { headSha: currentFinalDecision.binding.headSha },
  security: {
    disposition: "clear" as const,
    provider: "osv" as const,
    reference: "osv:npm:@acme/widget@1.3.0",
    reportSha256: "6".repeat(64),
  },
};
const dependencyObservation = {
  eventId: DEPENDENCY_OBSERVATION_EVENT,
  eventKey: `acceptance-dependency-observation:${currentFinalDecision.binding.headCycleId}:${DEPENDENCY_FINGERPRINT_VALUE.slice("sha256:".length)}`,
  status: "observed" as const,
  reasons: [],
  candidateFingerprint: DEPENDENCY_FINGERPRINT_VALUE,
  candidate: dependencyCandidate,
  ...dependencyEvidence,
  observedAt: "2026-08-11T09:10:00.000Z",
};
const currentDependencyObservations: AcceptanceDependencyObservationsEnvelope = {
  kind: "current",
  binding: {
    workspaceId: record.workspaceId,
    recordId: record.id,
    repo: record.repo,
    prNumber: 98,
    headSha: currentFinalDecision.binding.headSha,
    headCycleId: currentFinalDecision.binding.headCycleId,
    authorityGeneration: 7,
    acceptanceContract: currentFinalDecision.binding.acceptanceContract,
  },
  observations: [{
    binding: dependencyBinding,
    observation: dependencyObservation,
    approval: null,
    externalBuilderPack: null,
  }],
};
const dependencyApproval = {
  eventId: DEPENDENCY_APPROVAL_EVENT,
  eventKey: `acceptance-dependency-approval:${currentFinalDecision.binding.headCycleId}:${DEPENDENCY_FINGERPRINT_VALUE.slice("sha256:".length)}`,
  observationEventId: DEPENDENCY_OBSERVATION_EVENT,
  candidateFingerprint: DEPENDENCY_FINGERPRINT_VALUE,
  approvedBy: "user:00000000-0000-4000-8000-000000000002",
  approvedRole: "owner" as const,
  approvedAt: "2026-08-11T09:15:00.000Z",
};
const dependencyExternalBuilderPack = {
  packId: DEPENDENCY_PACK_ID,
  eventId: DEPENDENCY_PACK_EVENT,
  eventKey: `acceptance-dependency-external-builder-pack:${currentFinalDecision.binding.headCycleId}:${DEPENDENCY_FINGERPRINT_VALUE.slice("sha256:".length)}`,
  observationEventId: DEPENDENCY_OBSERVATION_EVENT,
  approvalEventId: DEPENDENCY_APPROVAL_EVENT,
  candidateFingerprint: DEPENDENCY_FINGERPRINT_VALUE,
  binding: dependencyBinding,
  candidate: dependencyCandidate,
  ...dependencyEvidence,
  route: {
    selectionEventId: "00000000-0000-4000-8000-000000000061",
    id: "00000000-0000-4000-8000-000000000060",
    adapter: "github_codex" as const,
    configurationVersion: 2,
    snapshot: {
      builder: {
        adapter: "github_codex" as const,
        routeId: "00000000-0000-4000-8000-000000000060",
      },
      protocol: "github_comment" as const,
      capability: {
        availability: "unverified" as const,
        activation: "github_mention" as const,
        acknowledgement: "vendor_activity" as const,
        repairHead: "github_synchronize" as const,
      },
      scopeBoundary: "correction_delivery_only" as const,
    },
    snapshotSha256: "7".repeat(64),
  },
  deliveryAuthority: "not_granted" as const,
  scopeBoundary: "dependency_external_builder_pack_only" as const,
  reviewRequirement: "exact_head_r7_reentry" as const,
  mintedAt: "2026-08-11T09:15:00.000Z",
};

describe("Change Record detail view", () => {
  it("uses the authenticated workspace API path with encoded anchors", () => {
    expect(changeRecordApiPath("workspace/1", "record/2")).toBe(
      "/api/v1/workspaces/workspace%2F1/change-records/record%2F2"
    );
  });

  it("renders issue and PR anchors from the record, not event text", () => {
    const rendered = ChangeRecordAnchors({ record });
    const content = textContent(rendered);

    expect(content).toContain("ada/widgets");
    expect(content).toContain("#41");
    expect(content).toContain("#98");
    expect(links(rendered)).toEqual([
      "https://github.com/ada/widgets/issues/41",
      "https://github.com/ada/widgets/pull/98",
    ]);
  });

  it("renders lifecycle events in the API-provided order with payload references", () => {
    const rendered = LifecycleTimeline({ events });
    const content = textContent(rendered);

    expect(content.indexOf("run-1")).toBeLessThan(content.indexOf("review-1"));
    expect(content).toContain('"postedReviewUrl"');
    expect(content).toContain("Lifecycle events(2)");
  });

  it("labels historical human decisions as audit-only timeline evidence", () => {
    const historicalDecision: ChangeRecordEvent = {
      ...events[0]!,
      id: "event-decision",
      eventKey: "acceptance-pr-decision:old-cycle",
      stage: "human_pr_decision",
      actor: "user:00000000-0000-4000-8000-000000000002",
    };

    expect(textContent(LifecycleTimeline({ events: [historicalDecision] }))).toContain(
      "Audit history only",
    );
  });

  it("renders bounded non-proven decision controls without a merge control or claim", () => {
    const rendered = FinalDecisionPanel({
      finalDecision: currentFinalDecision,
      canRecordFinalDecision: true,
      onDecide: () => undefined,
      deciding: false,
      decisionError: null,
      exceptionRationale: "",
      onExceptionRationaleChange: () => undefined,
    });
    const content = textContent(rendered);
    const labels = buttonLabels(rendered);

    expect(content).toContain("This records the human decision. Jace does not merge.");
    expect(content).toContain("Review verdict failed");
    expect(content).toContain("Explicit exception rationale");
    expect(links(rendered)).toContain(currentFinalDecision.binding.postedReviewUrl);
    expect(labels).toEqual([
      "Request changes",
      "Reject PR",
      "Record approval with exception",
    ]);
    expect(labels).not.toContain("Approve PR");
    expect(labels.some((label) => /merge/iu.test(label))).toBe(false);
  });

  it("offers ordinary approval only for a proven review and hides exception approval", () => {
    const proven: AcceptanceFinalDecisionEnvelope = {
      ...currentFinalDecision,
      binding: { ...currentFinalDecision.binding, reviewVerdict: "proven" },
    };
    const rendered = FinalDecisionPanel({
      finalDecision: proven,
      canRecordFinalDecision: true,
      onDecide: () => undefined,
      deciding: false,
      decisionError: null,
      exceptionRationale: "",
      onExceptionRationaleChange: () => undefined,
    });

    expect(buttonLabels(rendered)).toEqual(["Approve PR", "Request changes", "Reject PR"]);
    expect(textContent(rendered)).not.toContain("Explicit exception rationale");
  });

  it("keeps controls owner/admin-only and renders a recorded current decision as immutable", () => {
    const memberView = FinalDecisionPanel({
      finalDecision: currentFinalDecision,
      canRecordFinalDecision: false,
      onDecide: () => undefined,
      deciding: false,
      decisionError: null,
      exceptionRationale: "",
      onExceptionRationaleChange: () => undefined,
    });
    expect(buttonLabels(memberView)).toEqual([]);
    expect(textContent(memberView)).toContain("workspace owner or admin");

    const recorded: AcceptanceFinalDecisionEnvelope = {
      ...currentFinalDecision,
      decision: {
        eventId: "00000000-0000-4000-8000-000000000066",
        eventKey: "acceptance-pr-decision:00000000-0000-4000-8000-000000000099",
        decision: "changes_requested",
        rationale: "The current evidence still fails the required flow.",
        decidedBy: "user:00000000-0000-4000-8000-000000000002",
        decidedRole: "admin",
        decidedAt: "2026-08-11T09:30:00.000Z",
      },
    };
    const recordedView = FinalDecisionPanel({
      finalDecision: recorded,
      canRecordFinalDecision: true,
      onDecide: () => undefined,
      deciding: false,
      decisionError: null,
      exceptionRationale: "",
      onExceptionRationaleChange: () => undefined,
    });
    const recordedContent = textContent(recordedView);

    expect(recordedContent).toContain("Recorded current decision: Changes requested");
    expect(recordedContent).toContain("admin");
    expect(recordedContent).toContain("The current evidence still fails the required flow.");
    expect(buttonLabels(recordedView)).toEqual([]);
  });

  it("keeps non-current decisions unavailable and historical decisions audit-only", () => {
    const rendered = FinalDecisionPanel({
      finalDecision: { kind: "not_current" },
      canRecordFinalDecision: true,
      onDecide: () => undefined,
      deciding: false,
      decisionError: null,
      exceptionRationale: "",
      onExceptionRationaleChange: () => undefined,
    });

    expect(textContent(rendered)).toContain("Historical decision events remain audit-only");
    expect(buttonLabels(rendered)).toEqual([]);
  });

  it("builds an exact server-authority-free decision body", () => {
    expect(finalDecisionPatchBody(
      currentFinalDecision.binding.bindingId,
      "approved",
    )).toEqual({
      action: "record_pr_decision",
      bindingId: currentFinalDecision.binding.bindingId,
      decision: "approved",
    });
    expect(finalDecisionPatchBody(
      currentFinalDecision.binding.bindingId,
      "approved_with_exception",
      "  Explicit risk acceptance.  ",
    )).toEqual({
      action: "record_pr_decision",
      bindingId: currentFinalDecision.binding.bindingId,
      decision: "approved_with_exception",
      rationale: "Explicit risk acceptance.",
    });
  });

  it("strictly validates current decision custody and closed failure reasons", () => {
    expect(isFinalDecisionEnvelope(currentFinalDecision)).toBe(true);
    expect(isFinalDecisionEnvelope({ kind: "not_ready", reason: "invalid_decision_custody" })).toBe(true);
    expect(isFinalDecisionEnvelope({ kind: "not_ready", reason: "anything" })).toBe(false);

    const missingBindingId = structuredClone(currentFinalDecision) as Record<string, unknown>;
    delete (missingBindingId.binding as Record<string, unknown>).bindingId;
    expect(isFinalDecisionEnvelope(missingBindingId)).toBe(false);

    const unsafeUrl = structuredClone(currentFinalDecision) as Record<string, unknown>;
    const unsafeBinding = unsafeUrl.binding as Record<string, unknown>;
    unsafeBinding.postedReviewUrl = "https://github.com.evil.test/ada/widgets/pull/98#pullrequestreview-5";
    expect(isFinalDecisionEnvelope(unsafeUrl)).toBe(false);

    const queryUrl = structuredClone(currentFinalDecision) as Record<string, unknown>;
    (queryUrl.binding as Record<string, unknown>).postedReviewUrl =
      "https://github.com/ada/widgets/pull/98?token=x#pullrequestreview-5";
    expect(isFinalDecisionEnvelope(queryUrl)).toBe(false);

    const wrongReviewId = structuredClone(currentFinalDecision) as Record<string, unknown>;
    (wrongReviewId.binding as Record<string, unknown>).postedReviewUrl =
      "https://github.com/ada/widgets/pull/98#pullrequestreview-0";
    expect(isFinalDecisionEnvelope(wrongReviewId)).toBe(false);

    const unprovenApproval = structuredClone(currentFinalDecision) as Record<string, unknown>;
    unprovenApproval.decision = {
      eventId: "00000000-0000-4000-8000-000000000066",
      eventKey: "acceptance-pr-decision:00000000-0000-4000-8000-000000000099",
      decision: "approved",
      rationale: null,
      decidedBy: "user:00000000-0000-4000-8000-000000000002",
      decidedRole: "owner",
      decidedAt: "2026-08-11T09:30:00.000Z",
    };
    expect(isFinalDecisionEnvelope(unprovenApproval)).toBe(false);

    const missingExceptionRationale = structuredClone(unprovenApproval) as Record<string, unknown>;
    const exceptionDecision = missingExceptionRationale.decision as Record<string, unknown>;
    exceptionDecision.decision = "approved_with_exception";
    expect(isFinalDecisionEnvelope(missingExceptionRationale)).toBe(false);

    const unsafeRationale = structuredClone(missingExceptionRationale) as Record<string, unknown>;
    (unsafeRationale.decision as Record<string, unknown>).rationale = "bearer secret-value";
    expect(isFinalDecisionEnvelope(unsafeRationale)).toBe(false);

    const extraClaim = structuredClone(currentFinalDecision) as Record<string, unknown>;
    (extraClaim.binding as Record<string, unknown>).merged = true;
    expect(isFinalDecisionEnvelope(extraClaim)).toBe(false);
  });

  it("renders every validated packet field under an explicit current exact-head cycle", () => {
    const rendered = CorrectionsSection({ correctionPackets: currentCorrections });
    const content = textContent(rendered);

    expect(content).toContain("Corrections(1)");
    expect(content).toContain("Current exact head and cycle");
    expect(content).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(content).toContain("00000000-0000-4000-8000-000000000099");
    expect(content).toContain("Authority generation 7");
    expect(content).toContain(CONTRACT_SHA256);
    expect(content).toContain(PACKET_SET_SHA256);
    expect(content).toContain(PACKET_PAYLOAD_SET_SHA256);
    expect(content).toContain("criterion-login");
    expect(content).toContain("A signed-in member can open the protected page.");
    expect(content).toContain("The protected page returned HTTP 500.");
    expect(content).toContain("member-opens-protected-page");
    expect(content).toContain('"expect_text"');
    expect(content).toContain("criterion:criterion-login:ui-result");
    expect(content).toContain("artifacts/ui/protected.png");
    expect(content).toContain("execution-17");
    expect(content).toContain("preview-boot-9");
    expect(content).toContain("Only criterion-login at the exact PR head.");
    expect(content).toContain("The confirmed member journey is blocked.");
    expect(content).toContain("Make the protected page return the saved account view.");
    expect(content).toContain("Rerun the persisted UI plan against the next exact head.");
    expect(content).toContain("review_job_correction_packet v 1");
    expect(content).toContain("acceptance_contract");
  });

  it("shows honest empty, not-ready, and non-current states without packet claims", () => {
    const empty = textContent(CorrectionsSection({
      correctionPackets: { kind: "not_ready", reason: "no_correction_packets" },
    }));
    const invalid = textContent(CorrectionsSection({
      correctionPackets: { kind: "not_ready", reason: "invalid_packet_custody" },
    }));
    const notReady = textContent(CorrectionsSection({
      correctionPackets: { kind: "not_ready", reason: "review_job_unavailable" },
    }));
    const nonCurrent = textContent(CorrectionsSection({
      correctionPackets: { kind: "not_current" },
    }));

    expect(empty).toContain("No current corrections");
    expect(empty).toContain("current exact head and head cycle");
    expect(invalid).toContain("could not be validated, so no current packet set is presented");
    expect(notReady).toContain("Not ready");
    expect(notReady).toContain("does not have a matching review job yet");
    expect(nonCurrent).toContain("Unavailable for the current head");
  });

  it("does not expose a correction workflow control or claim an external outcome", () => {
    const rendered = CorrectionsSection({ correctionPackets: currentCorrections });
    const content = textContent(rendered);

    expect(elementTypes(rendered)).not.toContain("button");
    expect(elementTypes(rendered)).not.toContain("a");
    expect(elementTypes(rendered)).not.toContain("form");
    expect(content).not.toContain("Delivered");
    expect(content).not.toContain("Acknowledged");
    expect(content).not.toContain("Repaired");
    expect(content).not.toContain("Create issue");
  });

  it("rejects an incomplete or cross-bound packet envelope before rendering", () => {
    const missingEvidence = structuredClone(currentCorrections) as Record<string, unknown>;
    const missingPackets = missingEvidence.packets as Array<Record<string, unknown>>;
    delete (missingPackets[0]!.evidence as Record<string, unknown>).previewBootId;

    const mismatchedId = structuredClone(currentCorrections) as Record<string, unknown>;
    (mismatchedId.packetIds as string[])[0] = `correction-${"e".repeat(48)}`;

    const extraNestedField = structuredClone(currentCorrections) as Record<string, unknown>;
    const nestedPacket = (extraNestedField.packets as Array<Record<string, unknown>>)[0]!;
    const affectedContext = nestedPacket.affectedContext as Record<string, unknown>;
    const reproduction = affectedContext.reproduction as Record<string, unknown>;
    (reproduction.steps as Array<Record<string, unknown>>)[0]!.untrusted = true;

    const cycleMismatch = structuredClone(currentCorrections) as Record<string, unknown>;
    (cycleMismatch.binding as Record<string, unknown>).headCycleId =
      "00000000-0000-4000-8000-000000000100";

    const invalidHead = structuredClone(currentCorrections) as Record<string, unknown>;
    (invalidHead.binding as Record<string, unknown>).headSha = "not-an-exact-head";

    const invalidPr = structuredClone(currentCorrections) as Record<string, unknown>;
    (invalidPr.binding as Record<string, unknown>).prNumber = 0;

    expect(isCorrectionPacketsEnvelope(missingEvidence)).toBe(false);
    expect(isCorrectionPacketsEnvelope(mismatchedId)).toBe(false);
    expect(isCorrectionPacketsEnvelope(extraNestedField)).toBe(false);
    expect(isCorrectionPacketsEnvelope(cycleMismatch)).toBe(false);
    expect(isCorrectionPacketsEnvelope(invalidHead)).toBe(false);
    expect(isCorrectionPacketsEnvelope(invalidPr)).toBe(false);
  });

  it("strictly validates review-metrics custody, exact variants, and honest denominators", () => {
    expect(isReviewMetricsEnvelope(currentReviewMetrics)).toBe(true);
    expect(isReviewMetricsEnvelope({ kind: "not_found" })).toBe(true);
    expect(isReviewMetricsEnvelope({
      kind: "unavailable",
      reason: "invalid_effort_custody",
    })).toBe(true);
    expect(isReviewMetricsEnvelope({ kind: "unavailable", reason: "anything" })).toBe(false);

    const forgedSource = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    if (forgedSource.cycles[0]!.effort.kind === "known") {
      (forgedSource.cycles[0]!.effort.value as Record<string, unknown>).source = "timer";
    }
    expect(isReviewMetricsEnvelope(forgedSource)).toBe(false);

    const emptyKnownOutcomes = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    emptyKnownOutcomes.cycles[0]!.postMergeOutcomes = { kind: "known", values: [] };
    expect(isReviewMetricsEnvelope(emptyKnownOutcomes)).toBe(false);

    const stringOutcome = structuredClone(currentReviewMetrics) as unknown as Record<string, unknown>;
    const stringCycles = stringOutcome.cycles as Array<Record<string, unknown>>;
    const postMerge = stringCycles[0]!.postMergeOutcomes as Record<string, unknown>;
    (postMerge.values as Array<Record<string, unknown>>)[0]!.outcome = "deployed";
    expect(isReviewMetricsEnvelope(stringOutcome)).toBe(false);

    const allPostMergeVariants = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    if (allPostMergeVariants.cycles[0]!.postMergeOutcomes.kind === "known") {
      allPostMergeVariants.cycles[0]!.postMergeOutcomes.values.push(
        {
          eventId: "00000000-0000-4000-8000-000000000070",
          eventKey: "acceptance-post-merge:incident:incident-9",
          outcome: {
            kind: "incident",
            revisionSha: "fedcba9876543210fedcba9876543210fedcba98",
            incidentReference: "incident-9",
          },
          recordedBy: "incident-observer",
          recordedAt: "2026-08-10T08:09:00.000Z",
        },
        {
          eventId: "00000000-0000-4000-8000-000000000069",
          eventKey: "acceptance-post-merge:reverted:7654321",
          outcome: {
            kind: "reverted",
            revertedSha: "fedcba9876543210fedcba9876543210fedcba98",
            revertSha: "7654321",
            revertReference: "revert-3",
          },
          recordedBy: "release-controller",
          recordedAt: "2026-08-10T08:10:00.000Z",
        },
      );
    }
    expect(isReviewMetricsEnvelope(allPostMergeVariants)).toBe(true);

    const mismatchedSummary = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    mismatchedSummary.summary.reviewEffort.totalMinutes = 0;
    expect(isReviewMetricsEnvelope(mismatchedSummary)).toBe(false);

    const falseCurrentMarker = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    falseCurrentMarker.cycles[1]!.current = false;
    expect(isReviewMetricsEnvelope(falseCurrentMarker)).toBe(false);

    const currentHeadNotYetReviewed = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    currentHeadNotYetReviewed.cycles = [currentHeadNotYetReviewed.cycles[0]!];
    currentHeadNotYetReviewed.summary = {
      reviewEffort: { eligible: 1, known: 1, unknown: 0, totalMinutes: 42, averageMinutes: 42 },
      decisions: { eligible: 1, known: 1, unknown: 0 },
      signedMerges: { eligible: 1, known: 1, unknown: 0 },
      postMergeOutcomes: { eligible: 1, known: 1, unknown: 0 },
    };
    expect(isReviewMetricsEnvelope(currentHeadNotYetReviewed)).toBe(true);
  });

  it("renders exact historical cycles and keeps known and unknown sample denominators separate", () => {
    const rendered = ReviewMetricsPanel({
      reviewMetrics: currentReviewMetrics,
      finalDecision: currentFinalDecision,
      canRecordReviewEffort: false,
      onRecordEffort: () => undefined,
      recordingEffort: false,
      effortError: null,
      effortMinutes: "",
      onEffortMinutesChange: () => undefined,
    });
    const content = textContent(rendered);

    expect(content).toContain("Review effort 1/2 recorded · 1/2 unknown");
    expect(content).toContain("42 total minutes");
    expect(content).toContain("Human decisions 1/2 recorded · 1/2 unknown");
    expect(content).toContain("Post-merge outcomes 1/1 recorded · 0/1 unknown");
    expect(content).toContain(HISTORICAL_HEAD);
    expect(content).toContain(HISTORICAL_CYCLE);
    expect(content).toContain(currentFinalDecision.binding.headSha);
    expect(content).toContain(currentFinalDecision.binding.headCycleId);
    expect(content).toContain("Recorded: 42 whole minutes");
    expect(content).toContain("Unknown — not recorded; not zero");
    expect(content).toContain("Recorded: deployed");
  });

  it("offers one whole-minute input only for an owner/admin current unknown cycle", () => {
    let submitted: number | null = null;
    const rendered = ReviewMetricsPanel({
      reviewMetrics: currentReviewMetrics,
      finalDecision: currentFinalDecision,
      canRecordReviewEffort: true,
      onRecordEffort: (minutes) => { submitted = minutes; },
      recordingEffort: false,
      effortError: null,
      effortMinutes: "37",
      onEffortMinutesChange: () => undefined,
    });
    const inputs = elementsOfType(rendered, "input");
    const buttons = elementsOfType(rendered, "button");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.props).toMatchObject({ type: "number", min: 1, max: 1_440, step: 1 });
    expect(buttonLabels(rendered)).toEqual(["Record review effort"]);
    (buttons[0]!.props?.onClick as (() => void))();
    expect(submitted).toBe(37);

    const member = ReviewMetricsPanel({
      reviewMetrics: currentReviewMetrics,
      finalDecision: currentFinalDecision,
      canRecordReviewEffort: false,
      onRecordEffort: () => undefined,
      recordingEffort: false,
      effortError: null,
      effortMinutes: "37",
      onEffortMinutesChange: () => undefined,
    });
    expect(buttonLabels(member)).toEqual([]);

    const staleDecision: AcceptanceFinalDecisionEnvelope = {
      ...currentFinalDecision,
      binding: {
        ...currentFinalDecision.binding,
        headSha: "f".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000097",
        reviewJobId: "00000000-0000-4000-8000-000000000097",
      },
    };
    const stale = ReviewMetricsPanel({
      reviewMetrics: currentReviewMetrics,
      finalDecision: staleDecision,
      canRecordReviewEffort: true,
      onRecordEffort: () => undefined,
      recordingEffort: false,
      effortError: null,
      effortMinutes: "37",
      onEffortMinutesChange: () => undefined,
    });
    expect(buttonLabels(stale)).toEqual([]);

    const alreadyRecorded = structuredClone(currentReviewMetrics) as Extract<
      AcceptancePrReviewMetricsEnvelope,
      { kind: "record" }
    >;
    alreadyRecorded.cycles[1]!.effort = {
      kind: "known",
      value: {
        eventId: "00000000-0000-4000-8000-000000000068",
        eventKey: `acceptance-pr-review-effort:${currentFinalDecision.binding.reviewJobId}`,
        minutes: 8,
        source: "human_input",
        recordedBy: "user:00000000-0000-4000-8000-000000000002",
        recordedRole: "admin",
        recordedAt: "2026-08-11T09:05:00.000Z",
      },
    };
    alreadyRecorded.summary.reviewEffort = {
      eligible: 2,
      known: 2,
      unknown: 0,
      totalMinutes: 50,
      averageMinutes: 25,
    };
    const recorded = ReviewMetricsPanel({
      reviewMetrics: alreadyRecorded,
      finalDecision: currentFinalDecision,
      canRecordReviewEffort: true,
      onRecordEffort: () => undefined,
      recordingEffort: false,
      effortError: null,
      effortMinutes: "37",
      onEffortMinutesChange: () => undefined,
    });
    expect(buttonLabels(recorded)).toEqual([]);
  });

  it("does not expose timer, source, edit, delete, or merge controls", () => {
    const rendered = ReviewMetricsPanel({
      reviewMetrics: currentReviewMetrics,
      finalDecision: currentFinalDecision,
      canRecordReviewEffort: true,
      onRecordEffort: () => undefined,
      recordingEffort: false,
      effortError: null,
      effortMinutes: "37",
      onEffortMinutesChange: () => undefined,
    });
    const labels = buttonLabels(rendered);

    expect(labels).toEqual(["Record review effort"]);
    expect(labels.some((label) => /timer|source|edit|delete|merge/iu.test(label))).toBe(false);
    expect(elementTypes(rendered)).not.toContain("form");
  });

  it("builds an exact review-effort body without caller-supplied head or source", () => {
    expect(reviewEffortPatchBody(currentFinalDecision.binding.bindingId, 37)).toEqual({
      action: "record_pr_review_effort",
      bindingId: currentFinalDecision.binding.bindingId,
      minutes: 37,
    });
  });

  it("strictly validates current dependency observation, approval, and Pack custody", () => {
    expect(isDependencyObservationsEnvelope(currentDependencyObservations)).toBe(true);
    expect(isDependencyObservationsEnvelope({
      ...currentDependencyObservations,
      observations: [],
    })).toBe(true);
    expect(isDependencyObservationsEnvelope({
      ...currentDependencyObservations,
      observations: [{
        ...currentDependencyObservations.observations[0],
        approval: dependencyApproval,
        externalBuilderPack: dependencyExternalBuilderPack,
      }],
    })).toBe(true);
    expect(isDependencyObservationsEnvelope({
      kind: "not_ready",
      reason: "invalid_approval_pack_custody",
    })).toBe(true);
    expect(isDependencyObservationsEnvelope({ kind: "not_ready", reason: "anything" })).toBe(false);

    const mismatchedPack = structuredClone({
      ...currentDependencyObservations,
      observations: [{
        ...currentDependencyObservations.observations[0],
        approval: dependencyApproval,
        externalBuilderPack: dependencyExternalBuilderPack,
      }],
    }) as Extract<AcceptanceDependencyObservationsEnvelope, { kind: "current" }>;
    mismatchedPack.observations[0]!.externalBuilderPack!.candidate.targetVersion = "2.0.0";
    expect(isDependencyObservationsEnvelope(mismatchedPack)).toBe(false);

    const authorityClaim = structuredClone(currentDependencyObservations) as Record<string, unknown>;
    const authorityItem = (authorityClaim.observations as Array<Record<string, unknown>>)[0]!;
    authorityItem.builderStarted = true;
    expect(isDependencyObservationsEnvelope(authorityClaim)).toBe(false);

    const wrongReference = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope,
      { kind: "current" }
    >;
    wrongReference.observations[0]!.observation.security.reference = "https://osv.dev/report";
    expect(isDependencyObservationsEnvelope(wrongReference)).toBe(false);
  });

  it("offers owner/admin approval only for one current observed unapproved item", () => {
    let approved: string | null = null;
    const rendered = DependencyObservationsPanel({
      dependencyObservations: currentDependencyObservations,
      canApproveDependencyObservation: true,
      onApprove: (eventId) => { approved = eventId; },
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);
    const buttons = elementsOfType(rendered, "button");

    expect(content).toContain("Current exact-head evidence");
    expect(content).toContain("grants no external authority");
    expect(content).toContain("@acme/widget 1.2.3 → 1.3.0");
    expect(content).toContain(dependencyBinding.compiledPack.id);
    expect(buttonLabels(rendered)).toEqual(["Approve & mint external-builder Pack"]);
    (buttons[0]!.props?.onClick as (() => void))();
    expect(approved).toBe(DEPENDENCY_OBSERVATION_EVENT);

    const member = DependencyObservationsPanel({
      dependencyObservations: currentDependencyObservations,
      canApproveDependencyObservation: false,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(buttonLabels(member)).toEqual([]);
    expect(textContent(member)).toContain("workspace owner or admin");

    const refused = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope,
      { kind: "current" }
    >;
    refused.observations[0]!.observation.status = "refused_security";
    refused.observations[0]!.observation.reasons = ["security_affected"];
    refused.observations[0]!.observation.security.disposition = "affected";
    const refusedPanel = DependencyObservationsPanel({
      dependencyObservations: refused,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(buttonLabels(refusedPanel)).toEqual([]);
    expect(textContent(refusedPanel)).toContain("not eligible for approval");
  });

  it("renders an immutable Pack receipt with no external authority or prohibited action controls", () => {
    const approved: AcceptanceDependencyObservationsEnvelope = {
      ...currentDependencyObservations,
      observations: [{
        ...currentDependencyObservations.observations[0],
        approval: dependencyApproval,
        externalBuilderPack: dependencyExternalBuilderPack,
      }],
    };
    const rendered = DependencyObservationsPanel({
      dependencyObservations: approved,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);

    expect(content).toContain("Immutable external-builder Pack receipt");
    expect(content).toContain(DEPENDENCY_PACK_ID);
    expect(content).toContain(dependencyApproval.eventId);
    expect(content).toContain(dependencyExternalBuilderPack.route.snapshotSha256);
    expect(content).toContain("External authority not_granted");
    expect(content).toContain("Required review exact_head_r7_reentry");
    expect(buttonLabels(rendered)).toEqual([]);
    expect(content).not.toMatch(/\b(?:install|issue|dispatch|merge|managed-build)\b/iu);
  });

  it("builds the exact observation-only approval body without head, Pack, or builder fields", () => {
    expect(dependencyObservationApprovalPatchBody(DEPENDENCY_OBSERVATION_EVENT)).toEqual({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT,
    });
  });

  it("fails the load response closed on malformed dependency custody or capability flags", () => {
    const validResponse = {
      record,
      events,
      correctionPackets: currentCorrections,
      finalDecision: currentFinalDecision,
      reviewMetrics: currentReviewMetrics,
      dependencyObservations: currentDependencyObservations,
      canRecordFinalDecision: true,
      canRecordReviewEffort: true,
      canApproveDependencyObservation: true,
    };
    expect(isChangeRecordResponse(validResponse)).toBe(true);
    expect(isChangeRecordResponse({
      ...validResponse,
      dependencyObservations: { kind: "current", binding: {}, observations: [] },
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      canApproveDependencyObservation: "yes",
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      dependencyObservations: undefined,
    })).toBe(false);
  });

  it("formats invalid timestamps without throwing", () => {
    expect(formatChangeRecordDate("not-a-date")).toBe("unknown time");
  });
});
