import { describe, expect, it } from "vitest";
import {
  ENGINE_ROOM_ZONE,
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

  it("Your engineer zone: Home (root href) then Work (href renamed from queue, #1231)", () => {
    expect(YOUR_ENGINEER_ZONE.items.map((i) => [i.label, i.href])).toEqual([
      ["Home", ""],
      ["Work", "work"],
    ]);
  });

  it("Engine room zone contains exactly the demoted evidence pages, hrefs unchanged", () => {
    expect(ENGINE_ROOM_ZONE.items.map((i) => i.href)).toEqual([
      "runs",
      "review-gates",
      "costs",
      "memory",
      "failures",
    ]);
  });

  it("Settings zone: Connectors, Repos & Health, Team, API Keys", () => {
    expect(SETTINGS_ZONE.items.map((i) => [i.label, i.href])).toEqual([
      ["Connectors", "connectors"],
      ["Repos & Health", "repos"],
      ["Team", "members"],
      ["API Keys", "api-keys"],
    ]);
  });

  it("every pre-existing href except queue (renamed to work, #1231) is still present exactly once", () => {
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
      "repos",
      "memory",
      "api-keys",
      "members",
    ];
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    for (const href of legacyHrefs) {
      expect(allHrefs.filter((h) => h === href)).toHaveLength(1);
    }
  });

  it("queue is gone from the nav; work is present exactly once (#1231 rename)", () => {
    const allHrefs = NAV_ZONES.flatMap((z) => z.items.map((i) => i.href));
    expect(allHrefs).not.toContain("queue");
    expect(allHrefs.filter((h) => h === "work")).toHaveLength(1);
  });

  it("adds no new hrefs beyond the legacy set plus work (teams stays a redirect stub to /members)", () => {
    const legacyHrefs = new Set([
      "",
      "runs",
      "work", // #1231: renamed from "queue"
      "connectors",
      "failures",
      "review-gates",
      "costs",
      "repos",
      "memory",
      "api-keys",
      "members",
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
