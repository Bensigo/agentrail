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

describe("customer navigation shell", () => {
  it("presents the Trust layer, Evidence & context, and Settings zones", () => {
    expect(NAV_ZONES.map((zone) => zone.label)).toEqual([
      "Trust layer",
      "Evidence & context",
      "Settings",
    ]);
    expect(YOUR_ENGINEER_ZONE.collapsible).toBe(false);
    expect(ENGINE_ROOM_ZONE.collapsible).toBe(true);
    expect(SETTINGS_ZONE.collapsible).toBe(false);
  });

  it("keeps the primary Trust Layer path focused on records and human decisions", () => {
    expect(
      YOUR_ENGINEER_ZONE.items.map((item) => [item.label, item.href])
    ).toEqual([
      ["Home", ""],
      ["Briefs", "briefs"],
      ["Acceptance Records", "changes"],
      ["Approvals", "approvals"],
    ]);
  });

  it("keeps only customer-facing evidence and context stores in the secondary zone", () => {
    expect(
      ENGINE_ROOM_ZONE.items.map((item) => [item.label, item.href])
    ).toEqual([
      ["Memory", "memory"],
      ["Wiki", "wiki"],
      ["Context Packs", "context-packs"],
    ]);
  });

  it("keeps settings routes stable while presenting Gateways as Channels", () => {
    expect(SETTINGS_ZONE.items.map((item) => [item.label, item.href])).toEqual([
      ["Channels", "gateways"],
      ["Connectors", "connectors"],
      ["Team", "members"],
      ["Permissions", "permissions"],
      ["Plan & billing", "billing"],
    ]);
  });

  it("does not expose factory execution, operations, Chat, or Goals in any visible zone", () => {
    const visibleHrefs = NAV_ZONES.flatMap((zone) =>
      zone.items.map((item) => item.href)
    );
    expect(visibleHrefs).not.toEqual(
      expect.arrayContaining([
        "work",
        "runs",
        "review-gates",
        "costs",
        "budget",
        "wallet",
        "model-selection",
        "investigations",
        "failures",
        "chat",
        "goals",
      ])
    );
  });

  it("has no duplicate hrefs across zones", () => {
    const visibleHrefs = NAV_ZONES.flatMap((zone) =>
      zone.items.map((item) => item.href)
    );
    expect(new Set(visibleHrefs).size).toBe(visibleHrefs.length);
  });
});

describe("isNavItemActive", () => {
  it("matches the root item only at the exact workspace root", () => {
    expect(isNavItemActive(BASE, BASE, "")).toBe(true);
    expect(isNavItemActive(`${BASE}/`, BASE, "")).toBe(true);
    expect(isNavItemActive(`${BASE}/runs`, BASE, "")).toBe(false);
  });

  it("matches nested non-root routes", () => {
    expect(isNavItemActive(`${BASE}/changes`, BASE, "changes")).toBe(true);
    expect(isNavItemActive(`${BASE}/changes/record_123`, BASE, "changes")).toBe(
      true
    );
  });
});

describe("Evidence & context expansion", () => {
  it("recognizes visible evidence and context routes, including details", () => {
    for (const item of ENGINE_ROOM_ZONE.items) {
      expect(isEngineRoomRoute(`${BASE}/${item.href}`, BASE)).toBe(true);
      expect(isEngineRoomRoute(`${BASE}/${item.href}/nested-id`, BASE)).toBe(
        true
      );
    }
  });

  it("does not treat hidden factory deep links as part of the visible group", () => {
    expect(isEngineRoomRoute(`${BASE}/runs`, BASE)).toBe(false);
    expect(isEngineRoomRoute(`${BASE}/review-gates`, BASE)).toBe(false);
    expect(isEngineRoomRoute(`${BASE}/work`, BASE)).toBe(false);
  });

  it("opens for visible context routes and otherwise follows persisted state", () => {
    expect(resolveEngineRoomOpen(`${BASE}/memory`, BASE, "false")).toBe(true);
    expect(resolveEngineRoomOpen(BASE, BASE, "true")).toBe(true);
    expect(resolveEngineRoomOpen(BASE, BASE, "false")).toBe(false);
    expect(resolveEngineRoomOpen(BASE, BASE, null)).toBe(false);
  });
});
