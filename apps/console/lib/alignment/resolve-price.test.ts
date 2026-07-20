import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveModelPrice } from "./resolve-price";
import { getModelFromCatalog, _awaitCatalogLoadForTests, _resetCatalogForTests } from "./gateway-catalog";
import { MODEL_CATALOG } from "./catalog";
import type { ModelSeat } from "./catalog";
import type { RawOpenRouterModel } from "./openrouter-normalize";

// Live catalog access is now a fetch-once-and-cache (see gateway-catalog.ts's
// module doc), not a committed file — every test below that needs a
// deterministic "gateway" resolution mocks the fetch with a fixture covering
// today's real MODEL_CATALOG slugs, then awaits the load before asserting.
const KNOWN_SEATS_FIXTURE: RawOpenRouterModel[] = Object.values(MODEL_CATALOG).map((seat) => ({
  id: seat.slug,
  pricing: { prompt: String(seat.inUsdPerMTok / 1_000_000), completion: String(seat.outUsdPerMTok / 1_000_000) },
  context_length: 1000000,
  top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
}));

function fakeModelsResponse(models: RawOpenRouterModel[]): Response {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

beforeEach(() => {
  _resetCatalogForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveModelPrice: real shipped seats resolve via the live gateway catalog", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(KNOWN_SEATS_FIXTURE))));
    await _awaitCatalogLoadForTests();
  });

  for (const [taskType, seat] of Object.entries(MODEL_CATALOG)) {
    it(`${taskType} (${seat.slug}): priceSource is "gateway", numbers match the fetched entry verbatim`, () => {
      const gatewayEntry = getModelFromCatalog(seat.slug);
      expect(gatewayEntry, `fixture assumption broken: ${seat.slug} missing from KNOWN_SEATS_FIXTURE`).not.toBeNull();

      const resolved = resolveModelPrice(seat);
      expect(resolved.priceSource).toBe("gateway");
      expect(resolved.inUsdPerMTok).toBe(gatewayEntry!.inUsdPerMTok);
      expect(resolved.outUsdPerMTok).toBe(gatewayEntry!.outUsdPerMTok);
    });
  }
});

describe("resolveModelPrice: fetch failure falls back to PRICE_TABLE, never throws (AC2 equivalent)", () => {
  it("network error while loading the catalog: every seat still resolves, via price_table, with no exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network is down — simulated for this test")))
    );
    await _awaitCatalogLoadForTests();

    for (const seat of Object.values(MODEL_CATALOG)) {
      expect(getModelFromCatalog(seat.slug)).toBeNull(); // sanity: the catalog really is empty
      let resolved: ReturnType<typeof resolveModelPrice> | undefined;
      expect(() => {
        resolved = resolveModelPrice(seat);
      }).not.toThrow();
      expect(resolved!.priceSource).toBe("price_table");
      expect(resolved!.inUsdPerMTok).toBe(seat.inUsdPerMTok);
      expect(resolved!.outUsdPerMTok).toBe(seat.outUsdPerMTok);
    }
  });
});

describe("resolveModelPrice: falls back to the seat's own PRICE_TABLE-mirrored constants when the gateway doesn't know the slug", () => {
  // A synthetic seat with a slug guaranteed absent from the catalog — proves
  // the fallback branch itself, with literal expected numbers (these are the
  // TEST's own fixture constants, not read from any live/refreshable data,
  // so pinning them exactly is not brittle against a future catalog fetch).
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
