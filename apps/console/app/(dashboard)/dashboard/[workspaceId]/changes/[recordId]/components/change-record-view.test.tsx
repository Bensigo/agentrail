import { describe, expect, it } from "vitest";
import {
  ChangeRecordAnchors,
  CorrectionsSection,
  FinalDecisionPanel,
  LifecycleTimeline,
  changeRecordApiPath,
  finalDecisionPatchBody,
  formatChangeRecordDate,
  isCorrectionPacketsEnvelope,
  isFinalDecisionEnvelope,
  type AcceptanceCorrectionPacketsEnvelope,
  type AcceptanceFinalDecisionEnvelope,
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

  it("formats invalid timestamps without throwing", () => {
    expect(formatChangeRecordDate("not-a-date")).toBe("unknown time");
  });
});
