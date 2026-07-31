import { describe, expect, it } from "vitest";

// This repo's vitest environment is "node" — no DOM/render harness
// (@testing-library/react, jsdom). `digest-panel.tsx` is a "use client"
// component, but the "use client" directive is a Next.js/RSC-boundary
// marker only — it has no effect under Vite/Vitest, so importing the
// module directly is safe. `DigestPanel` itself calls hooks
// (useState/useEffect/useCallback/useMemo) at its own top level, so it
// CANNOT be called directly here (no React dispatcher outside a real
// render pass — same reason `cost-meter-panel.test.ts` and
// `agent-breakdown.test.ts` never render their hook-driven components,
// only their pure `-helpers.ts` siblings).
//
// `PlanCardBlock` is different: it has no hooks of its own (props in,
// JSX out, exactly like `NeedsYouBlock`/`CostBlock`), so calling it
// directly and walking the returned plain React-element tree via
// `.type`/`.props` is safe and is this repo's only real render-assertion
// technique (same idiom as `dashboard/[workspaceId]/page.test.ts` calling
// `WorkspaceDashboardPage` directly). None of its JSX descendants
// (`DigestCard`, `Link`, `ArrowUpRight`) are ever actually invoked by this
// style of test — `.props.children` on an element is just the literal
// child value the authoring JSX passed in, readable without rendering.
//
// `PlanCardBlock` is exported (the brief describes it as "internal to
// digest-panel.tsx", i.e. not consumed by other feature areas) solely to
// make this direct-call test possible — the plan's own copy/CTA pins
// (Global Constraints in
// `docs/superpowers/plans/2026-07-31-subscription-console-slice6.md`)
// require asserting actual rendered strings and the CTA href, not just the
// pure helpers that feed them.

import { PlanCardBlock } from "./digest-panel";
import type { PlanCardData } from "./digest-panel-helpers";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

/** Recursively flattens every string/number leaf under a React-element-like
 *  tree's `children`, without ever invoking a component function — used for
 *  the "no dollar sign / no 'Cost this week' anywhere in the output" sweep,
 *  which by its nature must look at the whole subtree, not one field. */
function collectText(node: unknown, acc: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return acc;
  }
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
    return acc;
  }
  const el = node as Partial<ReactElementLike>;
  if (el && typeof el === "object" && "props" in el) {
    collectText(el.props?.children, acc);
  }
  return acc;
}

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function planCardData(overrides: Partial<PlanCardData> = {}): PlanCardData {
  return {
    planLabel: "Growth",
    seatsUsed: 3,
    seatLimit: 10,
    capacityUsed: 42,
    capacityTotal: 200,
    renewalText: "Renews Aug 30, 2026",
    shippedAllTime: 128,
    ...overrides,
  };
}

describe("PlanCardBlock (subscription slice 6 — digest plan card)", () => {
  it("uses the DigestCard shell with the pinned 'Plan' title", () => {
    const el = asElement(
      PlanCardBlock({ data: planCardData(), workspaceId: WORKSPACE_ID })
    );
    expect(el.props.title).toBe("Plan");
  });

  it("renders the plan label as the headline, styled like CostBlock's number", () => {
    const el = asElement(
      PlanCardBlock({ data: planCardData({ planLabel: "Growth" }), workspaceId: WORKSPACE_ID })
    );
    const body = asElement(el.props.children);
    const [headline] = body.props.children as ReactElementLike[];

    expect(headline.props.children).toBe("Growth");
    expect(headline.props.className).toBe(
      "font-mono text-3xl font-bold text-[var(--gray-12)]"
    );
  });

  it("renders the Seats / Capacity / renewal rows with the pinned copy", () => {
    const el = asElement(
      PlanCardBlock({
        data: planCardData({
          seatsUsed: 3,
          seatLimit: 10,
          capacityUsed: 42,
          capacityTotal: 200,
          renewalText: "Renews Aug 30, 2026",
        }),
        workspaceId: WORKSPACE_ID,
      })
    );
    const body = asElement(el.props.children);
    const [, seatsRow, capacityRow, renewalRow] = body.props.children as ReactElementLike[];

    expect(seatsRow.props.children).toBe("Seats · 3 of 10");
    expect(capacityRow.props.children).toBe("Capacity · 42 of 200 tasks this month");
    expect(renewalRow.props.children).toBe("Renews Aug 30, 2026");
    expect(seatsRow.props.className).toBe("text-xs text-[var(--gray-09)]");
    expect(capacityRow.props.className).toBe("text-xs text-[var(--gray-09)]");
    expect(renewalRow.props.className).toBe("text-xs text-[var(--gray-09)]");
  });

  it("renders an Upgrade plan CTA linking to this workspace's billing page", () => {
    const el = asElement(
      PlanCardBlock({ data: planCardData(), workspaceId: WORKSPACE_ID })
    );
    const body = asElement(el.props.children);
    const rows = body.props.children as ReactElementLike[];
    const cta = rows[rows.length - 1];

    expect(cta.props.href).toBe(`/dashboard/${WORKSPACE_ID}/billing`);
    expect(cta.props.className).toBe(
      "mt-1 flex items-center gap-0.5 text-xs text-[var(--blue-11)]"
    );
    // CTA text and the ArrowUpRight icon are sibling JSX children (same
    // text-node-plus-icon pattern as NeedsYouBlock's own CTA), so the
    // text leaf carries a trailing space before the icon — join (the icon
    // itself contributes no text leaf) and compare the exact string,
    // trailing space included, rather than a loose substring match.
    expect(collectText(cta).join("")).toBe("Upgrade plan ");
  });

  it("never mentions a dollar sign anywhere in its output", () => {
    const el = PlanCardBlock({ data: planCardData(), workspaceId: WORKSPACE_ID });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("$");
  });

  it("never renders the retired 'Cost this week' title", () => {
    const el = asElement(
      PlanCardBlock({ data: planCardData(), workspaceId: WORKSPACE_ID })
    );
    expect(el.props.title).not.toBe("Cost this week");
    expect(collectText(el).join(" ")).not.toContain("Cost this week");
  });

  it("never mentions the word 'budget'", () => {
    const el = PlanCardBlock({ data: planCardData(), workspaceId: WORKSPACE_ID });
    const text = collectText(el).join(" ").toLowerCase();
    expect(text).not.toContain("budget");
  });
});
