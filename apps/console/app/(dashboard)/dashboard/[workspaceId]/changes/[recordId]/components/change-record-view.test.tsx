import { describe, expect, it } from "vitest";
import {
  ChangeRecordAnchors,
  CorrectionsSection,
  LifecycleTimeline,
  changeRecordApiPath,
  formatChangeRecordDate,
  isCorrectionPacketsEnvelope,
  type AcceptanceCorrectionPacketsEnvelope,
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
