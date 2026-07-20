import { describe, it, expect } from "vitest";
import { resolveModelPrice } from "./resolve-price";
import { getModelFromCatalog } from "./gateway-catalog";
import { MODEL_CATALOG } from "./catalog";
import type { ModelSeat } from "./catalog";

describe("resolveModelPrice: real shipped seats resolve via the gateway snapshot", () => {
  for (const [taskType, seat] of Object.entries(MODEL_CATALOG)) {
    it(`${taskType} (${seat.slug}): priceSource is "gateway", numbers match the snapshot verbatim`, () => {
      const gatewayEntry = getModelFromCatalog(seat.slug);
      expect(gatewayEntry, `fixture assumption broken: ${seat.slug} missing from the committed snapshot`).not.toBeNull();

      const resolved = resolveModelPrice(seat);
      expect(resolved.priceSource).toBe("gateway");
      expect(resolved.inUsdPerMTok).toBe(gatewayEntry!.inUsdPerMTok);
      expect(resolved.outUsdPerMTok).toBe(gatewayEntry!.outUsdPerMTok);
    });
  }
});

describe("resolveModelPrice: falls back to the seat's own PRICE_TABLE-mirrored constants when the gateway doesn't know the slug", () => {
  // A synthetic seat with a slug guaranteed absent from the snapshot — proves
  // the fallback branch itself, with literal expected numbers (these are the
  // TEST's own fixture constants, not read from any live/refreshable data,
  // so pinning them exactly is not brittle against a future catalog:refresh).
  const fakeSeat: ModelSeat = {
    slug: "not-a-real-provider/definitely-fake-model-9999",
    displayName: "Fake Model For Tests",
    inUsdPerMTok: 7.25,
    outUsdPerMTok: 42.5,
  };

  it("returns the seat's own constants with priceSource: price_table", () => {
    expect(getModelFromCatalog(fakeSeat.slug)).toBeNull(); // sanity: really is unknown to the gateway

    const resolved = resolveModelPrice(fakeSeat);
    expect(resolved).toEqual({
      inUsdPerMTok: 7.25,
      outUsdPerMTok: 42.5,
      priceSource: "price_table",
    });
  });
});

describe("resolveModelPrice: never returns a $0 rate for a real seat", () => {
  it("every MODEL_CATALOG seat resolves to strictly positive rates", () => {
    for (const seat of Object.values(MODEL_CATALOG)) {
      const resolved = resolveModelPrice(seat);
      expect(resolved.inUsdPerMTok).toBeGreaterThan(0);
      expect(resolved.outUsdPerMTok).toBeGreaterThan(0);
    }
  });
});
