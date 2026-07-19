import { describe, expect, it } from "vitest";
import { SEGMENT_LABELS, breadcrumbLabel } from "./breadcrumb-label";
import { NAV_ZONES } from "./sidebar-nav";

const BASE = "/dashboard/1004eefa-81d1-46c6-80f2-1594a84a8135";

describe("breadcrumbLabel", () => {
  it("labels the budget page (#1272 — the fix for the topbar reading 'Home')", () => {
    expect(breadcrumbLabel(`${BASE}/budget`)).toBe("Budget");
  });

  it("labels the permissions page (#1278)", () => {
    expect(breadcrumbLabel(`${BASE}/permissions`)).toBe("Permissions");
  });

  it("labels an existing segment (review-gates)", () => {
    expect(breadcrumbLabel(`${BASE}/review-gates`)).toBe("Review Gates");
  });

  it("keeps the top-level label on nested routes (runs/[runId])", () => {
    expect(breadcrumbLabel(`${BASE}/runs/run_123`)).toBe("Runs");
  });

  it("falls back to 'Home' at the workspace root", () => {
    expect(breadcrumbLabel(BASE)).toBe("Home");
    expect(breadcrumbLabel(`${BASE}/`)).toBe("Home");
  });

  it("falls back to 'Home' for an unknown segment", () => {
    expect(breadcrumbLabel(`${BASE}/does-not-exist`)).toBe("Home");
  });
});

describe("SEGMENT_LABELS stays in sync with the sidebar nav", () => {
  it("has an entry for every non-root nav href, matching the nav label", () => {
    // The module's own header comment promises this sync; this test makes the
    // next nav addition fail loudly here instead of silently reading "Home".
    const navItems = NAV_ZONES.flatMap((z) => z.items).filter((i) => i.href !== "");
    for (const item of navItems) {
      expect(SEGMENT_LABELS[item.href], `missing SEGMENT_LABELS["${item.href}"]`).toBe(
        item.label
      );
    }
  });
});
