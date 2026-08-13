import { describe, expect, it } from "vitest";
import type { AcceptanceRecordSummary } from "@agentrail/db-postgres";
import {
  AcceptanceRecordSummaryList,
  parseAcceptanceRecordRepoFilter,
} from "./acceptance-record-summary-list";

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
  return textContent(element.props?.children).replace(/\s+/g, " ").trim();
}

function links(node: unknown): string[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(links);
  const element = node as ElementLike;
  const own = typeof element.props?.href === "string" ? [element.props.href] : [];
  return [...own, ...links(element.props?.children)];
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

const workspaceId = "00000000-0000-4000-8000-000000000001";
const record: AcceptanceRecordSummary = {
  recordId: "00000000-0000-4000-8000-000000000010",
  workspaceId,
  repo: "ada/widgets",
  issueNumber: 41,
  createdAt: new Date("2026-08-10T09:00:00.000Z"),
  updatedAt: new Date("2026-08-10T10:00:00.000Z"),
  requestedWork: {
    kind: "confirmed",
    originalRequest: "Upgrade the signed dependency without changing runtime behavior.",
    acceptanceContract: {
      id: "00000000-0000-4000-8000-000000000020",
      version: 3,
      sha256: "a".repeat(64),
    },
  },
  suppliedContext: {
    kind: "compiled",
    sourceSnapshot: {
      id: "00000000-0000-4000-8000-000000000030",
      headSha: "b".repeat(40),
      headCycleId: "00000000-0000-4000-8000-000000000031",
      compilerVersion: "acceptance-context-v1",
      packetSetSha256: "c".repeat(64),
    },
    compiledPack: {
      id: "00000000-0000-4000-8000-000000000040",
      sha256: "d".repeat(64),
      sourceCustodyIdentitySha256: "e".repeat(64),
      compilerVersion: "acceptance-context-v1",
      policyVersion: "source-custody-v1",
    },
  },
  pullRequest: {
    kind: "attached",
    prNumber: 98,
    head: {
      kind: "current",
      sha: "f".repeat(40),
      headCycleId: "00000000-0000-4000-8000-000000000050",
      authorityGeneration: 4,
    },
  },
  proof: {
    kind: "recorded",
    reviewJobId: "00000000-0000-4000-8000-000000000060",
    verdict: "proven",
    postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-123",
    postedAttestationEventId: "00000000-0000-4000-8000-000000000061",
  },
  unknownReasons: [],
  neededDecision: {
    kind: "required",
    choices: ["approved", "changes_requested", "rejected", "approved_with_exception"],
  },
  outcome: {
    kind: "signed_merge",
    mergeEventId: "00000000-0000-4000-8000-000000000070",
    mergeSha: "1".repeat(40),
    mergedAt: new Date("2026-08-10T11:00:00.000Z"),
    decisionAlignment: "aligned",
    postMerge: {
      deployment: "not_recorded",
      incident: "not_recorded",
      revert: "not_recorded",
    },
  },
};

describe("AcceptanceRecordSummaryList", () => {
  it("renders all seven server-derived Acceptance questions and exact-head proof", () => {
    const rendered = AcceptanceRecordSummaryList({ workspaceId, records: [record] });
    const text = textContent(rendered);

    for (const label of [
      "Requested work",
      "Supplied context",
      "Pull request / exact head",
      "Proof",
      "Unknowns",
      "Needed decision",
      "Outcome",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain(record.requestedWork.kind === "confirmed" ? record.requestedWork.originalRequest : "");
    expect(text).toContain(`Contract ${record.requestedWork.kind === "confirmed" ? record.requestedWork.acceptanceContract.id : ""} v3`);
    expect(text).toContain(`Pack ${record.suppliedContext.kind === "compiled" ? record.suppliedContext.compiledPack.id : ""}`);
    expect(text).toContain(`head ${"f".repeat(40)}`);
    expect(text).toContain("Proven");
    expect(text).toContain(`attestation event ${record.proof.kind === "recorded" ? record.proof.postedAttestationEventId : ""}`);
    expect(text).toContain("Approve, Request changes, Reject, Approve with exception");
    expect(text).toContain(`Signed merge ${"1".repeat(40)}`);
    expect(links(rendered)).toContain(`/dashboard/${workspaceId}/changes/${record.recordId}`);
    expect(links(rendered)).toContain(record.proof.kind === "recorded" ? record.proof.postedReviewUrl : "");
    expect(elementsOfType(rendered, "button")).toHaveLength(0);
    expect(elementsOfType(rendered, "form")).toHaveLength(0);
  });

  it("keeps missing receipts unknown instead of presenting a false no-incident claim", () => {
    const text = textContent(AcceptanceRecordSummaryList({ workspaceId, records: [record] }));

    expect(text).toContain("incident not recorded");
    expect(text).toContain("no receipt does not prove no event");
    expect(text).not.toMatch(/no incident|without incident|incident[- ]free/i);
  });

  it("uses explicit unknown and not-recorded wording for an incomplete Record", () => {
    const incomplete: AcceptanceRecordSummary = {
      ...record,
      requestedWork: { kind: "unknown" },
      suppliedContext: { kind: "unknown" },
      pullRequest: { kind: "not_attached" },
      proof: { kind: "unknown" },
      unknownReasons: [
        "requested_work_not_confirmed",
        "context_not_recorded",
        "proof_not_recorded",
        "decision_not_recorded",
        "outcome_not_recorded",
      ],
      neededDecision: { kind: "unknown" },
      outcome: { kind: "not_recorded" },
    };
    const text = textContent(AcceptanceRecordSummaryList({ workspaceId, records: [incomplete] }));

    expect(text).toContain("Unknown · no confirmed request");
    expect(text).toContain("Unknown — supplied context is not recorded");
    expect(text).toContain("Not attached");
    expect(text).toContain("Unknown · no review proof");
    expect(text).toContain("Unknown · readiness not proven");
    expect(text).toContain("No outcome receipt · not a known negative");
    expect(text).toContain("Not recorded means no canonical receipt");
    expect(text).toContain("no receipt does not prove no event");
  });

  it("bounds the workspace-root compact view and links to the complete Changes surface", () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      ...record,
      recordId: `00000000-0000-4000-8000-00000000001${index}`,
      repo: `ada/widgets-${index}`,
    }));
    const rendered = AcceptanceRecordSummaryList({ workspaceId, records, compact: true });
    const text = textContent(rendered);

    expect(text).toContain("Acceptance summary");
    expect(text).toContain("ada/widgets-4");
    expect(text).not.toContain("ada/widgets-5");
    expect(links(rendered)).toContain(`/dashboard/${workspaceId}/changes`);
  });
});

describe("parseAcceptanceRecordRepoFilter", () => {
  it("canonicalizes valid filters and rejects unsafe or ambiguous values", () => {
    expect(parseAcceptanceRecordRepoFilter("  ada/widgets  ")).toEqual({
      kind: "valid",
      repo: "ada/widgets",
    });
    expect(parseAcceptanceRecordRepoFilter(null)).toEqual({ kind: "absent" });
    expect(parseAcceptanceRecordRepoFilter("ada/widgets/extra")).toEqual({ kind: "invalid" });
    expect(parseAcceptanceRecordRepoFilter("../widgets")).toEqual({ kind: "invalid" });
    expect(parseAcceptanceRecordRepoFilter("ada/..")).toEqual({ kind: "invalid" });
    expect(parseAcceptanceRecordRepoFilter(["ada/widgets", "ada/other"])).toEqual({ kind: "invalid" });
  });
});
