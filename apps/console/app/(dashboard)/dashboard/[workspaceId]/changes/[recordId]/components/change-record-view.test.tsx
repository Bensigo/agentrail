import { describe, expect, it } from "vitest";
import {
  AcceptanceContractPanel,
  AcceptanceContextPackPanel,
  canRequestExecuteContextPack,
  canSelectExternalBuilder,
  FinalPrDecisionPanel,
  ChangeRecordAnchors,
  LifecycleTimeline,
  changeRecordApiPath,
  formatChangeRecordDate,
  isConfirmableContract,
  type AcceptanceContract,
  type AcceptanceContextPack,
  type AcceptanceEvidenceReview,
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

const record: ChangeRecord = {
  id: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000001",
  repo: "ada/widgets",
  issueNumber: 41,
  prNumber: 98,
  headShas: ["abcdef1234567890"],
  mergedSha: null,
  state: "open",
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:05:00.000Z",
};

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

const draftContract: AcceptanceContract = {
  id: "00000000-0000-0000-0000-000000000020",
  recordId: record.id,
  version: 1,
  status: "draft",
  contract: { request: "Add a visible status", acceptanceCriteria: ["Status is visible"] },
  createdBy: "user:1",
  confirmedBy: null,
  confirmedAt: null,
  createdAt: "2026-08-03T10:00:00.000Z",
};

const contextPack: AcceptanceContextPack = {
  id: "00000000-0000-0000-0000-000000000021",
  recordId: record.id,
  version: 1,
  phase: "execute",
  contentHash: `sha256:${"a".repeat(64)}`,
  compilerVersion: "context-compiler-v1",
  manifest: { citations: [{ path: "src/status.ts" }] },
  custody: { fullSourceUploadAllowed: false },
  freshness: { staleCount: 0 },
  jsonArtifactRef: "workspace://context/pack.json",
  markdownArtifactRef: "workspace://context/pack.md",
  createdBy: "user:1",
  createdAt: "2026-08-03T10:00:00.000Z",
};

const review: AcceptanceEvidenceReview = {
  id: "review-1", prRevisionId: "revision-1", headSha: "a".repeat(40), repositoryFullName: "ada/widgets", prNumber: 98,
  overallStatus: "failed", contractId: "contract-1", contractVersion: 1, createdAt: "2026-08-03T10:03:00.000Z", supersededAt: null,
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

  it("formats invalid timestamps without throwing", () => {
    expect(formatChangeRecordDate("not-a-date")).toBe("unknown time");
  });

  it("shows the contract and makes only an unconfirmed draft actionable", () => {
    const rendered = AcceptanceContractPanel({
      contracts: [draftContract],
      onConfirm: () => undefined,
      confirmingVersion: null,
      confirmationError: null,
    });

    expect(textContent(rendered)).toContain("Confirm contract");
    expect(textContent(rendered)).toContain("Add a visible status");
    expect(isConfirmableContract(draftContract, [draftContract])).toBe(true);

    const confirmed = { ...draftContract, status: "confirmed" as const };
    expect(isConfirmableContract(draftContract, [confirmed, draftContract])).toBe(false);
  });

  it("does not imply a contract exists when the record has none", () => {
    const rendered = AcceptanceContractPanel({
      contracts: [],
      onConfirm: () => undefined,
      confirmingVersion: null,
      confirmationError: null,
    });

    expect(textContent(rendered)).toContain("No Acceptance Contract has been recorded yet");
  });

  it("shows recorded Context Pack identity without implying delivery is proof", () => {
    const rendered = AcceptanceContextPackPanel({ contextPacks: [contextPack] });
    const content = textContent(rendered);

    expect(content).toContain("Context Pack delivery");
    expect(content).toContain("not proof that the agent implemented");
    expect(content).toContain("context-compiler-v1");
    expect(content).toContain("src/status.ts");
  });

  it("permits execute Pack admission only for a confirmed Contract without an execute Pack", () => {
    const confirmed = { ...draftContract, status: "confirmed" as const };
    expect(canRequestExecuteContextPack([confirmed], [])).toBe(true);
    expect(canRequestExecuteContextPack([draftContract], [])).toBe(false);
    expect(canRequestExecuteContextPack([confirmed], [contextPack])).toBe(false);
  });

  it("allows human external-builder selection only after confirmed contract and execute Pack", () => {
    const confirmed = { ...draftContract, status: "confirmed" as const };
    expect(canSelectExternalBuilder([confirmed], [contextPack])).toBe(true);
    expect(canSelectExternalBuilder([draftContract], [contextPack])).toBe(false);
    expect(canSelectExternalBuilder([confirmed], [])).toBe(false);
  });

  it("keeps a non-proven review out of the normal approval path but permits an explicit human exception", () => {
    const rendered = FinalPrDecisionPanel({ reviews: [review], onDecide: () => undefined, decidingReviewId: null, decisionError: null, exceptionRationale: "", onExceptionRationaleChange: () => undefined });
    const content = textContent(rendered);
    expect(content).toContain("Final PR decision");
    expect(content).toContain("Request changes");
    expect(content).toContain("Record approval with exception");
    expect(content).not.toContain("Approve for merge");
    expect(content).toContain("never merges code");
  });
});
