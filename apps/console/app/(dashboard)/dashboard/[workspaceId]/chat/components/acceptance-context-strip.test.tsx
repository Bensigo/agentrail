import { describe, expect, it } from "vitest";
import { AcceptanceContextStrip } from "./acceptance-context-strip";

const workspaceId = "workspace-1";

function flatten(value: unknown): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (typeof value === "object" && "props" in value) {
    const element = value as { props?: { children?: unknown } };
    return flatten(element.props?.children);
  }
  return "";
}

function links(value: unknown): Array<{ href?: string; children?: unknown }> {
  if (value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(links);
  const element = value as { type?: unknown; props?: { href?: string; children?: unknown } };
  const found = typeof element.props?.href === "string" ? [{ href: element.props.href, children: element.props.children }] : [];
  return [...found, ...links(element.props?.children)];
}

describe("AcceptanceContextStrip", () => {
  it("renders nothing before the canonical intake exists", () => {
    expect(AcceptanceContextStrip({ workspaceId, acceptance: null })).toBeNull();
  });

  it("renders the shaping state without claiming a record", () => {
    const rendered = AcceptanceContextStrip({
      workspaceId,
      acceptance: { intake_id: "intake-1", status: "draft" },
    });
    const text = flatten(rendered);
    expect(text).toContain("This task is still shaping.");
    expect(text).toContain("No Acceptance Record exists yet.");
    expect(text).not.toContain("Open and edit Brief");
  });

  it("renders the record-without-Brief state", () => {
    const rendered = AcceptanceContextStrip({
      workspaceId,
      acceptance: { intake_id: "intake-1", status: "draft", record_id: "record-1" },
    });
    expect(flatten(rendered)).toContain("No Brief is linked to this Acceptance Record yet.");
  });

  it("renders only the canonical Brief and Acceptance Record links when bound", () => {
    const rendered = AcceptanceContextStrip({
      workspaceId,
      acceptance: {
        intake_id: "intake-1",
        status: "recorded",
        record_id: "record-1",
        brief: {
          slug: "checkout flow",
          title: "Checkout flow",
          status: "active",
          updated_at: "2026-08-06T10:00:00.000Z",
        },
      },
    });
    expect(flatten(rendered)).toContain("Open and edit Brief");
    expect(flatten(rendered)).toContain("Open Acceptance Record");
    expect(links(rendered)).toEqual([
      { href: "/dashboard/workspace-1/briefs/checkout%20flow", children: "Open and edit Brief" },
      { href: "/dashboard/workspace-1/changes/record-1", children: "Open Acceptance Record" },
    ]);
    expect(flatten(rendered)).not.toContain("contract confirmed");
    expect(flatten(rendered)).not.toContain("evidence");
  });
});
