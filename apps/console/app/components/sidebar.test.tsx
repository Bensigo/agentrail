import { describe, expect, it } from "vitest";

// This repo's vitest environment is "node" — no DOM/render harness
// (@testing-library/react, jsdom). `sidebar.tsx` is a "use client"
// component whose own `Sidebar` function calls `usePathname()` at its top
// level, so — same reason `digest-panel.test.ts` never calls `DigestPanel`
// directly — it CANNOT be invoked directly here (no React dispatcher
// outside a real render pass).
//
// `filterEngineRoomItems` is different: it's plain data in, data out (a
// `NavItem[]` filter — no JSX, no hooks), so it's exported from
// `sidebar.tsx` solely to make it independently testable. Same "extract the
// pure part" move `digest-panel.tsx` makes with `PlanCardBlock` for the
// same reason, except this one doesn't even need that file's
// element-tree-walk technique, because it never touches JSX at all.
//
// NOT covered here, for lack of a render harness (proven by TypeScript +
// browser verification instead, same posture as `digest-panel.test.ts`'s
// documented `data && planCard` gap): the
// `{ ...ENGINE_ROOM_ZONE, items: engineRoomItems }` splice that feeds
// `EngineRoomGroup`.

import { filterEngineRoomItems } from "./sidebar";
import { ENGINE_ROOM_ZONE } from "./sidebar-nav";

describe("filterEngineRoomItems (2026-07-31 owner ruling — Costs/Budget/Wallet leave the customer sidebar unconditionally, the earlier billing-swap flag retired)", () => {
  it("drops exactly costs/budget/wallet, keeps every other item in its original order", () => {
    const result = filterEngineRoomItems(ENGINE_ROOM_ZONE.items);
    expect(result.map((item) => item.href)).toEqual([
      "runs",
      "review-gates",
      "model-selection",
      "memory",
      "briefs",
      "investigations",
      "wiki",
      "failures",
    ]);
  });

  it("none of the surviving items are costs/budget/wallet", () => {
    const result = filterEngineRoomItems(ENGINE_ROOM_ZONE.items);
    const hidden = new Set(["costs", "budget", "wallet"]);
    expect(result.every((item) => !hidden.has(item.href))).toBe(true);
  });

  it("surviving items are the exact same object references as in ENGINE_ROOM_ZONE.items (a filter, not a remap/clone)", () => {
    const result = filterEngineRoomItems(ENGINE_ROOM_ZONE.items);
    for (const item of result) {
      expect(ENGINE_ROOM_ZONE.items).toContain(item);
    }
  });

  it("is a pure function: never mutates the input array", () => {
    const before = [...ENGINE_ROOM_ZONE.items];
    filterEngineRoomItems(ENGINE_ROOM_ZONE.items);
    expect(ENGINE_ROOM_ZONE.items).toEqual(before);
  });
});
