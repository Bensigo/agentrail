import { describe, expect, it, vi } from "vitest";
import type { AcceptanceBriefBindingRead } from "@agentrail/db-postgres";
import { AcceptanceBriefTransitionPanel } from "./page";

vi.mock("../../../../../../lib/cached", () => ({
  getMembership: vi.fn(),
  getSession: vi.fn(),
}));

interface ReactElementLike {
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
  const element = node as Partial<ReactElementLike> & { props?: { children?: unknown } };
  if (element.props) collectText(element.props.children, acc);
  return acc;
}

function collectHrefs(node: unknown, acc: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => collectHrefs(child, acc));
    return acc;
  }

  const element = node as Partial<ReactElementLike> & { props?: { href?: unknown; children?: unknown } };
  if (typeof element.props?.href === "string") acc.push(element.props.href);
  if (element.props) collectHrefs(element.props.children, acc);
  return acc;
}

const workspaceId = "workspace-1";

function makeBinding(recordId: string): AcceptanceBriefBindingRead {
  return {
    binding: {
      workspaceId,
      recordId,
      briefId: "brief-1",
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
      updatedAt: new Date("2026-08-05T12:00:00.000Z"),
    } as unknown as AcceptanceBriefBindingRead["binding"],
    record: {
      id: recordId,
    } as unknown as AcceptanceBriefBindingRead["record"],
    brief: {
      id: "brief-1",
    } as unknown as AcceptanceBriefBindingRead["brief"],
  } as AcceptanceBriefBindingRead;
}

describe("AcceptanceBriefTransitionPanel", () => {
  it("shows the exact empty copy when no Acceptance Records are linked", () => {
    const panel = asElement(AcceptanceBriefTransitionPanel({ workspaceId, bindings: [] }));
    const text = collectText(panel).join(" ");

    expect(text).toContain("This editable Brief is still shaping work and no Acceptance Record is linked.");
    expect(text).not.toContain("confirmed Contract");
    expect(collectHrefs(panel)).toEqual([]);
  });

  it("renders one linked Acceptance Record with an exact href and no confirmation claim", () => {
    const recordId = "record-1";
    const panel = asElement(AcceptanceBriefTransitionPanel({ workspaceId, bindings: [makeBinding(recordId)] }));
    const text = collectText(panel).join(" ");

    expect(text).toContain("This Brief transitioned into Acceptance Records.");
    expect(text).toContain("The transition captured immutable Brief provenance.");
    expect(text).toContain(
      "The Brief stays editable, but later edits cannot rewrite any linked Acceptance Record's Contract, Context Pack, review evidence, or final decision."
    );
    expect(text).not.toContain("confirmed Contract");
    expect(collectHrefs(panel)).toEqual([`/dashboard/${workspaceId}/changes/${recordId}`]);
  });

  it("renders two linked Acceptance Records as an ordered list with exact hrefs", () => {
    const panel = asElement(
      AcceptanceBriefTransitionPanel({
        workspaceId,
        bindings: [makeBinding("record-1"), makeBinding("record-2")],
      })
    );
    const text = collectText(panel).join(" ");
    const hrefs = collectHrefs(panel);

    expect(text).toContain("Acceptance Record");
    expect(text).not.toContain("confirmed Contract");
    expect(hrefs).toEqual([
      `/dashboard/${workspaceId}/changes/record-1`,
      `/dashboard/${workspaceId}/changes/record-2`,
    ]);
    expect(hrefs).toHaveLength(2);
  });
});
