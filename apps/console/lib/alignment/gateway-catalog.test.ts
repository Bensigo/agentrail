import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getModelFromCatalog,
  isKnownModelSlug,
  _awaitCatalogLoadForTests,
  _resetCatalogForTests,
} from "./gateway-catalog";
import { MODEL_CATALOG } from "./catalog";
import type { RawOpenRouterModel } from "./openrouter-normalize";

// A slug that will never legitimately exist — used everywhere below as the
// "deliberately-bad slug" case (AC3's "an invalid/retired slug fails loud").
const DEFINITELY_FAKE_SLUG = "not-a-real-provider/definitely-fake-model-9999";

// Small, literal fixtures shaped like real `GET /api/v1/models` entries (see
// openrouter-normalize.test.ts for the pinned real-response field mapping
// this reuses) — covers every slug MODEL_CATALOG and the hosted-runner
// config actually ship today, so tests below get real "gateway" resolution
// without any live network call.
const SONNET_5: RawOpenRouterModel = {
  id: "anthropic/claude-sonnet-5",
  pricing: { prompt: "0.000003", completion: "0.000015" },
  context_length: 1000000,
  top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
};
const OPUS_4_8: RawOpenRouterModel = {
  id: "anthropic/claude-opus-4.8",
  pricing: { prompt: "0.000005", completion: "0.000025" },
  context_length: 1000000,
  top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
};
const HAIKU_4_5: RawOpenRouterModel = {
  id: "anthropic/claude-haiku-4.5",
  pricing: { prompt: "0.000001", completion: "0.000005" },
  context_length: 200000,
  top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: true },
};
const GLM_5_2: RawOpenRouterModel = {
  id: "z-ai/glm-5.2",
  pricing: { prompt: "0.0000003", completion: "0.00000094" },
  context_length: 1048576,
  top_provider: { context_length: 1048576, max_completion_tokens: 131072, is_moderated: false },
};

const FULL_FIXTURE = [SONNET_5, OPUS_4_8, HAIKU_4_5, GLM_5_2];

/** A real Node `Response` (not a hand-rolled stub) wrapping a fake `/api/v1/models` body. */
function fakeModelsResponse(models: RawOpenRouterModel[], status = 200): Response {
  return new Response(JSON.stringify({ data: models }), { status });
}

beforeEach(() => {
  _resetCatalogForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getModelFromCatalog: known slugs resolve from the live-fetched (mocked) catalog", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(FULL_FIXTURE))));
    await _awaitCatalogLoadForTests();
  });

  for (const raw of FULL_FIXTURE) {
    it(`${raw.id}: lookup matches the fetched entry's normalized fields`, () => {
      const result = getModelFromCatalog(raw.id as string);
      expect(result).not.toBeNull();
      expect(result?.slug).toBe(raw.id);
      // pricing.prompt/completion are USD-per-TOKEN strings; *1e6 -> USD/MTok.
      const pricing = raw.pricing as { prompt: string; completion: string };
      expect(result?.inUsdPerMTok).toBeCloseTo(Number(pricing.prompt) * 1_000_000, 9);
      expect(result?.outUsdPerMTok).toBeCloseTo(Number(pricing.completion) * 1_000_000, 9);
      expect(result?.contextLength).toBe(raw.context_length);
    });
  }

  it("every rate is strictly non-negative (a real price or a real free-tier 0, never negative/garbage)", () => {
    for (const raw of FULL_FIXTURE) {
      const result = getModelFromCatalog(raw.id as string);
      expect(result!.inUsdPerMTok).toBeGreaterThanOrEqual(0);
      expect(result!.outUsdPerMTok).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("getModelFromCatalog / isKnownModelSlug: unknown slug fails loud, never a silent $0", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(FULL_FIXTURE))));
    await _awaitCatalogLoadForTests();
  });

  it("getModelFromCatalog returns null (not a fabricated $0 entry) for a fake slug", () => {
    expect(getModelFromCatalog(DEFINITELY_FAKE_SLUG)).toBeNull();
  });

  it("isKnownModelSlug returns false for the same fake slug", () => {
    expect(isKnownModelSlug(DEFINITELY_FAKE_SLUG)).toBe(false);
  });

  it("isKnownModelSlug returns true for every slug the fetched catalog actually carries", () => {
    for (const raw of FULL_FIXTURE) {
      expect(isKnownModelSlug(raw.id as string)).toBe(true);
    }
  });

  it("an empty string and a slug with only a provider prefix are both unknown", () => {
    expect(isKnownModelSlug("")).toBe(false);
    expect(isKnownModelSlug("anthropic/")).toBe(false);
    expect(isKnownModelSlug("anthropic")).toBe(false);
  });
});

describe("fire-and-forget load timing: a lookup before the fetch settles sees an empty catalog, not a crash", () => {
  it("getModelFromCatalog returns null synchronously, before the (unawaited) fetch has resolved", () => {
    let resolveFetch: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));

    // No `await` here on purpose — this call happens BEFORE the stubbed
    // fetch promise ever resolves, simulating the real "first request right
    // after a cold start" window described in gateway-catalog.ts's module doc.
    expect(getModelFromCatalog("anthropic/claude-sonnet-5")).toBeNull();
    expect(isKnownModelSlug("anthropic/claude-sonnet-5")).toBe(false);

    // Clean up the dangling promise so it doesn't leak into the next test.
    resolveFetch(fakeModelsResponse(FULL_FIXTURE));
  });
});

describe("AC2 equivalent: fetch failure degrades to an empty catalog, never throws", () => {
  it("network error: getModelFromCatalog/isKnownModelSlug return null/false, no throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network is down — simulated for this test")))
    );

    await expect(_awaitCatalogLoadForTests()).resolves.toBeUndefined();
    expect(() => getModelFromCatalog("anthropic/claude-sonnet-5")).not.toThrow();
    expect(getModelFromCatalog("anthropic/claude-sonnet-5")).toBeNull();
    expect(isKnownModelSlug("anthropic/claude-sonnet-5")).toBe(false);
  });

  it("non-2xx response: same graceful degradation, no throw", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(FULL_FIXTURE, 503))));

    await expect(_awaitCatalogLoadForTests()).resolves.toBeUndefined();
    expect(getModelFromCatalog("anthropic/claude-sonnet-5")).toBeNull();
  });

  it("malformed JSON body: same graceful degradation, no throw", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not json", { status: 200 }))));

    await expect(_awaitCatalogLoadForTests()).resolves.toBeUndefined();
    expect(getModelFromCatalog("anthropic/claude-sonnet-5")).toBeNull();
  });
});

describe("AC3 (simplified): warns, non-fatally, once the catalog loads missing a shipped MODEL_CATALOG seat", () => {
  it("logs one console.warn naming the missing seat when the fetched catalog omits it, and does not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fixture deliberately omits OPUS_4_8 — MODEL_CATALOG's "refactor" seat.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse([SONNET_5, HAIKU_4_5, GLM_5_2]))));

    await expect(_awaitCatalogLoadForTests()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain("refactor");
    expect(message).toContain(MODEL_CATALOG.refactor.slug);
    warnSpy.mockRestore();
  });

  it("does NOT warn when the fetched catalog carries every MODEL_CATALOG seat", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(FULL_FIXTURE))));

    await expect(_awaitCatalogLoadForTests()).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
