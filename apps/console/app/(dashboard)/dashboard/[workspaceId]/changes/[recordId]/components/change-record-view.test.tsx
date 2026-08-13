import { describe, expect, it } from "vitest";
import {
  ChangeRecordAnchors,
  ChangeRecordBackLink,
  AcceptanceRecordDetailPanel,
  GatedGithubIssueCard,
  CorrectionsSection,
  DependencyDraftProposalPanel,
  DependencyObservationsPanel,
  FinalDecisionPanel,
  LifecycleTimeline,
  ReviewMetricsPanel,
  ReviewerEvidenceTimeline,
  changeRecordApiPath,
  dependencyObservationApprovalPatchBody,
  finalDecisionPatchBody,
  formatChangeRecordDate,
  isCorrectionPacketsEnvelope,
  isChangeRecordResponse,
  isAcceptanceRecordDetailEnvelope,
  isCriterionOutcomesEnvelope,
  isDependencyObservationsEnvelope,
  isDependencyDraftProposal,
  isFinalDecisionEnvelope,
  isReviewMetricsEnvelope,
  reviewEffortPatchBody,
  criterionArtifactApiPath,
  type AcceptanceCorrectionPacketsEnvelope,
  type AcceptanceRecordDetailEnvelope,
  type AcceptanceCriterionOutcomesEnvelope,
  type AcceptanceDependencyObservationsEnvelope,
  type AcceptanceDependencyDraftProposal,
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
  if (typeof element.type === "function") {
    return links((element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {}));
  }
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
  identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
  package: "@acme/widget",
  dependencyKind: "dependencies" as const,
  specifier: "^1.2.0",
  currentVersion: "1.2.3",
  targetVersion: "1.3.0",
};
const dependencyEvidence = {
  runtime: { identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" }, disposition: "safe" as const, version: "22.14.0", evidenceSha256: "1".repeat(64) },
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
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "clear" as const,
    provider: "osv" as const,
    reference: "osv:npm:@acme/widget@1.3.0",
    reportSha256: "6".repeat(64),
  },
};
const dependencyObservation = {
  eventId: DEPENDENCY_OBSERVATION_EVENT,
  eventKey: `acceptance-dependency-observation:v2:${currentFinalDecision.binding.headCycleId}:${DEPENDENCY_FINGERPRINT_VALUE.slice("sha256:".length)}`,
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
    payloadVersion: 2,
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

function npmDependencyEnvelope(withPack = false): Extract<
  AcceptanceDependencyObservationsEnvelope,
  { kind: "current" }
> {
  const envelope = structuredClone(currentDependencyObservations) as Extract<
    AcceptanceDependencyObservationsEnvelope,
    { kind: "current" }
  >;
  const item = envelope.observations[0]!;
  const identity = { ecosystem: "node", manager: "npm", profile: "npm_package_lock_only_v1" };
  item.observation.candidate = { ...item.observation.candidate, identity };
  item.observation.runtime = { ...item.observation.runtime, identity };
  item.observation.packageManager = {
    ...item.observation.packageManager,
    name: "npm",
    profile: "npm_package_lock_only_v1",
    updateArgv: [
      "npm", "install", "@acme/widget@1.3.0", "--package-lock-only",
      "--ignore-scripts", "--no-audit", "--save-prod",
    ],
  };
  item.observation.manifest = { ...item.observation.manifest, path: "package.json" };
  item.observation.lockfile = { ...item.observation.lockfile, path: "package-lock.json" };
  item.observation.security = { ...item.observation.security, identity };
  if (withPack) {
    item.approval = structuredClone(dependencyApproval);
    item.externalBuilderPack = structuredClone(dependencyExternalBuilderPack);
    item.externalBuilderPack.candidate = structuredClone(item.observation.candidate);
    item.externalBuilderPack.runtime = structuredClone(item.observation.runtime);
    item.externalBuilderPack.packageManager = structuredClone(item.observation.packageManager);
    item.externalBuilderPack.manifest = structuredClone(item.observation.manifest);
    item.externalBuilderPack.lockfile = structuredClone(item.observation.lockfile);
    item.externalBuilderPack.security = structuredClone(item.observation.security);
  }
  return envelope;
}

function yarnDependencyEnvelope(
  withPack = false,
  dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies" = "dependencies",
  dependencyFlag: "--dev" | "--optional" | "--peer" | null = null,
): Extract<AcceptanceDependencyObservationsEnvelope, { kind: "current" }> {
  const envelope = structuredClone(currentDependencyObservations) as Extract<
    AcceptanceDependencyObservationsEnvelope,
    { kind: "current" }
  >;
  const item = envelope.observations[0]!;
  const identity = {
    ecosystem: "node",
    manager: "yarn",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
  };
  item.observation.candidate = {
    ...item.observation.candidate,
    identity,
    dependencyKind,
  };
  item.observation.runtime = { ...item.observation.runtime, identity };
  item.observation.packageManager = {
    ...item.observation.packageManager,
    name: "yarn",
    version: "4.9.2",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
    updateArgv: [
      "yarn", "add", "@acme/widget@1.3.0", "--mode=update-lockfile",
      ...(dependencyFlag ? [dependencyFlag] : []),
    ],
  };
  item.observation.manifest = { ...item.observation.manifest, path: "package.json" };
  item.observation.lockfile = { ...item.observation.lockfile, path: "yarn.lock" };
  item.observation.security = { ...item.observation.security, identity };
  if (withPack) {
    item.approval = structuredClone(dependencyApproval);
    item.externalBuilderPack = structuredClone(dependencyExternalBuilderPack);
    item.externalBuilderPack.candidate = structuredClone(item.observation.candidate);
    item.externalBuilderPack.runtime = structuredClone(item.observation.runtime);
    item.externalBuilderPack.packageManager = structuredClone(item.observation.packageManager);
    item.externalBuilderPack.manifest = structuredClone(item.observation.manifest);
    item.externalBuilderPack.lockfile = structuredClone(item.observation.lockfile);
    item.externalBuilderPack.security = structuredClone(item.observation.security);
  }
  return envelope;
}

function uvDependencyEnvelope(
  withPack = false,
): Extract<AcceptanceDependencyObservationsEnvelope, { kind: "current" }> {
  const envelope = structuredClone(currentDependencyObservations) as Extract<
    AcceptanceDependencyObservationsEnvelope,
    { kind: "current" }
  >;
  const item = envelope.observations[0]!;
  const identity = {
    ecosystem: "python",
    manager: "uv",
    profile: "uv_project_lockfile_only_v1",
  };
  item.observation.candidate = {
    ...item.observation.candidate,
    identity,
    package: "typing-extensions",
    dependencyKind: "dependencies",
    specifier: ">=4.10.0",
    currentVersion: "4.11.0",
    targetVersion: "4.12.2",
  };
  item.observation.runtime = {
    ...item.observation.runtime,
    identity,
    version: "3.12.8",
  };
  item.observation.packageManager = {
    ...item.observation.packageManager,
    name: "uv",
    version: "0.12.1",
    profile: "uv_project_lockfile_only_v1",
    updateArgv: [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package", "typing-extensions==4.12.2",
    ],
  };
  item.observation.manifest = { ...item.observation.manifest, path: "pyproject.toml" };
  item.observation.lockfile = { ...item.observation.lockfile, path: "uv.lock" };
  item.observation.security = {
    ...item.observation.security,
    identity,
    reference: "osv:PyPI:typing-extensions@4.12.2",
  };
  if (withPack) {
    item.approval = structuredClone(dependencyApproval);
    item.externalBuilderPack = structuredClone(dependencyExternalBuilderPack);
    item.externalBuilderPack.candidate = structuredClone(item.observation.candidate);
    item.externalBuilderPack.runtime = structuredClone(item.observation.runtime);
    item.externalBuilderPack.packageManager = structuredClone(item.observation.packageManager);
    item.externalBuilderPack.manifest = structuredClone(item.observation.manifest);
    item.externalBuilderPack.lockfile = structuredClone(item.observation.lockfile);
    item.externalBuilderPack.security = structuredClone(item.observation.security);
  }
  return envelope;
}

function cargoDependencyEnvelope(
  withPack = false,
): Extract<AcceptanceDependencyObservationsEnvelope, { kind: "current" }> {
  const envelope = structuredClone(currentDependencyObservations) as Extract<
    AcceptanceDependencyObservationsEnvelope,
    { kind: "current" }
  >;
  const item = envelope.observations[0]!;
  const identity = {
    ecosystem: "rust",
    manager: "cargo",
    profile: "cargo_lock_registry_only_v1",
  };
  item.binding.compiledPack = {
    ...item.binding.compiledPack,
    compilerVersion: "exact-head-correction-pack-v6",
    policyVersion: "bounded-exact-ranges-v4",
  };
  item.observation.candidate = {
    ...item.observation.candidate,
    identity,
    package: "serde",
    dependencyKind: "dependencies",
    specifier: "^1.0.203",
    currentVersion: "1.0.203",
    targetVersion: "1.0.204",
  };
  item.observation.runtime = {
    ...item.observation.runtime,
    identity,
    version: "1.97.1",
  };
  item.observation.packageManager = {
    ...item.observation.packageManager,
    name: "cargo",
    version: "1.97.1",
    profile: "cargo_lock_registry_only_v1",
    updateArgv: [
      "cargo", "update", "--manifest-path", "Cargo.toml",
      "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.203",
      "--precise", "1.0.204",
    ],
  };
  item.observation.manifest = { ...item.observation.manifest, path: "Cargo.toml" };
  item.observation.lockfile = { ...item.observation.lockfile, path: "Cargo.lock" };
  item.observation.security = {
    ...item.observation.security,
    identity,
    reference: "osv:crates.io:serde@1.0.204",
  };
  if (withPack) {
    item.approval = structuredClone(dependencyApproval);
    item.externalBuilderPack = structuredClone(dependencyExternalBuilderPack);
    item.externalBuilderPack.binding = structuredClone(item.binding);
    item.externalBuilderPack.candidate = structuredClone(item.observation.candidate);
    item.externalBuilderPack.runtime = structuredClone(item.observation.runtime);
    item.externalBuilderPack.packageManager = structuredClone(item.observation.packageManager);
    item.externalBuilderPack.manifest = structuredClone(item.observation.manifest);
    item.externalBuilderPack.lockfile = structuredClone(item.observation.lockfile);
    item.externalBuilderPack.security = structuredClone(item.observation.security);
  }
  return envelope;
}

function composerDependencyEnvelope(
  withPack = false,
): Extract<AcceptanceDependencyObservationsEnvelope, { kind: "current" }> {
  const envelope = structuredClone(currentDependencyObservations) as Extract<
    AcceptanceDependencyObservationsEnvelope,
    { kind: "current" }
  >;
  const item = envelope.observations[0]!;
  const identity = {
    ecosystem: "php",
    manager: "composer",
    profile: "composer_lock_public_packagist_v1",
  };
  item.binding.compiledPack = {
    ...item.binding.compiledPack,
    compilerVersion: "exact-head-correction-pack-v6",
    policyVersion: "bounded-exact-ranges-v4",
  };
  item.observation.candidate = {
    ...item.observation.candidate,
    identity,
    package: "ralouphie/getallheaders",
    dependencyKind: "dependencies",
    specifier: "^3.0.0",
    currentVersion: "3.0.3",
    targetVersion: "3.0.4",
  };
  item.observation.runtime = {
    ...item.observation.runtime,
    identity,
    version: "8.5.9",
  };
  item.observation.packageManager = {
    ...item.observation.packageManager,
    name: "composer",
    version: "2.10.2",
    profile: "composer_lock_public_packagist_v1",
    updateArgv: [
      "composer", "--no-interaction", "--no-plugins", "--no-scripts", "--no-cache",
      "update", "ralouphie/getallheaders:3.0.4", "--with-dependencies",
      "--minimal-changes", "--no-dev", "--no-install", "--no-audit", "--no-progress",
    ],
  };
  item.observation.manifest = { ...item.observation.manifest, path: "composer.json" };
  item.observation.lockfile = { ...item.observation.lockfile, path: "composer.lock" };
  item.observation.security = {
    ...item.observation.security,
    identity,
    reference: "osv:Packagist:ralouphie/getallheaders@3.0.4",
  };
  if (withPack) {
    item.approval = structuredClone(dependencyApproval);
    item.externalBuilderPack = structuredClone(dependencyExternalBuilderPack);
    item.externalBuilderPack.binding = structuredClone(item.binding);
    item.externalBuilderPack.candidate = structuredClone(item.observation.candidate);
    item.externalBuilderPack.runtime = structuredClone(item.observation.runtime);
    item.externalBuilderPack.packageManager = structuredClone(item.observation.packageManager);
    item.externalBuilderPack.manifest = structuredClone(item.observation.manifest);
    item.externalBuilderPack.lockfile = structuredClone(item.observation.lockfile);
    item.externalBuilderPack.security = structuredClone(item.observation.security);
  }
  return envelope;
}
const DETAIL_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000059";
const DETAIL_PACK_ID = "00000000-0000-4000-8000-000000000058";
const DETAIL_CURRENT_HEAD = currentFinalDecision.binding.headSha;
const DETAIL_BASE_SHA = "1".repeat(40);
const DETAIL_MERGE_BASE_SHA = "2".repeat(40);
const DETAIL_TREE_SHA = "3".repeat(40);
const DETAIL_BLOB_SHA = "4".repeat(40);
const DETAIL_RANGE_SHA = "5".repeat(64);
const DETAIL_FULL_CONTENT_SHA = "6".repeat(64);
const DETAIL_WIKI_PAGE_ID = "00000000-0000-4000-8000-000000000057";
const DETAIL_WIKI_REPOSITORY_ID = "00000000-0000-4000-8000-000000000056";

const detailCurrentOccurrence = {
  kind: "current" as const,
  repo: record.repo,
  prNumber: 98,
  headSha: DETAIL_CURRENT_HEAD,
  headCycleId: currentFinalDecision.binding.headCycleId,
  authorityGeneration: 7,
  reviewJob: {
    kind: "recorded" as const,
    id: currentFinalDecision.binding.reviewJobId,
    state: "posted" as const,
    createdAt: "2026-08-11T08:58:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
  },
};
const detailHistoricalOccurrence = {
  kind: "historical" as const,
  repo: record.repo,
  prNumber: 98,
  headSha: DETAIL_CURRENT_HEAD,
  headCycleId: HISTORICAL_CYCLE,
  reviewJob: { kind: "not_recorded" as const },
};
const detailContract = {
  identity: currentFinalDecision.binding.acceptanceContract,
  confirmedBy: "user:00000000-0000-4000-8000-000000000002",
  confirmedAt: "2026-08-10T07:55:00.000Z",
  contract: {
    originalRequest: "Protect the account page and preserve its exact evidence.",
    normalizedRequirements: ["A signed-in member can open the protected page."],
    acceptanceCriteria: [
      {
        id: "criterion-login",
        text: "A signed-in member can open the protected page.",
        userVisible: true,
        modality: "ui" as const,
      },
      {
        id: "criterion-audit",
        text: "The result retains exact-head audit custody.",
        userVisible: false,
        modality: "data" as const,
      },
    ],
    nonGoals: ["Do not add merge automation."],
    risks: ["A stale head could misstate proof."],
    stops: ["Stop if the exact head cannot be proven."],
    environment: { kind: "isolated_preview", browser: "chromium" },
    unresolvedQuestions: [],
  },
};

const currentAcceptanceDetail: AcceptanceRecordDetailEnvelope = {
  kind: "record",
  detail: {
    summary: {
      recordId: record.id,
      workspaceId: record.workspaceId,
      repo: record.repo,
      issueNumber: record.issueNumber,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      requestedWork: {
        kind: "confirmed",
        originalRequest: detailContract.contract.originalRequest,
        acceptanceContract: detailContract.identity,
      },
      suppliedContext: {
        kind: "compiled",
        sourceSnapshot: {
          id: DETAIL_SNAPSHOT_ID,
          headSha: DETAIL_CURRENT_HEAD,
          headCycleId: currentFinalDecision.binding.headCycleId,
          compilerVersion: "acceptance-context-pack-compiler-v2",
          packetSetSha256: PACKET_SET_SHA256,
        },
        compiledPack: {
          id: DETAIL_PACK_ID,
          sha256: "7".repeat(64),
          sourceCustodyIdentitySha256: "8".repeat(64),
          compilerVersion: "acceptance-context-pack-compiler-v2",
          policyVersion: "acceptance-context-pack-policy-v2",
        },
      },
      pullRequest: {
        kind: "attached",
        prNumber: 98,
        head: {
          kind: "current",
          sha: DETAIL_CURRENT_HEAD,
          headCycleId: currentFinalDecision.binding.headCycleId,
          authorityGeneration: 7,
        },
      },
      proof: {
        kind: "recorded",
        reviewJobId: currentFinalDecision.binding.reviewJobId,
        verdict: "failed",
        postedReviewUrl: currentFinalDecision.binding.postedReviewUrl,
        postedAttestationEventId: currentFinalDecision.binding.postedAttestationEventId,
      },
      unknownReasons: ["outcome_not_recorded"],
      neededDecision: {
        kind: "required",
        choices: ["changes_requested", "rejected", "approved_with_exception"],
      },
      outcome: { kind: "not_recorded" },
    },
    contract: detailContract,
    pullRequest: {
      kind: "attached",
      prNumber: 98,
      current: detailCurrentOccurrence,
      merged: null,
      occurrences: [detailCurrentOccurrence, detailHistoricalOccurrence],
    },
    contextPacks: [{
      occurrence: {
        kind: "current",
        repo: record.repo,
        prNumber: 98,
        headSha: DETAIL_CURRENT_HEAD,
        headCycleId: currentFinalDecision.binding.headCycleId,
      },
      sourceSnapshot: {
        id: DETAIL_SNAPSHOT_ID,
        occurrence: {
          kind: "current",
          repo: record.repo,
          prNumber: 98,
          headSha: DETAIL_CURRENT_HEAD,
          headCycleId: currentFinalDecision.binding.headCycleId,
        },
        binding: {
          workspaceId: record.workspaceId,
          recordId: record.id,
          reviewJobId: currentFinalDecision.binding.reviewJobId,
          acceptanceContract: detailContract.identity,
          repo: record.repo,
          prNumber: 98,
          expectedHeadSha: DETAIL_CURRENT_HEAD,
        },
        baseSha: DETAIL_BASE_SHA,
        mergeBaseSha: DETAIL_MERGE_BASE_SHA,
        headTreeSha: DETAIL_TREE_SHA,
        packetIds: [PACKET_ID],
        packetSetSha256: PACKET_SET_SHA256,
        correctionPacketPayloadSetSha256: PACKET_PAYLOAD_SET_SHA256,
        compilerVersion: "acceptance-context-pack-compiler-v2",
        baseIndex: {
          schemaVersion: 2,
          revisionSha256: "9".repeat(64),
          backgroundOnly: true,
          pages: [{
            id: DETAIL_WIKI_PAGE_ID,
            repositoryId: DETAIL_WIKI_REPOSITORY_ID,
            slug: "architecture",
            commitSha: "a".repeat(40),
            inputsHashSha256: "a".repeat(64),
            pageBodySha256: "b".repeat(64),
            stale: false,
          }],
          gaps: [],
        },
        overlay: {
          schemaVersion: 2,
          manifestSha256: "c".repeat(64),
          baseSha: DETAIL_BASE_SHA,
          mergeBaseSha: DETAIL_MERGE_BASE_SHA,
          headSha: DETAIL_CURRENT_HEAD,
          files: [{
            path: "apps/account/page.tsx",
            status: "modified",
            blobSha: DETAIL_BLOB_SHA,
            previousPath: null,
            patchSha256: "d".repeat(64),
            patchByteCount: 240,
            headRanges: [{ startLine: 10, endLine: 18, coordinateSha256: "e".repeat(64) }],
          }],
        },
        provenance: {
          schemaVersion: 1,
          included: [{ path: "apps/account/page.tsx", source: "overlay", reason: "changed file" }],
          excluded: [{ path: null, source: "base_index", reason: "background only" }],
        },
        status: "admitted",
        reason: null,
        createdAt: "2026-08-11T08:59:00.000Z",
        updatedAt: "2026-08-11T08:59:30.000Z",
      },
      compiledPacks: [{
        id: DETAIL_PACK_ID,
        sourceSnapshotId: DETAIL_SNAPSHOT_ID,
        compilerVersion: "acceptance-context-pack-compiler-v2",
        policyVersion: "acceptance-context-pack-policy-v2",
        packSha256: "7".repeat(64),
        sourceCustodyIdentitySha256: "8".repeat(64),
        representations: {
          jsonSha256: "f".repeat(64),
          markdownSha256: "0".repeat(64),
          renderedByteCount: 2048,
        },
        binding: {
          sourceSnapshotId: DETAIL_SNAPSHOT_ID,
          workspaceId: record.workspaceId,
          recordId: record.id,
          reviewJobId: currentFinalDecision.binding.reviewJobId,
          acceptanceContractId: detailContract.identity.id,
          acceptanceContractVersion: detailContract.identity.version,
          acceptanceContractSha256: detailContract.identity.sha256,
          repo: record.repo,
          prNumber: 98,
          baseSha: DETAIL_BASE_SHA,
          mergeBaseSha: DETAIL_MERGE_BASE_SHA,
          headSha: DETAIL_CURRENT_HEAD,
          headTreeSha: DETAIL_TREE_SHA,
          packetSetSha256: PACKET_SET_SHA256,
          correctionPacketPayloadSetSha256: PACKET_PAYLOAD_SET_SHA256,
          sourceSnapshotCompilerVersion: "acceptance-context-pack-compiler-v2",
          baseIndexRevisionSha256: "9".repeat(64),
          overlayManifestSha256: "c".repeat(64),
        },
        manifest: {
          acceptanceCriterionIds: ["criterion-login", "criterion-audit"],
          unresolvedQuestionIds: [],
          packetIds: [PACKET_ID],
          sources: [
            {
              kind: "base_index_background",
              pageId: DETAIL_WIKI_PAGE_ID,
              slug: "architecture",
              commitSha: "a".repeat(40),
              inputsHashSha256: "a".repeat(64),
              pageBodySha256: "b".repeat(64),
              stale: false,
              startLine: 1,
              endLine: 12,
              rangeSha256: "1".repeat(64),
              byteCount: 180,
              reason: "background_only",
              citation: `wiki:architecture@${"a".repeat(40)}#L1-L12`,
            },
            {
              kind: "exact_head_overlay",
              path: "apps/account/page.tsx",
              blobSha: DETAIL_BLOB_SHA,
              fullContentSha256: DETAIL_FULL_CONTENT_SHA,
              startLine: 10,
              endLine: 18,
              rangeSha256: DETAIL_RANGE_SHA,
              byteCount: 320,
              reason: "exact_patch_head_range",
              citation: `apps/account/page.tsx@${DETAIL_BLOB_SHA}#L10-L18`,
            },
          ],
          exclusions: [{
            source: "exact_head_dependency",
            path: "apps/account/secret.ts",
            reason: "dependency_unsafe_path",
            identitySha256: "2".repeat(64),
          }],
          sourceCount: 2,
          exclusionCount: 1,
          architectureBoundaries: ["Account page stays in the authenticated Console boundary."],
          tests: ["Run the protected-page UI criterion."],
          decisions: ["No raw source is persisted."],
          custody: {
            fullSourceUploadAllowed: false,
            rawSourcePersisted: false,
            snippetsPersisted: false,
          },
        },
        sourceCustody: {
          kind: "exact_head_source_custody",
          schemaVersion: 2,
          repo: record.repo,
          prNumber: 98,
          baseSha: DETAIL_BASE_SHA,
          mergeBaseSha: DETAIL_MERGE_BASE_SHA,
          headSha: DETAIL_CURRENT_HEAD,
          headTreeSha: DETAIL_TREE_SHA,
          manifestSha256: "3".repeat(64),
          identitySha256: "8".repeat(64),
          changedManifest: [{
            path: "apps/account/page.tsx",
            status: "modified",
            blobSha: DETAIL_BLOB_SHA,
            previousPath: null,
            headRanges: [{ startLine: 10, endLine: 18 }],
            patchSha256: "d".repeat(64),
            patchByteCount: 240,
          }],
          records: [{
            path: "apps/account/page.tsx",
            blobSha: DETAIL_BLOB_SHA,
            previousPath: null,
            contentSha256: DETAIL_FULL_CONTENT_SHA,
            byteCount: 320,
            lineCount: 24,
            source: "exact_head_overlay",
            reason: "exact_base_to_head_compare",
          }],
          exclusions: [],
          directReadReceipts: [{
            requestedPath: "apps/account/page.tsx",
            headSha: DETAIL_CURRENT_HEAD,
            headTreeSha: DETAIL_TREE_SHA,
            outcome: "record",
            record: {
              path: "apps/account/page.tsx",
              blobSha: DETAIL_BLOB_SHA,
              previousPath: null,
              contentSha256: DETAIL_FULL_CONTENT_SHA,
              byteCount: 320,
              lineCount: 24,
              source: "exact_head_tree_fallback",
              reason: "exact_head_tree_path",
            },
          }],
          selectedExactRanges: [{
            kind: "exact_head_overlay",
            path: "apps/account/page.tsx",
            blobSha: DETAIL_BLOB_SHA,
            fullContentSha256: DETAIL_FULL_CONTENT_SHA,
            startLine: 10,
            endLine: 18,
            rangeSha256: DETAIL_RANGE_SHA,
            byteCount: 320,
          }],
          changedFileCount: 1,
          recordCount: 1,
          exclusionCount: 0,
          directReadReceiptCount: 1,
          selectedExactRangeCount: 1,
        },
        exactHeadDependencyTreeProofs: [{
          path: "apps/account/page.tsx",
          blobSha: DETAIL_BLOB_SHA,
          proofIdentitySha256: "4".repeat(64),
        }],
        createdAt: "2026-08-11T08:59:45.000Z",
      }],
    }],
    proofMatrix: [
      {
        occurrence: {
          kind: "current",
          repo: record.repo,
          prNumber: 98,
          headSha: DETAIL_CURRENT_HEAD,
          headCycleId: currentFinalDecision.binding.headCycleId,
        },
        review: {
          kind: "posted",
          reviewJobId: currentFinalDecision.binding.reviewJobId,
          verdict: "failed",
          postedReviewUrl: currentFinalDecision.binding.postedReviewUrl,
          postedAttestationEventId: currentFinalDecision.binding.postedAttestationEventId,
          reviewedAt: "2026-08-11T09:00:00.000Z",
        },
        criteria: [
          {
            criterion: detailContract.contract.acceptanceCriteria[0]!,
            proof: {
              kind: "correction_packet",
              state: "failed",
              packet: currentCorrections.packets[0]!,
            },
          },
          {
            criterion: detailContract.contract.acceptanceCriteria[1]!,
            proof: {
              kind: "unknown",
              reason: "criterion_result_not_durably_rederivable",
            },
          },
        ],
      },
      {
        occurrence: {
          kind: "historical",
          repo: record.repo,
          prNumber: 98,
          headSha: DETAIL_CURRENT_HEAD,
          headCycleId: HISTORICAL_CYCLE,
        },
        review: { kind: "not_recorded" },
        criteria: detailContract.contract.acceptanceCriteria.map((criterion) => ({
          criterion,
          proof: { kind: "unknown" as const, reason: "review_not_recorded" as const },
        })),
      },
    ],
    artifactCustody: { kind: "unknown", reason: "artifact_custody_not_available" },
    gatedIssue: { kind: "unknown", reason: "gated_issue_custody_not_available" },
  },
};

const draftDependencyProposal: AcceptanceDependencyDraftProposal = {
  kind: "draft",
  record: {
    id: record.id,
    repo: record.repo,
    contractId: "00000000-0000-4000-8000-000000000087",
    contractVersion: 1,
  },
  proposal: {
    custodyIdentity: `sha256:${"e".repeat(64)}`,
    watch: {
      id: "00000000-0000-4000-8000-000000000086",
      observationId: "00000000-0000-4000-8000-000000000085",
      observationKey: "candidate:bounded",
    },
    candidate: {
      package: "react",
      currentVersion: "18.2.0",
      targetVersion: "18.3.0",
      dependencyKind: "dependencies",
    },
    files: {
      manifest: { path: "package.json", sha256: "f".repeat(64) },
      lockfile: { path: "pnpm-lock.yaml", sha256: "a".repeat(64) },
    },
    profile: {
      ecosystem: "node",
      manager: "pnpm",
      profile: "pnpm_lockfile_only_v1",
      capability: "proposal_observation_only",
    },
    repositorySourceVerification: "watch_observation_only",
    independentSourceProof: "not_proven",
    evidenceAdmission: "unresolved",
    laterEvidence: {
      confirmation: "not_recorded",
      contextPack: "not_recorded",
      builderHandoff: "not_recorded",
      delivery: "not_recorded",
      result: "not_recorded",
    },
  },
};

const CURRENT_BUNDLE_ID = "00000000-0000-5000-8000-000000000045";
const CURRENT_UI_RECEIPT_EVENT_ID = "00000000-0000-4000-8000-000000000044";
const CURRENT_DATA_RECEIPT_EVENT_ID = "00000000-0000-4000-8000-000000000043";
const CURRENT_UI_ARTIFACT_ID = "00000000-0000-5000-8000-000000000042";
const CURRENT_DATA_ARTIFACT_ID = "00000000-0000-5000-8000-000000000041";
const currentCriterionOutcomes: AcceptanceCriterionOutcomesEnvelope = {
  kind: "current",
  bundle: {
    id: CURRENT_BUNDLE_ID,
    eventId: CURRENT_BUNDLE_ID,
    eventKey: `review:criterion-outcomes:${currentFinalDecision.binding.headCycleId}`,
    binding: {
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: 98,
      headSha: DETAIL_CURRENT_HEAD,
      headCycleId: currentFinalDecision.binding.headCycleId,
      reviewJobId: currentFinalDecision.binding.reviewJobId,
      acceptanceContract: detailContract.identity,
      verificationPlanEventId: "00000000-0000-4000-8000-000000000040",
      postedAttemptEventId: "00000000-0000-4000-8000-000000000039",
      postedAttestationEventId: currentFinalDecision.binding.postedAttestationEventId,
      outcomeDigest: "a".repeat(64),
      postPayloadDigest: "b".repeat(64),
      reviewVerdict: "failed",
    },
    outcomes: [
      {
        criterionId: "criterion-login",
        criterionText: "A signed-in member can open the protected page.",
        state: "failed",
        expected: "A signed-in member can open the protected page.",
        observed: "The protected page returned an error.",
        evidence: {
          kind: "execution_receipt",
          modality: "ui",
          executionId: `ui-${"1".repeat(48)}`,
          receiptEventId: CURRENT_UI_RECEIPT_EVENT_ID,
          evidenceRef: `review-ui-execution:ui-${"1".repeat(48)}`,
          artifact: {
            artifactId: CURRENT_UI_ARTIFACT_ID,
            contentType: "image/png",
            contentSha256: "c".repeat(64),
          },
        },
      },
      {
        criterionId: "criterion-audit",
        criterionText: "The result retains exact-head audit custody.",
        state: "proven",
        expected: "The result retains exact-head audit custody.",
        observed: "The exact-head receipt matched the plan.",
        evidence: {
          kind: "execution_receipt",
          modality: "data",
          executionId: `data-${"2".repeat(48)}`,
          receiptEventId: CURRENT_DATA_RECEIPT_EVENT_ID,
          evidenceRef: `review-data-execution:data-${"2".repeat(48)}`,
          artifact: {
            artifactId: CURRENT_DATA_ARTIFACT_ID,
            contentType: "application/json",
            contentSha256: "d".repeat(64),
          },
        },
      },
    ],
    outcomeSetSha256: "e".repeat(64),
    sha256: "f".repeat(64),
    recordedAt: "2026-08-11T09:00:01.000Z",
  },
};

const GATED_BINDING_ID = "00000000-0000-5000-8000-000000000038";
const GATED_ISSUE_ID = "00000000-0000-5000-8000-000000000037";
type CurrentGatedIssueProjection = Extract<
  Extract<AcceptanceRecordDetailEnvelope, { kind: "record" }>["detail"]["gatedIssue"],
  { kind: "current" }
>;
type CurrentGatedIssue = NonNullable<CurrentGatedIssueProjection["issue"]>;
const gatedIssueBinding = {
  bindingId: GATED_BINDING_ID,
  workspaceId: record.workspaceId,
  recordId: record.id,
  repo: record.repo,
  prNumber: 98,
  headSha: DETAIL_CURRENT_HEAD,
  headCycleId: currentFinalDecision.binding.headCycleId,
  reviewJobId: currentFinalDecision.binding.reviewJobId,
  authorityGeneration: 7,
  acceptanceContract: detailContract.identity,
  criterionOutcomeBundle: {
    id: CURRENT_BUNDLE_ID,
    eventId: CURRENT_BUNDLE_ID,
    sha256: currentCriterionOutcomes.kind === "current"
      ? currentCriterionOutcomes.bundle.sha256 : "f".repeat(64),
    postedAttestationEventId: currentFinalDecision.binding.postedAttestationEventId,
  },
  packets: [{ packetId: PACKET_ID, sha256: "9".repeat(64) }],
  packetSetSha256: PACKET_SET_SHA256,
  correctionPacketPayloadSetSha256: PACKET_PAYLOAD_SET_SHA256,
};

const reservedGatedIssue = {
  id: GATED_ISSUE_ID,
  status: "reserved" as const,
  requestIdentitySha256: "1".repeat(64),
  titleSha256: "2".repeat(64),
  bodySha256: "3".repeat(64),
  reservedBy: "user:00000000-0000-4000-8000-000000000002",
  reservedRole: "owner" as const,
  reservedAt: "2026-08-11T09:01:00.000Z",
  receipt: null,
  reportedAt: null,
};

const publishedGatedIssue = {
  ...reservedGatedIssue,
  status: "published" as const,
  receipt: {
    kind: "github_201" as const,
    httpStatus: 201 as const,
    githubIssueId: "123456",
    githubIssueNumber: 17,
    githubApiUrl: `https://api.github.com/repos/${record.repo}/issues/17`,
    githubIssueUrl: `https://github.com/${record.repo}/issues/17`,
    githubRequestId: "REQ:1",
    responseTitleSha256: reservedGatedIssue.titleSha256,
    responseBodySha256: reservedGatedIssue.bodySha256,
    state: "open" as const,
  },
  reportedAt: "2026-08-11T09:01:01.000Z",
};

function gatedIssueProjection(issue: CurrentGatedIssue | null): CurrentGatedIssueProjection {
  return { kind: "current", binding: gatedIssueBinding, issue };
}

function acceptanceDetailWithGatedIssue(
  issue: CurrentGatedIssue | null,
): AcceptanceRecordDetailEnvelope {
  if (currentAcceptanceDetail.kind !== "record") {
    throw new Error("expected current Acceptance detail fixture");
  }
  return {
    kind: "record",
    detail: {
      ...currentAcceptanceDetail.detail,
      gatedIssue: gatedIssueProjection(issue),
    },
  };
}

const currentGatedIssueDetail = acceptanceDetailWithGatedIssue(null);

const criterionOutcomesNotReady: AcceptanceCriterionOutcomesEnvelope = {
  kind: "not_ready",
  reason: "criterion_outcome_bundle_not_recorded",
};

describe("Change Record detail view", () => {
  it("returns to the Acceptance/Changes list instead of factory Work", () => {
    const rendered = ChangeRecordBackLink({ workspaceId: record.workspaceId });

    expect(textContent(rendered)).toBe("Back to Changes");
    expect(links(rendered)).toEqual([
      `/dashboard/${record.workspaceId}/changes`,
    ]);
  });

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

  it("renders a concise exact-head reviewer timeline with honest proof boundaries", () => {
    const rendered = ReviewerEvidenceTimeline({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: currentCriterionOutcomes,
      dependencyObservations: currentDependencyObservations,
      finalDecision: currentFinalDecision,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain("Reviewer evidence timeline");
    expect(content).toContain("Acceptance Contract confirmed");
    expect(content).toContain("Pull request#98 bound for review");
    expect(content).toContain(`exact head ${DETAIL_CURRENT_HEAD.slice(0, 12)}`);
    expect(content).toContain("Exact-head review posted");
    expect(content).toContain("Screenshot attached: criterion-login Failed");
    expect(content).toContain("Dependency evidence: @acme/widget Recorded");
    expect(content).toContain("What this proves:");
    expect(content).toContain("Still unproven:");
    expect(content).toContain("does not prove who created the pull request");
    expect(content).toContain("does not upgrade this failed criterion or prove a repair");
    expect(content.indexOf("Acceptance Contract confirmed"))
      .toBeLessThan(content.indexOf("Pull request#98 bound for review"));
    expect(content.indexOf("Pull request#98 bound for review"))
      .toBeLessThan(content.indexOf("Exact-head review posted"));
    expect(links(rendered)).toEqual([
      "#acceptance-contract-evidence",
      "https://github.com/ada/widgets/pull/98",
      currentFinalDecision.binding.postedReviewUrl,
      criterionArtifactApiPath(record.workspaceId, record.id, CURRENT_UI_ARTIFACT_ID),
      "#dependency-observations",
    ]);
    expect(content).not.toContain(CURRENT_DATA_ARTIFACT_ID);
    expect(content).not.toContain("payloadRef");
    expect(content).not.toContain("artifactKey");
    expect(content).not.toContain("Merge pull request");
    expect(buttonLabels(rendered)).toEqual([]);
  });

  it("keeps unavailable and refused reviewer evidence fail closed", () => {
    const refused = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope,
      { kind: "current" }
    >;
    refused.observations[0]!.observation.status = "refused_security";
    refused.observations[0]!.observation.reasons = ["security_affected"];
    const rendered = ReviewerEvidenceTimeline({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: { kind: "not_ready", reason: "criterion_evidence_unavailable" },
      dependencyObservations: refused,
      finalDecision: { kind: "not_current" },
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain("Dependency evidence: @acme/widget Refused");
    expect(content).toContain("security affected");
    expect(content).not.toContain("Screenshot attached");
    expect(content).not.toContain("Human review decision recorded");

    const unavailable = ReviewerEvidenceTimeline({
      acceptanceDetail: { kind: "unavailable", reason: "invalid_record_custody" },
      criterionOutcomes: currentCriterionOutcomes,
      dependencyObservations: currentDependencyObservations,
      finalDecision: currentFinalDecision,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    expect(textContent(unavailable)).toContain(
      "No milestone or proof is inferred from raw lifecycle events."
    );
    expect(links(unavailable)).toEqual([]);
  });

  it("shows a human decision only for the exact current head cycle", () => {
    const decided = structuredClone(currentFinalDecision) as Extract<
      AcceptanceFinalDecisionEnvelope,
      { kind: "current" }
    >;
    decided.decision = {
      eventId: "00000000-0000-4000-8000-000000000035",
      eventKey: `acceptance-pr-decision:${decided.binding.reviewJobId}`,
      decision: "changes_requested",
      rationale: null,
      decidedBy: "user:00000000-0000-4000-8000-000000000002",
      decidedRole: "owner",
      decidedAt: "2026-08-11T09:20:00.000Z",
    };
    const exact = ReviewerEvidenceTimeline({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: currentCriterionOutcomes,
      dependencyObservations: { kind: "not_current" },
      finalDecision: decided,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    expect(textContent(exact)).toContain(
      "Human review decision recorded Recorded What this proves: A workspace owner recorded “Changes requested”"
    );
    expect(textContent(exact)).toContain("does not grant Jace merge authority");

    decided.binding.headCycleId = HISTORICAL_CYCLE;
    const staleCycle = ReviewerEvidenceTimeline({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: currentCriterionOutcomes,
      dependencyObservations: { kind: "not_current" },
      finalDecision: decided,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    expect(textContent(staleCycle)).not.toContain("Human review decision recorded");
  });

  it("does not promote a posted aggregate verdict into criterion proof without the bundle", () => {
    const aggregateOnly = structuredClone(currentAcceptanceDetail) as Extract<
      AcceptanceRecordDetailEnvelope,
      { kind: "record" }
    >;
    if (aggregateOnly.detail.summary.proof.kind !== "recorded") {
      throw new Error("expected recorded summary proof fixture");
    }
    aggregateOnly.detail.summary.proof.verdict = "proven";
    const currentProof = aggregateOnly.detail.proofMatrix[0]!;
    if (currentProof.review.kind !== "posted") throw new Error("expected posted fixture");
    currentProof.review.verdict = "proven";
    currentProof.criteria = currentProof.criteria.map(({ criterion }) => ({
      criterion,
      proof: {
        kind: "unknown" as const,
        reason: "criterion_result_not_durably_rederivable" as const,
      },
    }));

    const rendered = ReviewerEvidenceTimeline({
      acceptanceDetail: aggregateOnly,
      criterionOutcomes: { kind: "not_ready", reason: "criterion_outcome_bundle_not_recorded" },
      dependencyObservations: { kind: "not_current" },
      finalDecision: { kind: "not_current" },
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain("Exact-head review posted Recorded");
    expect(content).toContain("attested an aggregate Proven verdict");
    expect(content).toContain(
      "does not claim which required criteria were proven, failed, unproven, or not testable"
    );
    expect(content).not.toContain(
      "immutable criterion bundle records every required criterion as proven"
    );
  });

  it.each(["failed", "not_proven", "not_testable"] as const)(
    "keeps an aggregate %s verdict criterion-agnostic without the outcome bundle",
    (verdict) => {
      const aggregateOnly = structuredClone(currentAcceptanceDetail) as Extract<
        AcceptanceRecordDetailEnvelope,
        { kind: "record" }
      >;
      const currentProof = aggregateOnly.detail.proofMatrix[0]!;
      if (currentProof.review.kind !== "posted") throw new Error("expected posted fixture");
      currentProof.review.verdict = verdict;
      const rendered = ReviewerEvidenceTimeline({
        acceptanceDetail: aggregateOnly,
        criterionOutcomes: { kind: "not_ready", reason: "criterion_outcome_bundle_not_recorded" },
        dependencyObservations: { kind: "not_current" },
        finalDecision: { kind: "not_current" },
        workspaceId: record.workspaceId,
        recordId: record.id,
      });
      const content = textContent(rendered);

      const label = verdict === "failed" ? "Failed"
        : verdict === "not_proven" ? "Not proven" : "Not testable";
      expect(content).toContain(`attested an aggregate ${label} verdict`);
      expect(content).toContain(
        "does not claim which required criteria were proven, failed, unproven, or not testable"
      );
      expect(content).not.toContain("at least one evidence-bound failed criterion");
      expect(content).not.toContain("which required criterion lacked");
      expect(content).not.toContain("at least one required criterion had no safe bounded exercise");
    },
  );

  it("renders a separate read-only draft dependency proposal without commands or delivery controls", () => {
    expect(isDependencyDraftProposal(draftDependencyProposal)).toBe(true);
    const rendered = DependencyDraftProposalPanel({ dependencyDraftProposal: draftDependencyProposal });
    const content = textContent(rendered);

    expect(content).toContain("Draft dependency proposal");
    expect(content).toContain("react");
    expect(content).toContain("delivery authority: not granted");
    expect(content).toContain("Confirmation, Context Pack, builder handoff, delivery, and result are not recorded.");
    expect(content).not.toContain("pnpm update");
    expect(buttonLabels(rendered)).toEqual([]);
    expect(isDependencyDraftProposal({
      ...draftDependencyProposal,
      proposal: { ...draftDependencyProposal.proposal, rawCommand: "pnpm update react" },
    })).toBe(false);
  });

  it("accepts only the closed npm draft profile and keeps it read-only", () => {
    const npmDraft = structuredClone(draftDependencyProposal) as Extract<
      AcceptanceDependencyDraftProposal,
      { kind: "draft" }
    >;
    npmDraft.proposal.candidate = {
      package: "lodash",
      currentVersion: "4.17.21",
      targetVersion: "4.17.22",
      dependencyKind: "optionalDependencies",
    };
    npmDraft.proposal.files.lockfile = {
      path: "package-lock.json",
      sha256: "a".repeat(64),
    };
    npmDraft.proposal.profile = {
      ecosystem: "node",
      manager: "npm",
      profile: "npm_package_lock_only_v1",
      capability: "proposal_observation_only",
    };

    expect(isDependencyDraftProposal(npmDraft)).toBe(true);
    const rendered = DependencyDraftProposalPanel({ dependencyDraftProposal: npmDraft });
    const content = textContent(rendered);
    expect(content).toContain("node / npm / npm_package_lock_only_v1");
    expect(content).toContain("package-lock.json");
    expect(content).toContain("delivery authority: not granted");
    expect(buttonLabels(rendered)).toEqual([]);

    expect(isDependencyDraftProposal({
      ...npmDraft,
      proposal: {
        ...npmDraft.proposal,
        files: {
          ...npmDraft.proposal.files,
          lockfile: { path: "pnpm-lock.yaml", sha256: "a".repeat(64) },
        },
      },
    })).toBe(false);
    expect(isDependencyDraftProposal({
      ...npmDraft,
      proposal: {
        ...npmDraft.proposal,
        profile: { ...npmDraft.proposal.profile, manager: "yarn" },
      },
    })).toBe(false);
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

  it("renders the validated packet projection under an explicit current exact-head cycle", () => {
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
    expect(content).toContain("Private artifact storage coordinates are withheld");
    expect(content).not.toContain("artifacts/ui/protected.png");
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

  it("strictly validates the npm package-lock-only receipt and immutable Pack", () => {
    const npm = npmDependencyEnvelope();
    const npmWithPack = npmDependencyEnvelope(true);

    expect(isDependencyObservationsEnvelope(npm)).toBe(true);
    expect(isDependencyObservationsEnvelope(npmWithPack)).toBe(true);

    const rendered = DependencyObservationsPanel({
      dependencyObservations: npmWithPack,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);
    expect(content).toContain("safe · npm 10.14.0 · npm_package_lock_only_v1");
    expect(content).toContain("Immutable external-builder Pack receipt");
    expect(content).toContain("External authority not_granted");
    expect(buttonLabels(rendered)).toEqual([]);
    expect(content).not.toMatch(/\b(?:install|issue|dispatch|merge|managed-build)\b/iu);

    const wrongSaveKind = npmDependencyEnvelope();
    wrongSaveKind.observations[0]!.observation.packageManager.updateArgv[6] = "--save-dev";
    expect(isDependencyObservationsEnvelope(wrongSaveKind)).toBe(false);

    const expandedCommand = npmDependencyEnvelope();
    expandedCommand.observations[0]!.observation.packageManager.updateArgv.push("--save-exact");
    expect(isDependencyObservationsEnvelope(expandedCommand)).toBe(false);

    const npmAlias = npmDependencyEnvelope();
    npmAlias.observations[0]!.observation.candidate.specifier =
      "npm:@acme/real-widget@^1.2.0";
    expect(isDependencyObservationsEnvelope(npmAlias)).toBe(false);

    const pnpmAlias = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope,
      { kind: "current" }
    >;
    pnpmAlias.observations[0]!.observation.candidate.specifier =
      "npm:@acme/real-widget@^1.2.0";
    expect(isDependencyObservationsEnvelope(pnpmAlias)).toBe(true);
  });

  it("strictly validates Yarn 4 receipts and the immutable external-builder Pack", () => {
    for (const [dependencyKind, dependencyFlag] of [
      ["dependencies", null],
      ["devDependencies", "--dev"],
      ["optionalDependencies", "--optional"],
      ["peerDependencies", "--peer"],
    ] as const) {
      expect(isDependencyObservationsEnvelope(
        yarnDependencyEnvelope(false, dependencyKind, dependencyFlag)
      )).toBe(true);
    }

    const yarnWithPack = yarnDependencyEnvelope(true);
    expect(isDependencyObservationsEnvelope(yarnWithPack)).toBe(true);
    const rendered = DependencyObservationsPanel({
      dependencyObservations: yarnWithPack,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);
    expect(content).toContain("safe · yarn 4.9.2 · yarn_berry_v4_root_lockfile_only_v1");
    expect(content).toContain("Immutable external-builder Pack receipt");
    expect(content).toContain("External authority not_granted");
    expect(content).not.toMatch(/\.yarnrc|delivery granted|managed-build/iu);
    expect(buttonLabels(rendered)).toEqual([]);

    const wrongFlag = yarnDependencyEnvelope(false, "devDependencies", "--dev");
    wrongFlag.observations[0]!.observation.packageManager.updateArgv[4] = "--optional";
    expect(isDependencyObservationsEnvelope(wrongFlag)).toBe(false);

    const expandedCommand = yarnDependencyEnvelope();
    expandedCommand.observations[0]!.observation.packageManager.updateArgv.push("--immutable");
    expect(isDependencyObservationsEnvelope(expandedCommand)).toBe(false);

    const unsafeSpecifier = yarnDependencyEnvelope();
    unsafeSpecifier.observations[0]!.observation.candidate.specifier = "workspace:^";
    expect(isDependencyObservationsEnvelope(unsafeSpecifier)).toBe(false);

    const oldNode = yarnDependencyEnvelope();
    oldNode.observations[0]!.observation.runtime.version = "18.11.9";
    expect(isDependencyObservationsEnvelope(oldNode)).toBe(false);

    const oldYarn = yarnDependencyEnvelope();
    oldYarn.observations[0]!.observation.packageManager.version = "3.8.7";
    expect(isDependencyObservationsEnvelope(oldYarn)).toBe(false);

    const nestedLockfile = yarnDependencyEnvelope();
    nestedLockfile.observations[0]!.observation.lockfile.path = "packages/widget/yarn.lock";
    expect(isDependencyObservationsEnvelope(nestedLockfile)).toBe(false);
  });

  it("renders DB-derived Yarn configuration refusal and unknown proof without exposing configuration", () => {
    const present = yarnDependencyEnvelope();
    present.observations[0]!.observation.status = "refused_unsafe_runtime";
    present.observations[0]!.observation.reasons = ["unsafe_yarn_configuration_present"];
    expect(isDependencyObservationsEnvelope(present)).toBe(true);

    const absenceUnknown = yarnDependencyEnvelope();
    absenceUnknown.observations[0]!.observation.status = "not_proven";
    absenceUnknown.observations[0]!.observation.reasons = [
      "yarn_configuration_absence_not_proven",
    ];
    expect(isDependencyObservationsEnvelope(absenceUnknown)).toBe(true);
    const rendered = DependencyObservationsPanel({
      dependencyObservations: absenceUnknown,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(textContent(rendered)).toContain("yarn_configuration_absence_not_proven");
    expect(textContent(rendered)).not.toContain(".yarnrc.yml");
    expect(buttonLabels(rendered)).toEqual([]);
  });

  it("strictly validates uv receipts and the immutable external-builder Pack", () => {
    const uv = uvDependencyEnvelope();
    const uvWithPack = uvDependencyEnvelope(true);
    expect(isDependencyObservationsEnvelope(uv)).toBe(true);
    expect(isDependencyObservationsEnvelope(uvWithPack)).toBe(true);

    const rendered = DependencyObservationsPanel({
      dependencyObservations: uvWithPack,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);
    expect(content).toContain("typing-extensions 4.11.0 → 4.12.2");
    expect(content).toContain("safe · python / uv · 3.12.8");
    expect(content).toContain("safe · uv 0.12.1 · uv_project_lockfile_only_v1");
    expect(content).toContain("pyproject.toml");
    expect(content).toContain("uv.lock");
    expect(content).toContain("Immutable external-builder Pack receipt");
    expect(content).toContain("External authority not_granted");
    expect(content).not.toMatch(/execute|delivery granted|managed-build/iu);
    expect(buttonLabels(rendered)).toEqual([]);

    for (const mutate of [
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.package = "typing_extensions";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.dependencyKind = "devDependencies";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.specifier = "^4.10.0";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.targetVersion = "4.10.0";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.runtime.version = "2.7.18";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.packageManager.version = "0.13.0";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.packageManager.updateArgv.splice(6, 1);
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.manifest.path = "python/pyproject.toml";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.lockfile.path = "python/uv.lock";
      },
      (value: ReturnType<typeof uvDependencyEnvelope>) => {
        value.observations[0]!.observation.security.reference =
          "osv:npm:typing-extensions@4.12.2";
      },
    ]) {
      const invalid = uvDependencyEnvelope();
      mutate(invalid);
      expect(isDependencyObservationsEnvelope(invalid)).toBe(false);
    }
  });

  it("keeps a frozen unsupported uv refusal readable without promoting it", () => {
    const historical = uvDependencyEnvelope();
    const observation = historical.observations[0]!.observation;
    observation.packageManager.version = "uv-current";
    observation.packageManager.updateArgv = ["uv", "pip", "install", "typing-extensions"];
    observation.candidate.specifier = "~=4.10";
    observation.status = "refused_unsupported_profile";
    observation.reasons = ["unsupported_manager_profile"];

    expect(isDependencyObservationsEnvelope(historical)).toBe(true);
    const rendered = DependencyObservationsPanel({
      dependencyObservations: historical,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(textContent(rendered)).toContain("Refused: unsupported profile");
    expect(buttonLabels(rendered)).toEqual([]);

    observation.status = "observed";
    observation.reasons = [];
    expect(isDependencyObservationsEnvelope(historical)).toBe(false);
  });

  it("denies former Cargo observed receipts and every approval or Pack affordance", () => {
    expect(isDependencyObservationsEnvelope(cargoDependencyEnvelope())).toBe(false);
    expect(isDependencyObservationsEnvelope(cargoDependencyEnvelope(true))).toBe(false);

    const refused = cargoDependencyEnvelope();
    refused.observations[0]!.observation.status = "refused_unsupported_profile";
    refused.observations[0]!.observation.reasons = ["unsupported_manager_profile"];
    expect(isDependencyObservationsEnvelope(refused)).toBe(true);

    const rendered = DependencyObservationsPanel({
      dependencyObservations: refused,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(textContent(rendered)).toContain("Refused: unsupported profile");
    expect(textContent(rendered)).not.toContain("Immutable external-builder Pack receipt");
    expect(buttonLabels(rendered)).toEqual([]);
  });

  it("keeps frozen and configuration-refused Cargo observations readable without promotion", () => {
    for (const [status, reasons] of [
      ["refused_unsupported_profile", ["unsupported_manager_profile"]],
      ["refused_unsafe_runtime", ["unsafe_cargo_configuration_present"]],
      ["not_proven", ["cargo_configuration_absence_not_proven"]],
    ] as const) {
      const historical = cargoDependencyEnvelope();
      const observation = historical.observations[0]!.observation;
      observation.runtime.version = "1.97.0";
      observation.status = status;
      observation.reasons = [...reasons];

      expect(isDependencyObservationsEnvelope(historical)).toBe(true);
      const rendered = DependencyObservationsPanel({
        dependencyObservations: historical,
        canApproveDependencyObservation: true,
        onApprove: () => undefined,
        approvingObservationEventId: null,
        approvalError: null,
      });
      expect(textContent(rendered)).toContain(reasons[0]);
      expect(buttonLabels(rendered)).toEqual([]);

      observation.status = "observed";
      observation.reasons = [];
      expect(isDependencyObservationsEnvelope(historical)).toBe(false);
    }
  });

  it("strictly validates and renders the Composer observation and no-authority Pack", () => {
    expect(isDependencyObservationsEnvelope(composerDependencyEnvelope())).toBe(true);
    expect(isDependencyObservationsEnvelope(composerDependencyEnvelope(true))).toBe(true);

    const rendered = DependencyObservationsPanel({
      dependencyObservations: composerDependencyEnvelope(true),
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    const content = textContent(rendered);
    expect(content).toContain("ralouphie/getallheaders 3.0.3 → 3.0.4");
    expect(content).toContain("safe · php / composer · 8.5.9");
    expect(content).toContain("safe · composer 2.10.2 · composer_lock_public_packagist_v1");
    expect(content).toContain(
      "composer --no-interaction --no-plugins --no-scripts --no-cache update "
      + "ralouphie/getallheaders:3.0.4 --with-dependencies --minimal-changes "
      + "--no-dev --no-install --no-audit --no-progress",
    );
    expect(content).toContain("composer.json");
    expect(content).toContain("composer.lock");
    expect(content).toContain("exact-head-correction-pack-v6 · bounded-exact-ranges-v4");
    expect(content).toContain("Immutable external-builder Pack receipt");
    expect(content).toContain("External authority not_granted");
    expect(content).not.toMatch(/execute|delivery granted|managed-build|live caller/iu);
    expect(buttonLabels(rendered)).toEqual([]);

    for (const mutate of [
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.package = "Ralouphie/getallheaders";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.dependencyKind = "devDependencies";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.specifier = "^3.0";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.candidate.targetVersion = "4.0.0";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        const observation = value.observations[0]!.observation;
        Object.assign(observation.candidate, {
          specifier: "^1000000000.0.0",
          currentVersion: "1000000000.0.0",
          targetVersion: "1000000000.0.1",
        });
        observation.packageManager.updateArgv[6] =
          "ralouphie/getallheaders:1000000000.0.1";
        observation.security.reference =
          "osv:Packagist:ralouphie/getallheaders@1000000000.0.1";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.runtime.version = "8.5.8";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.packageManager.version = "2.10.1";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.packageManager.updateArgv =
          value.observations[0]!.observation.packageManager.updateArgv
            .filter((token) => token !== "--no-plugins");
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.manifest.path = "packages/app/composer.json";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.lockfile.path = "packages/app/composer.lock";
      },
      (value: ReturnType<typeof composerDependencyEnvelope>) => {
        value.observations[0]!.observation.security.reference =
          "osv:packagist:ralouphie/getallheaders@3.0.4";
      },
    ]) {
      const invalid = composerDependencyEnvelope();
      mutate(invalid);
      expect(isDependencyObservationsEnvelope(invalid)).toBe(false);
    }

    const mismatchedPack = composerDependencyEnvelope(true);
    mismatchedPack.observations[0]!.externalBuilderPack!.packageManager.updateArgv
      .push("--prefer-source");
    expect(isDependencyObservationsEnvelope(mismatchedPack)).toBe(false);
  });
  it("keeps a frozen unsupported npm refusal readable without promoting it", () => {
    const historical = npmDependencyEnvelope();
    const observation = historical.observations[0]!.observation;
    Object.assign(observation.candidate, {
      specifier: "npm:@acme/real-widget@^1.2.0",
      currentVersion: "release-1",
      targetVersion: "release-2",
    });
    observation.runtime.version = "node-current";
    Object.assign(observation.packageManager, {
      version: "npm-current",
      updateArgv: ["npm", "update", "@acme/widget"],
    });
    observation.manifest.path = "legacy/package.json";
    observation.lockfile.path = "legacy/package-lock.json";
    Object.assign(observation.security, {
      provider: "legacy-provider",
      reference: "opaque:historical-query",
    });
    observation.status = "refused_unsupported_profile";
    observation.reasons = ["unsupported_manager_profile"];

    expect(isDependencyObservationsEnvelope(historical)).toBe(true);
    const rendered = DependencyObservationsPanel({
      dependencyObservations: historical,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(textContent(rendered)).toContain("Refused: unsupported profile");
    expect(textContent(rendered)).toContain("unsupported_manager_profile");
    expect(buttonLabels(rendered)).toEqual([]);

    observation.status = "observed";
    observation.reasons = [];
    expect(isDependencyObservationsEnvelope(historical)).toBe(false);
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
    expect(content).not.toContain("Compiler / policy");
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

    const legacy = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope,
      { kind: "current" }
    >;
    legacy.observations[0]!.payloadVersion = 1;
    const legacyObservation = legacy.observations[0]!.observation;
    legacyObservation.eventKey = `acceptance-dependency-observation:${legacy.binding.headCycleId}:${legacyObservation.candidateFingerprint.slice("sha256:".length)}`;
    expect(isDependencyObservationsEnvelope(legacy)).toBe(true);
    const legacyPanel = DependencyObservationsPanel({
      dependencyObservations: legacy,
      canApproveDependencyObservation: true,
      onApprove: () => undefined,
      approvingObservationEventId: null,
      approvalError: null,
    });
    expect(buttonLabels(legacyPanel)).toEqual(["Approve & mint external-builder Pack"]);

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

  it("renders a v2 Poetry refusal without inventing pnpm support or a Pack", () => {
    const poetry = structuredClone(currentDependencyObservations) as Extract<
      AcceptanceDependencyObservationsEnvelope, { kind: "current" }
    >;
    const observation = poetry.observations[0]!.observation;
    const identity = { ecosystem: "python", manager: "poetry", profile: "poetry_lock_v1" };
    observation.candidate = { ...observation.candidate, identity, currentVersion: "1.0rc1", targetVersion: "1.0rc2" };
    observation.runtime = { ...observation.runtime, identity, version: "cpython-3.13" };
    observation.security = { ...observation.security, identity, provider: "opaque", reference: "opaque:poetry-observation" };
    observation.status = "refused_unsupported_profile";
    observation.reasons = ["unsupported_manager_profile"];
    observation.eventKey = `acceptance-dependency-observation:v2:${poetry.observations[0]!.binding.headCycleId}:${observation.candidateFingerprint.slice("sha256:".length)}`;
    expect(isDependencyObservationsEnvelope(poetry)).toBe(true);
    const rendered = DependencyObservationsPanel({
      dependencyObservations: poetry, canApproveDependencyObservation: true,
      onApprove: () => undefined, approvingObservationEventId: null, approvalError: null,
    });
    expect(textContent(rendered)).toContain("Refused: unsupported profile");
    expect(textContent(rendered)).toContain("unsupported_manager_profile");
    expect(buttonLabels(rendered)).toEqual([]);

    observation.status = "observed";
    observation.reasons = [];
    expect(isDependencyObservationsEnvelope(poetry)).toBe(false);
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

  it("strictly validates the full server-custodied Acceptance detail envelope", () => {
    expect(isAcceptanceRecordDetailEnvelope(currentAcceptanceDetail)).toBe(true);
    expect(isAcceptanceRecordDetailEnvelope({ kind: "not_found" })).toBe(true);
    expect(isAcceptanceRecordDetailEnvelope({
      kind: "unavailable",
      reason: "detail_output_limit",
    })).toBe(true);
    expect(isAcceptanceRecordDetailEnvelope({
      kind: "unavailable",
      reason: "carrier_accepted",
    })).toBe(false);

    const extraClaim = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const extraDetail = extraClaim.detail as Record<string, unknown>;
    (extraDetail.gatedIssue as Record<string, unknown>).issueCreated = true;
    expect(isAcceptanceRecordDetailEnvelope(extraClaim)).toBe(false);

    const wrongCycle = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const wrongCycleDetail = wrongCycle.detail as Record<string, unknown>;
    const wrongProof = (wrongCycleDetail.proofMatrix as Array<Record<string, unknown>>)[0]!;
    (wrongProof.occurrence as Record<string, unknown>).headCycleId = HISTORICAL_CYCLE;
    expect(isAcceptanceRecordDetailEnvelope(wrongCycle)).toBe(false);

    const rawSourceClaim = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const rawDetail = rawSourceClaim.detail as Record<string, unknown>;
    const rawPack = (((rawDetail.contextPacks as Array<Record<string, unknown>>)[0]!
      .compiledPacks as Array<Record<string, unknown>>)[0]!);
    ((rawPack.manifest as Record<string, unknown>).custody as Record<string, unknown>).rawSourcePersisted = true;
    expect(isAcceptanceRecordDetailEnvelope(rawSourceClaim)).toBe(false);

    const badCount = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const countDetail = badCount.detail as Record<string, unknown>;
    const countPack = (((countDetail.contextPacks as Array<Record<string, unknown>>)[0]!
      .compiledPacks as Array<Record<string, unknown>>)[0]!);
    (countPack.manifest as Record<string, unknown>).sourceCount = 3;
    expect(isAcceptanceRecordDetailEnvelope(badCount)).toBe(false);

    const inventedHistoricalGeneration = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const historicalDetail = inventedHistoricalGeneration.detail as Record<string, unknown>;
    const historical = ((historicalDetail.pullRequest as Record<string, unknown>)
      .occurrences as Array<Record<string, unknown>>)[1]!;
    historical.authorityGeneration = 6;
    expect(isAcceptanceRecordDetailEnvelope(inventedHistoricalGeneration)).toBe(false);
  });

  it("renders full Contract, exact occurrences, selected context, and honest criterion unknowns without actions", () => {
    const rendered = AcceptanceRecordDetailPanel({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: criterionOutcomesNotReady,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain("Confirmed Acceptance Contract");
    expect(content).toContain(detailContract.contract.originalRequest);
    expect(content).toContain("Do not add merge automation.");
    expect(content).toContain("Stop if the exact head cannot be proven.");
    expect(content).toContain("criterion-login");
    expect(content).toContain("criterion-audit");
    expect(content).toContain("Current authoritative occurrence");
    expect(content).toContain("Historical occurrence");
    expect(content).toContain(detailCurrentOccurrence.headCycleId);
    expect(content).toContain(detailHistoricalOccurrence.headCycleId);
    expect(content).toContain("Not durably recorded for this historical cycle");
    expect(content).toContain(DETAIL_CURRENT_HEAD);
    expect(content).toContain("Compiled Pack receipt");
    expect(content).toContain(`apps/account/page.tsx@${DETAIL_BLOB_SHA}#L10-L18`);
    expect(content).toContain("apps/account/secret.ts");
    expect(content).toContain("raw source and snippets are not persisted");
    expect(content).toContain("Correction context(failed)");
    expect(content).toContain("criterion result not durably rederivable");
    expect(content).toContain("Aggregate review verdicts are not treated as criterion proof");
    expect(content).toContain("Current artifact receipts: Unknown");
    expect(content).toContain("Gated issue custody: Unknown");
    expect(elementTypes(rendered)).not.toContain("button");
    expect(elementTypes(rendered)).not.toContain("form");
    expect(links(rendered)).toEqual([]);
    expect(content).not.toContain("artifacts/ui/protected.png");
    expect(content).not.toContain("review-evidence/");
    expect(content).not.toContain("Artifact key");
    expect(content).not.toMatch(/(?:Create issue|Merge PR|Delivered|Acknowledged|Repaired)/u);
  });

  it("strictly validates current gated-issue binding and terminal GitHub receipt custody", () => {
    expect(isAcceptanceRecordDetailEnvelope(currentGatedIssueDetail)).toBe(true);
    expect(isAcceptanceRecordDetailEnvelope(
      acceptanceDetailWithGatedIssue(publishedGatedIssue),
    )).toBe(true);
    expect(isAcceptanceRecordDetailEnvelope(acceptanceDetailWithGatedIssue({
      ...reservedGatedIssue,
      reservedBy: "user:00000000-0000-7000-8000-000000000002",
    }))).toBe(true);

    const broadRepo = structuredClone(currentGatedIssueDetail) as Record<string, unknown>;
    const broadRepoDetail = broadRepo.detail as Record<string, unknown>;
    const broadRepoGated = broadRepoDetail.gatedIssue as Record<string, unknown>;
    (broadRepoGated.binding as Record<string, unknown>).repo = `${"a".repeat(101)}/widgets`;
    expect(isAcceptanceRecordDetailEnvelope(broadRepo)).toBe(false);

    const wrongBundle = structuredClone(currentGatedIssueDetail) as Record<string, unknown>;
    const wrongBundleDetail = wrongBundle.detail as Record<string, unknown>;
    const wrongBundleGated = wrongBundleDetail.gatedIssue as Record<string, unknown>;
    const wrongBinding = wrongBundleGated.binding as Record<string, unknown>;
    (wrongBinding.criterionOutcomeBundle as Record<string, unknown>).postedAttestationEventId =
      "00000000-0000-4000-8000-000000000099";
    expect(isAcceptanceRecordDetailEnvelope(wrongBundle)).toBe(false);

    const wrongPacket = structuredClone(currentGatedIssueDetail) as Record<string, unknown>;
    const wrongPacketDetail = wrongPacket.detail as Record<string, unknown>;
    const wrongPacketGated = wrongPacketDetail.gatedIssue as Record<string, unknown>;
    const wrongPacketBinding = wrongPacketGated.binding as Record<string, unknown>;
    (wrongPacketBinding.packets as Array<Record<string, unknown>>)[0]!.packetId =
      `correction-${"e".repeat(48)}`;
    expect(isAcceptanceRecordDetailEnvelope(wrongPacket)).toBe(false);

    const wrongReceipt = structuredClone(
      acceptanceDetailWithGatedIssue(publishedGatedIssue),
    ) as Record<string, unknown>;
    const wrongReceiptDetail = wrongReceipt.detail as Record<string, unknown>;
    const wrongReceiptGated = wrongReceiptDetail.gatedIssue as Record<string, unknown>;
    const wrongReceiptIssue = wrongReceiptGated.issue as Record<string, unknown>;
    (wrongReceiptIssue.receipt as Record<string, unknown>).githubIssueUrl =
      "https://github.com/other/repo/issues/17";
    expect(isAcceptanceRecordDetailEnvelope(wrongReceipt)).toBe(false);
  });

  it("renders read-only gated issue custody without exposing a Console write path", () => {
    const eligible = GatedGithubIssueCard({
      gatedIssue: gatedIssueProjection(null),
    });
    expect(textContent(eligible)).toContain("Gated issue: Not recorded");
    expect(textContent(eligible)).toContain("Ask Jace to create the current correction issue");
    expect(textContent(eligible)).toContain(record.id);
    expect(textContent(eligible)).toContain("request human approval before GitHub is called");
    expect(textContent(eligible)).toContain("Jace's gated path sends no trigger label");
    expect(buttonLabels(eligible)).toEqual([]);

    const reserved = GatedGithubIssueCard({
      gatedIssue: gatedIssueProjection(reservedGatedIssue),
    });
    expect(textContent(reserved)).toContain("Gated issue publication: Held");
    expect(textContent(reserved)).toContain("will not be retried automatically");
    expect(buttonLabels(reserved)).toEqual([]);

    const published = GatedGithubIssueCard({
      gatedIssue: gatedIssueProjection(publishedGatedIssue),
    });
    expect(textContent(published)).toContain("Gated issue custody: Created");
    expect(links(published)).toEqual([publishedGatedIssue.receipt.githubIssueUrl]);

    const failedIssue: CurrentGatedIssue = {
      ...reservedGatedIssue,
      status: "bounded_failed",
      receipt: { kind: "bounded_failed", reason: "github_rejected" },
      reportedAt: "2026-08-11T09:01:01.000Z",
    };
    expect(textContent(GatedGithubIssueCard({
      gatedIssue: gatedIssueProjection(failedIssue),
    }))).toContain("Gated issue publication: Failed");

    const ambiguousIssue: CurrentGatedIssue = {
      ...reservedGatedIssue,
      status: "ambiguous_hold",
      receipt: { kind: "ambiguous_hold", reason: "ambiguous_response" },
      reportedAt: "2026-08-11T09:01:01.000Z",
    };
    expect(textContent(GatedGithubIssueCard({
      gatedIssue: gatedIssueProjection(ambiguousIssue),
    }))).toContain("held without retry");
  });

  it("keeps gated issue guidance read-only even when the current bundle is available", () => {
    const exact = AcceptanceRecordDetailPanel({
      acceptanceDetail: currentGatedIssueDetail,
      criterionOutcomes: currentCriterionOutcomes,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    expect(buttonLabels(exact)).toEqual([]);
    expect(textContent(exact)).toContain("Ask Jace to create the current correction issue");

    const unavailableBundle = AcceptanceRecordDetailPanel({
      acceptanceDetail: currentGatedIssueDetail,
      criterionOutcomes: criterionOutcomesNotReady,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    expect(buttonLabels(unavailableBundle)).toEqual([]);
    expect(textContent(unavailableBundle)).toContain("Ask Jace to create the current correction issue");
  });

  it("strictly validates current criterion custody without accepting keys, URLs, or artifact claims on non-proof", () => {
    expect(isCriterionOutcomesEnvelope(currentCriterionOutcomes)).toBe(true);
    expect(isCriterionOutcomesEnvelope(criterionOutcomesNotReady)).toBe(true);
    expect(isCriterionOutcomesEnvelope({
      kind: "not_ready",
      reason: "carrier_accepted",
    })).toBe(false);

    const rawKey = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const rawKeyBundle = rawKey.bundle as Record<string, unknown>;
    const rawKeyOutcome = (rawKeyBundle.outcomes as Array<Record<string, unknown>>)[0]!;
    const rawKeyEvidence = rawKeyOutcome.evidence as Record<string, unknown>;
    (rawKeyEvidence.artifact as Record<string, unknown>).objectKey = "review-evidence/private.png";
    expect(isCriterionOutcomesEnvelope(rawKey)).toBe(false);

    const nonV5Bundle = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const nonV5BundleBody = nonV5Bundle.bundle as Record<string, unknown>;
    nonV5BundleBody.id = "00000000-0000-4000-8000-000000000045";
    nonV5BundleBody.eventId = "00000000-0000-4000-8000-000000000045";
    expect(isCriterionOutcomesEnvelope(nonV5Bundle)).toBe(false);

    const nonV5Artifact = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const nonV5ArtifactOutcome = (((nonV5Artifact.bundle as Record<string, unknown>)
      .outcomes as Array<Record<string, unknown>>)[0]!);
    (((nonV5ArtifactOutcome.evidence as Record<string, unknown>).artifact) as Record<string, unknown>)
      .artifactId = "00000000-0000-4000-8000-000000000042";
    expect(isCriterionOutcomesEnvelope(nonV5Artifact)).toBe(false);

    const missingArtifact = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const missingBundle = missingArtifact.bundle as Record<string, unknown>;
    const failedOutcome = (missingBundle.outcomes as Array<Record<string, unknown>>)[0]!;
    (failedOutcome.evidence as Record<string, unknown>).artifact = null;
    expect(isCriterionOutcomesEnvelope(missingArtifact)).toBe(false);

    const malformedExecution = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const malformedExecutionOutcome = (((malformedExecution.bundle as Record<string, unknown>)
      .outcomes as Array<Record<string, unknown>>)[0]!);
    (malformedExecutionOutcome.evidence as Record<string, unknown>).executionId = `ui-${"a".repeat(47)}`;
    expect(isCriterionOutcomesEnvelope(malformedExecution)).toBe(false);

    const mismatchedExecutionRef = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const mismatchedExecutionOutcome = (((mismatchedExecutionRef.bundle as Record<string, unknown>)
      .outcomes as Array<Record<string, unknown>>)[0]!);
    (mismatchedExecutionOutcome.evidence as Record<string, unknown>).evidenceRef = "review-ui-execution:foreign";
    expect(isCriterionOutcomesEnvelope(mismatchedExecutionRef)).toBe(false);

    const wrongUiArtifactType = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const wrongUiOutcome = (((wrongUiArtifactType.bundle as Record<string, unknown>)
      .outcomes as Array<Record<string, unknown>>)[0]!);
    (((wrongUiOutcome.evidence as Record<string, unknown>).artifact) as Record<string, unknown>)
      .contentType = "application/json";
    expect(isCriterionOutcomesEnvelope(wrongUiArtifactType)).toBe(false);

    const mismatchedPlan = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const mismatchedPlanBundle = mismatchedPlan.bundle as Record<string, unknown>;
    const mismatchedPlanOutcome = (mismatchedPlanBundle.outcomes as Array<Record<string, unknown>>)[1]!;
    mismatchedPlanOutcome.state = "not_testable";
    mismatchedPlanOutcome.evidence = {
      kind: "not_testable_plan",
      planEventId: "00000000-0000-4000-8000-000000000099",
    };
    expect(isCriterionOutcomesEnvelope(mismatchedPlan)).toBe(false);

    const malformedPreview = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const malformedPreviewBundle = malformedPreview.bundle as Record<string, unknown>;
    const malformedPreviewOutcome = (malformedPreviewBundle.outcomes as Array<Record<string, unknown>>)[1]!;
    malformedPreviewOutcome.state = "not_proven";
    malformedPreviewOutcome.evidence = {
      kind: "preview_receipt",
      previewBootId: "00000000-0000-4000-8000-0000000000AA",
      evidenceRef: "preview-boot:00000000-0000-4000-8000-0000000000AA",
    };
    expect(isCriterionOutcomesEnvelope(malformedPreview)).toBe(false);

    const falseVerdict = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    (((falseVerdict.bundle as Record<string, unknown>).binding) as Record<string, unknown>)
      .reviewVerdict = "proven";
    expect(isCriterionOutcomesEnvelope(falseVerdict)).toBe(false);

    expect(criterionArtifactApiPath("workspace/1", "record/2", "artifact/3")).toBe(
      "/api/v1/workspaces/workspace%2F1/change-records/record%2F2/criterion-outcomes/artifacts/artifact%2F3",
    );
  });

  it.each([
    "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "token=abcdefghijk12345",
    "api_key=abcdefghijk12345",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  ])("rejects secret-shaped text at the criterion outcome client boundary", (secretText) => {
    const unsafe = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const bundle = unsafe.bundle as Record<string, unknown>;
    const outcome = (bundle.outcomes as Array<Record<string, unknown>>)[0]!;
    outcome.observed = secretText;
    expect(isCriterionOutcomesEnvelope(unsafe)).toBe(false);
  });

  it("keeps ordinary credential-related outcome and correction observations", () => {
    const safeOutcomes = structuredClone(currentCriterionOutcomes) as Record<string, unknown>;
    const bundle = safeOutcomes.bundle as Record<string, unknown>;
    ((bundle.outcomes as Array<Record<string, unknown>>)[0]!).observed =
      "The authorization step asked the user to reset their password.";
    expect(isCriterionOutcomesEnvelope(safeOutcomes)).toBe(true);

    const safeCorrections = structuredClone(currentCorrections) as Record<string, unknown>;
    ((safeCorrections.packets as Array<Record<string, unknown>>)[0]!).requiredCorrection =
      "Reset the password field and rerun the exact check.";
    expect(isCorrectionPacketsEnvelope(safeCorrections)).toBe(true);
  });

  it("rejects secret-shaped current and historical correction text at the client boundary", () => {
    const unsafeCurrent = structuredClone(currentCorrections) as Record<string, unknown>;
    ((unsafeCurrent.packets as Array<Record<string, unknown>>)[0]!).requiredCorrection =
      "Replace token=abcdefghijk12345 before retrying.";
    expect(isCorrectionPacketsEnvelope(unsafeCurrent)).toBe(false);

    const unsafeDetail = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const detail = unsafeDetail.detail as Record<string, unknown>;
    const proofMatrix = detail.proofMatrix as Array<Record<string, unknown>>;
    const criteria = proofMatrix[0]!.criteria as Array<Record<string, unknown>>;
    const proof = criteria[0]!.proof as Record<string, unknown>;
    (proof.packet as Record<string, unknown>).impact = "authorization: abcdefghijk12345";
    expect(isAcceptanceRecordDetailEnvelope(unsafeDetail)).toBe(false);
  });

  it("rejects secret-shaped Contract text in an unattached Record detail", () => {
    const unattached = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const detail = unattached.detail as Record<string, unknown>;
    const summary = detail.summary as Record<string, unknown>;
    const requestedWork = summary.requestedWork as Record<string, unknown>;
    const contract = detail.contract as Record<string, unknown>;
    const contractProjection = contract.contract as Record<string, unknown>;
    summary.pullRequest = { kind: "not_attached" };
    summary.suppliedContext = { kind: "unknown" };
    summary.proof = { kind: "unknown" };
    summary.neededDecision = { kind: "not_required", reason: "pr_not_attached" };
    detail.pullRequest = { kind: "not_attached", occurrences: [] };
    detail.contextPacks = [];
    detail.proofMatrix = [];

    expect(isAcceptanceRecordDetailEnvelope(unattached)).toBe(true);
    requestedWork.originalRequest = "api_key=abcdefghijk12345";
    contractProjection.originalRequest = "api_key=abcdefghijk12345";
    expect(isAcceptanceRecordDetailEnvelope(unattached)).toBe(false);
  });

  it("merges the current immutable bundle into the Contract-ordered proof matrix", () => {
    const rendered = AcceptanceRecordDetailPanel({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: currentCriterionOutcomes,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain(`Current immutable bundle ${"f".repeat(64)}`);
    expect(content).toContain("Current recorded outcome: Failed");
    expect(content).toContain("Current recorded outcome: Proven");
    expect(content).toContain("The protected page returned an error.");
    expect(content).toContain("The exact-head receipt matched the plan.");
    expect(content).toContain("Correction context(failed)");
    expect(content).not.toContain("criterion result not durably rederivable");
    expect(content).toContain("Current artifact receipts: 2");
    expect(content).toContain("2 receipt-bound artifacts in the current bundle");
    expect(links(rendered)).toEqual([
      criterionArtifactApiPath(record.workspaceId, record.id, CURRENT_UI_ARTIFACT_ID),
      criterionArtifactApiPath(record.workspaceId, record.id, CURRENT_DATA_ARTIFACT_ID),
    ]);
    expect(content).not.toContain("review-evidence/");
  });

  it("labels an exact zero artifact receipt count without claiming recorded custody", () => {
    const noArtifactOutcomes = structuredClone(
      currentCriterionOutcomes,
    ) as AcceptanceCriterionOutcomesEnvelope;
    if (noArtifactOutcomes.kind !== "current") throw new Error("expected current fixture");
    noArtifactOutcomes.bundle.binding.reviewVerdict = "not_proven";
    const firstOutcome = noArtifactOutcomes.bundle.outcomes[0]!;
    firstOutcome.state = "not_proven";
    if (firstOutcome.evidence.kind !== "execution_receipt") throw new Error("expected execution fixture");
    firstOutcome.evidence.artifact = null;
    const secondOutcome = noArtifactOutcomes.bundle.outcomes[1]!;
    secondOutcome.state = "not_testable";
    secondOutcome.evidence = {
      kind: "not_testable_plan",
      planEventId: noArtifactOutcomes.bundle.binding.verificationPlanEventId,
    };
    expect(isCriterionOutcomesEnvelope(noArtifactOutcomes)).toBe(true);

    const rendered = AcceptanceRecordDetailPanel({
      acceptanceDetail: currentAcceptanceDetail,
      criterionOutcomes: noArtifactOutcomes,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });
    const content = textContent(rendered);

    expect(content).toContain("Current artifact receipts: 0");
    expect(content).not.toContain("Current artifact receipts: Recorded");
    expect(links(rendered)).toEqual([]);
  });

  it("renders closed unavailable detail without falling back to timeline inference", () => {
    const rendered = AcceptanceRecordDetailPanel({
      acceptanceDetail: { kind: "unavailable", reason: "invalid_review_custody" },
      criterionOutcomes: criterionOutcomesNotReady,
      workspaceId: record.workspaceId,
      recordId: record.id,
    });

    expect(textContent(rendered)).toContain("No detail is inferred from the raw timeline");
    expect(buttonLabels(rendered)).toEqual([]);
  });

  it("fails the load response closed on malformed dependency custody or capability flags", () => {
    const validResponse = {
      record,
      events,
      correctionPackets: currentCorrections,
      finalDecision: currentFinalDecision,
      reviewMetrics: currentReviewMetrics,
      dependencyObservations: currentDependencyObservations,
      acceptanceDetail: currentAcceptanceDetail,
      dependencyDraftProposal: draftDependencyProposal,
      criterionOutcomes: criterionOutcomesNotReady,
      canRecordFinalDecision: true,
      canRecordReviewEffort: true,
      canApproveDependencyObservation: true,
      canCreateGatedGithubIssue: true,
    };
    expect(isChangeRecordResponse(validResponse)).toBe(true);
    expect(isChangeRecordResponse({
      ...validResponse,
      criterionOutcomes: currentCriterionOutcomes,
    })).toBe(true);
    const unpostedDetail = structuredClone(currentAcceptanceDetail) as Record<string, unknown>;
    const unpostedDetailBody = unpostedDetail.detail as Record<string, unknown>;
    const unpostedPullRequest = unpostedDetailBody.pullRequest as Record<string, unknown>;
    const unpostedCurrent = unpostedPullRequest.current as Record<string, unknown>;
    (unpostedCurrent.reviewJob as Record<string, unknown>).state = "running";
    const unpostedOccurrences = unpostedPullRequest.occurrences as Array<Record<string, unknown>>;
    ((unpostedOccurrences[0]!.reviewJob) as Record<string, unknown>).state = "running";
    expect(isAcceptanceRecordDetailEnvelope(unpostedDetail)).toBe(true);
    expect(isChangeRecordResponse({
      ...validResponse,
      acceptanceDetail: unpostedDetail,
      criterionOutcomes: currentCriterionOutcomes,
    })).toBe(false);
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
      canCreateGatedGithubIssue: "yes",
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      dependencyObservations: undefined,
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      acceptanceDetail: undefined,
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      acceptanceDetail: { kind: "record", detail: { merged: true } },
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      dependencyDraftProposal: { kind: "draft", proposal: {} },
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      events: [{
        ...events[0],
        eventKey: `dependency-observation-proposal:draft:sha256:${"d".repeat(64)}`,
        stage: "dependency_observation_proposal",
        payloadRef: {
          kind: "dependency_observation_proposal_draft",
          candidate: { manager_commands: { update: "pnpm update package" } },
        },
      }],
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      events: [{
        ...events[0],
        eventKey: `dependency-observation-proposal:draft:sha256:${"d".repeat(64)}`,
        stage: "dependency_observation_proposal",
        payloadRef: {
          kind: "redacted_dependency_observation_proposal",
          version: 1,
          disclosure: "bounded_projection_only",
        },
      }],
    })).toBe(true);
    expect(isChangeRecordResponse({
      ...validResponse,
      events: [{
        ...events[0],
        eventKey: `review:criterion-outcomes:${currentFinalDecision.binding.headCycleId}`,
        stage: "review",
        payloadRef: {
          kind: "acceptance_criterion_outcome_bundle",
          observed: "token=abcdefghijk12345",
        },
      }],
    })).toBe(false);
    expect(isChangeRecordResponse({
      ...validResponse,
      events: [{
        ...events[0],
        eventKey: `review:criterion-outcomes:${currentFinalDecision.binding.headCycleId}`,
        stage: "review",
        payloadRef: {
          kind: "redacted_criterion_custody_payload",
          version: 1,
          disclosure: "secret_shaped_text_withheld",
        },
      }],
    })).toBe(true);
    expect(isChangeRecordResponse({
      ...validResponse,
      criterionOutcomes: undefined,
    })).toBe(false);
  });

  it("formats invalid timestamps without throwing", () => {
    expect(formatChangeRecordDate("not-a-date")).toBe("unknown time");
  });
});
