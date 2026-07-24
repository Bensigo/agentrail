import { describe, expect, it } from "vitest";
import {
  CHAT_NAV_ITEM,
  ENGINE_ROOM_ZONE,
  GOALS_NAV_ITEM,
  NAV_ZONES,
  SETTINGS_ZONE,
  YOUR_ENGINEER_ZONE,
  isEngineRoomRoute,
  isNavItemActive,
  resolveEngineRoomOpen,
} from "./sidebar-nav";

const BASE = "/dashboard/ws1";

describe("NAV_ZONES data structure", () => {
  it("has exactly three zones, in order: Your engineer, Engine room, Settings", () => {
    expect(NAV_ZONES.map((z) => z.label)).toEqual([
      "Your engineer",
      "Engine room",
      "Settings",
    ]);
  });

  it("only the Engine room zone is collapsible", () => {
    expect(YOUR_ENGINEER_ZONE.collapsible).toBe(false);
    expect(ENGINE_ROOM_ZONE.collapsible).toBe(true);
    expect(SETTINGS_ZONE.collapsible).toBe(false);
  });

  it("Your engineer zone: Home (root href), Work (href renamed from queue, #1231), then Approvals (#1276)", () => {
    expect(YOUR_ENGINEER_ZONE.items.map((i) => [i.label, i.href])).toEqual([
      ["Home", ""],
      ["Work", "work"],
      ["Approvals", "approvals"],
    ]);
  });

  it("CHAT_NAV_ITEM (#1288) is NOT baked into YOUR_ENGINEER_ZONE.items — sidebar.tsx splices it in only when the flag is on", () => {
    expect(YOUR_ENGINEER_ZONE.items.map((i) => i.href)).not.toContain("chat");
    expect(CHAT_NAV_ITEM.label).toBe("Chat");
    expect(CHAT_NAV_ITEM.href).toBe("chat");
    expect(CHAT_NAV_ITEM.icon).toBeDefined();
  });

  it("GOALS_NAV_ITEM (#1289 AC2) is NOT baked into YOUR_ENGINEER_ZONE.items — sidebar.tsx splices it in only when jaceGoalLoop is on, same posture as CHAT_NAV_ITEM", () => {
    expect(YOUR_ENGINEER_ZONE.items.map((i) => i.href)).not.toContain("goals");
    expect(GOALS_NAV_ITEM.label).toBe("Goals");
    expect(GOALS_NAV_ITEM.href).toBe("goals");
    expect(GOALS_NAV_ITEM.icon).toBeDefined();
  });

  it("Engine room zone contains exactly the demoted evidence pages, plus Budget (#1272), Model selection (#1338 PR③), and Wiki (repo wiki 6/7, sibling of Memory)", () => {
    expect(ENGINE_ROOM_ZONE.items.map((i) => i.href)).toEqual([
      "runs",
      "review-gates",
      "costs",
      "budget",
      "model-selection",
      "memory",
      "wiki",
      "failures",
    ]);
  });

  it("Settings zone: Connectors, Team, Permissions (#1278; api-keys removed 2026-07-19; Repos & Health folded into Wiki, owner ruling)", () => {
    expect(SETTINGS_ZONE.items.map((i) => [i.label, i.href])).toEqual([
      ["Connectors", "connectors"],
      ["Team", "members"],
      ["Permissions", "permissions"],
    ]);
  });

  it("every pre-existing href except queue (renamed to work, #1231), api-keys (removed 2026-07-19), and repos (folded into wiki) is still present exactly once", () => {
    const legacyHrefs = [
      "", // Overview -> Home
      "runs",
      // "queue" intentionally excluded: #1231 renamed its nav item's href to
      // "work" — the /queue route itself still exists, but only as a
      // redirect (see the next test), not a nav destination.
      "connectors",
      "failures",
      "review-gates",
      "costs",
      "memory",
      // "api-keys" intentionally excluded: the in-console key list/create/
      // revoke UI was removed (owner ruling, 2026-07-19) — see the dedicated
      // "api-keys is gone from the nav" test below.
      // "repos" intentionally excluded: Repos & Health folded into Wiki
      // (owner ruling) — see the dedicated "repos is gone from the nav"
      // test below.
      "members",
    ];
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    for (const href of legacyHrefs) {
      expect(allHrefs.filter((h) => h === href)).toHaveLength(1);
    }
  });

  it("budget is present exactly once (#1272: new workspace $ ceiling + per-task/monthly spend page)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs.filter((h) => h === "budget")).toHaveLength(1);
  });

  it("approvals is present exactly once (#1276: pending approvals, parked work, dead letters)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs.filter((h) => h === "approvals")).toHaveLength(1);
  });

  it("permissions is present exactly once, in the Settings zone (#1278: owner-only merge-permission toggle)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs.filter((h) => h === "permissions")).toHaveLength(1);
    expect(SETTINGS_ZONE.items.map((i) => i.href)).toContain("permissions");
  });

  it("queue is gone from the nav; work is present exactly once (#1231 rename)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs).not.toContain("queue");
    expect(allHrefs.filter((h) => h === "work")).toHaveLength(1);
  });

  it("api-keys is gone from the nav (owner ruling, 2026-07-19 — in-console key UI removed; the api_keys table and its /api/v1 routes are untouched)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs).not.toContain("api-keys");
  });

  it("repos is gone from the nav (owner ruling — Repos & Health folded into Wiki; /repos stays a redirect stub to /wiki, same shape as /queue -> /work)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs).not.toContain("repos");
  });

  it("adds no new hrefs beyond the legacy set plus work, budget, approvals, permissions, model-selection, and wiki (teams stays a redirect stub to /members; api-keys removed 2026-07-19; repos folded into wiki)", () => {
    const legacyHrefs = new Set([
      "",
      "runs",
      "work", // #1231: renamed from "queue"
      "connectors",
      "failures",
      "review-gates",
      "costs",
      "budget", // #1272: new workspace $ ceiling + per-task/monthly spend page
      "approvals", // #1276: pending approvals, parked work, dead letters
      "memory",
      "members",
      "permissions", // #1278: owner-only grantable merge-permission toggle
      "model-selection", // #1338 PR③: per-task-type model-outcome observe view
      "wiki", // repo wiki 6/7: read-only Engine-room Wiki view, sibling of Memory
      // "api-keys" intentionally excluded: removed from the nav (owner
      // ruling, 2026-07-19) — see the dedicated test below.
      // "repos" intentionally excluded: folded into wiki (owner ruling) —
      // see the dedicated test below.
    ]);
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    const newHrefs = allHrefs.filter((h) => !legacyHrefs.has(h));
    expect(newHrefs).toEqual([]);
  });

  it("has no duplicate hrefs across zones", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(new Set(allHrefs).size).toBe(allHrefs.length);
  });
});

describe("isNavItemActive", () => {
  it("matches the root item (href \"\") only at the exact workspace root", () => {
    expect(isNavItemActive(BASE, BASE, "")).toBe(true);
    expect(isNavItemActive(`${BASE}/`, BASE, "")).toBe(true);
    expect(isNavItemActive(`${BASE}/runs`, BASE, "")).toBe(false);
  });

  it("matches a non-root item via startsWith, so nested routes stay active", () => {
    expect(isNavItemActive(`${BASE}/runs`, BASE, "runs")).toBe(true);
    expect(isNavItemActive(`${BASE}/runs/run_123`, BASE, "runs")).toBe(true);
    expect(isNavItemActive(`${BASE}/runs-archive`, BASE, "runs")).toBe(true); // documents existing startsWith behavior, unchanged from the flat nav
  });

  it("does not match an unrelated segment", () => {
    expect(isNavItemActive(`${BASE}/costs`, BASE, "runs")).toBe(false);
  });
});

describe("isEngineRoomRoute", () => {
  it("is true for every Engine room href, including nested detail routes", () => {
    for (const item of ENGINE_ROOM_ZONE.items) {
      expect(isEngineRoomRoute(`${BASE}/${item.href}`, BASE)).toBe(true);
      expect(isEngineRoomRoute(`${BASE}/${item.href}/nested-id`, BASE)).toBe(
        true
      );
    }
  });

  it("is false for Your engineer and Settings routes", () => {
    expect(isEngineRoomRoute(BASE, BASE)).toBe(false);
    expect(isEngineRoomRoute(`${BASE}/work`, BASE)).toBe(false);
    // /queue still exists as a redirect (#1231) — its pathname is likewise
    // not an engine-room route.
    expect(isEngineRoomRoute(`${BASE}/queue`, BASE)).toBe(false);
    expect(isEngineRoomRoute(`${BASE}/connectors`, BASE)).toBe(false);
    expect(isEngineRoomRoute(`${BASE}/teams`, BASE)).toBe(false);
  });
});

describe("resolveEngineRoomOpen", () => {
  it("a direct deep link into an engine-room route always opens, regardless of persisted state", () => {
    expect(resolveEngineRoomOpen(`${BASE}/runs`, BASE, "false")).toBe(true);
    expect(resolveEngineRoomOpen(`${BASE}/runs`, BASE, null)).toBe(true);
    expect(resolveEngineRoomOpen(`${BASE}/runs/run_123`, BASE, "false")).toBe(
      true
    );
  });

  it("off an engine-room route, defers to the persisted value", () => {
    expect(resolveEngineRoomOpen(BASE, BASE, "true")).toBe(true);
    expect(resolveEngineRoomOpen(BASE, BASE, "false")).toBe(false);
  });

  it("defaults to collapsed when nothing is persisted yet (e.g. SSR, first visit)", () => {
    expect(resolveEngineRoomOpen(BASE, BASE, null)).toBe(false);
  });
});
