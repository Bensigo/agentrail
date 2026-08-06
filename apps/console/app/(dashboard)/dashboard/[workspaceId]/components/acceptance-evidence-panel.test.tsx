import { describe, expect, it } from "vitest";
import { AcceptanceEvidencePanel, type AcceptanceRecordHeader } from "./acceptance-evidence-panel";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

function collectText(node: unknown, acc: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, acc));
    return acc;
  }
  const element = node as Partial<ReactElementLike>;
  if (element.props) collectText(element.props.children, acc);
  return acc;
}

const workspaceId = "workspace-1";
const records: AcceptanceRecordHeader[] = [
  {
    id: "record-1",
    repo: "Bensigo/agentrail",
    issueNumber: 42,
    prNumber: null,
    state: "confirmed",
    updatedAt: new Date("2026-08-05T12:00:00.000Z"),
  },
  {
    id: "record-2",
    repo: "Bensigo/agentrail",
    issueNumber: null,
    prNumber: 77,
    state: "implemented",
    updatedAt: new Date("2026-08-04T12:00:00.000Z"),
  },
];

describe("AcceptanceEvidencePanel", () => {
  it("labels records, shows evidence fields, and links each card to its record", () => {
    const panel = asElement(AcceptanceEvidencePanel({ workspaceId, records }));
    const text = collectText(panel).join(" ");
    const [, cards] = panel.props.children as ReactElementLike[];
    const [firstCard, secondCard] = asElement(cards).props.children as ReactElementLike[];

    expect(text).toContain("Acceptance evidence");
    expect(text).toContain("Change/Acceptance Record");
    expect(text).toContain("Bensigo/agentrail");
    expect(text).toContain("Issue #42");
    expect(text).toContain("No PR attached");
    expect(text).toContain("No issue attached");
    expect(text).toContain("PR #77");
    expect(text).toContain("confirmed");
    expect(text).toContain("Aug 05, 2026");
    expect(asElement(firstCard).props.href).toBe(`/dashboard/${workspaceId}/changes/record-1`);
    expect(asElement(secondCard).props.href).toBe(`/dashboard/${workspaceId}/changes/record-2`);
  });

  it("offers all records when rows exist and has a truthful empty state", () => {
    const populated = asElement(AcceptanceEvidencePanel({ workspaceId, records: [records[0]!] }));
    const populatedText = collectText(populated).join(" ");
    const [populatedHeader] = populated.props.children as ReactElementLike[];
    const populatedHeaderChildren = asElement(populatedHeader).props.children as ReactElementLike[];
    const allRecordsLink = populatedHeaderChildren[1];

    expect(asElement(allRecordsLink).props.href).toBe(`/dashboard/${workspaceId}/changes`);
    expect(populatedText.toLowerCase()).not.toContain("jace generated");
    expect(populatedText.toLowerCase()).not.toContain("merged code");

    const empty = asElement(AcceptanceEvidencePanel({ workspaceId, records: [] }));
    const emptyText = collectText(empty).join(" ");
    expect(emptyText).toContain("No acceptance records yet.");
    expect(emptyText).toContain("Bring a task to Jace.");
    expect(emptyText).not.toContain("live channel run");
    expect(emptyText).toContain("View work");
    expect(emptyText).not.toContain("legacy");
  });
});
