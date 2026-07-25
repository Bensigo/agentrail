import { describe, expect, it } from "vitest";
import { HealthDot, IndexHealthLine } from "./wiki-repo-header";
import type { RepoListItem } from "../wiki-format";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness (no @testing-library/react, no jsdom) anywhere in the
// project (same constraint documented in
// `dashboard/[workspaceId]/page.test.ts` and `empty-state.test.ts`).
// `WikiRepoHeader` itself uses hooks (the repo picker's open/close state), so
// it can't be called directly the way a hook-free component can. `HealthDot`
// and `IndexHealthLine` have no hooks of their own though, so — same
// technique as `EmptyState` — it's safe to call them directly and walk the
// returned plain React-element tree via `.type`/`.props`. This is what
// covers the actual "never red for unknown" / "always has the tooltip"
// contract in a fast test, with the full stateful header verified in the
// browser instead (CI skips console UI tests).

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

function repo(overrides: Partial<RepoListItem> = {}): RepoListItem {
  return {
    id: "repo-1",
    name: "bensigo/agentrail",
    healthStatus: "healthy",
    lastIndexedAt: "2026-07-24T10:00:00.000Z",
    lastCommitSha: "129103aabbccdd",
    sourceCount: 1204,
    ...overrides,
  };
}

describe("HealthDot (#owner-report: unknown telemetry is not a critical repo)", () => {
  it("unknown renders a neutral grey dot, never red/yellow", () => {
    const el = asElement(HealthDot({ status: "unknown" }));
    expect(el.props.className).toContain("gray-09");
    expect(el.props.className).not.toContain("red");
    expect(el.props.className).not.toContain("yellow");
  });

  it("a REAL critical status still renders red — the fix doesn't soften genuine staleness", () => {
    const el = asElement(HealthDot({ status: "critical" }));
    expect(el.props.className).toContain("red");
  });

  it("healthy renders green, stale renders yellow (unchanged)", () => {
    expect(asElement(HealthDot({ status: "healthy" })).props.className).toContain("green");
    expect(asElement(HealthDot({ status: "stale" })).props.className).toContain("yellow");
  });
});

describe("IndexHealthLine", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z").getTime();

  it("unknown health carries the 'telemetry unavailable' tooltip and a neutral dot", () => {
    const r = repo({
      healthStatus: "unknown",
      lastIndexedAt: null,
      lastCommitSha: null,
      sourceCount: null,
    });
    const el = asElement(IndexHealthLine({ repo: r, now: NOW }));

    expect(el.props.title).toBe("Index telemetry unavailable");

    const [dotEl, labelEl] = el.props.children as [ReactElementLike, ReactElementLike];
    expect(dotEl.type).toBe(HealthDot);
    expect(dotEl.props.status).toBe("unknown");

    const text = (labelEl.props.children as unknown[]).join("");
    expect(text).toBe("Index Unknown · last indexed —");
    expect(text).not.toContain("never");
    expect(text).not.toContain("critical");
    expect(text).not.toContain("Critical");
  });

  it("a real health status carries no tooltip at all", () => {
    const r = repo({ healthStatus: "healthy" });
    const el = asElement(IndexHealthLine({ repo: r, now: NOW }));
    expect(el.props.title).toBeUndefined();
  });

  it("a genuinely old/critical repo still reads 'Critical' in the label — only the NO-TELEMETRY case is softened", () => {
    const r = repo({ healthStatus: "critical", lastIndexedAt: "2026-07-20T00:00:00.000Z" });
    const el = asElement(IndexHealthLine({ repo: r, now: NOW }));
    expect(el.props.title).toBeUndefined();

    const [dotEl, labelEl] = el.props.children as [ReactElementLike, ReactElementLike];
    expect(dotEl.props.status).toBe("critical");
    const text = (labelEl.props.children as unknown[]).join("");
    expect(text).toContain("Critical");
  });

  it("the label is prefixed with 'Index' so the line reads as a clearly-labeled secondary detail", () => {
    const el = asElement(IndexHealthLine({ repo: repo(), now: NOW }));
    const [, labelEl] = el.props.children as [ReactElementLike, ReactElementLike];
    const text = (labelEl.props.children as unknown[]).join("");
    expect(text.startsWith("Index ")).toBe(true);
  });
});
