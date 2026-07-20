import { describe, it, expect } from "vitest";
import {
  normalizeOpenRouterModel,
  normalizeOpenRouterModelsResponse,
} from "./openrouter-normalize";
import type { RawOpenRouterModel } from "./openrouter-normalize";

// ---------------------------------------------------------------------------
// Fixtures below are LITERAL COPIES of real entries from
// `GET https://openrouter.ai/api/v1/models`, captured 2026-07-20 (no auth
// required for the list) — trimmed to only the fields `openrouter-normalize.ts`
// reads. This is what "pin the exact fields you depend on" (task brief) means
// in test form: if OpenRouter ever changes this shape, these fixtures (copied
// from a real response, not invented) are the contract that would need
// updating, and the mapping comment in openrouter-normalize.ts's module doc
// is the other half of that contract.
// ---------------------------------------------------------------------------

const SONNET_5: RawOpenRouterModel = {
  id: "anthropic/claude-sonnet-5",
  pricing: {
    prompt: "0.000002",
    completion: "0.00001",
    web_search: "0.01",
    input_cache_read: "0.0000002",
    input_cache_write: "0.0000025",
    input_cache_write_1h: "0.000004",
  },
  context_length: 1000000,
  top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
};

const OPUS_4_8: RawOpenRouterModel = {
  id: "anthropic/claude-opus-4.8",
  pricing: {
    prompt: "0.000005",
    completion: "0.000025",
    web_search: "0.01",
    input_cache_read: "0.0000005",
    input_cache_write: "0.00000625",
    input_cache_write_1h: "0.00001",
  },
  context_length: 1000000,
  top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
};

const HAIKU_4_5: RawOpenRouterModel = {
  id: "anthropic/claude-haiku-4.5",
  pricing: {
    prompt: "0.000001",
    completion: "0.000005",
    web_search: "0.01",
    input_cache_read: "0.0000001",
    input_cache_write: "0.00000125",
    input_cache_write_1h: "0.000002",
  },
  context_length: 200000,
  top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: true },
};

const GLM_5_2: RawOpenRouterModel = {
  id: "z-ai/glm-5.2",
  pricing: { prompt: "0.0000002786", completion: "0.0000008756", input_cache_read: "0.00000005174" },
  context_length: 1048576,
  top_provider: { context_length: 1048576, max_completion_tokens: 131072, is_moderated: false },
};

// Real entry where top_provider.context_length is SMALLER than the model-level
// context_length (the currently-routed provider offers less than the model's
// advertised max) AND max_completion_tokens is null — both real, both must
// round-trip, neither collapses into the other.
const INKLING_DIFFERING_CONTEXT: RawOpenRouterModel = {
  id: "thinkingmachines/inkling",
  pricing: { prompt: "0.000001", completion: "0.00000405", input_cache_read: "0.00000017" },
  context_length: 1048576,
  top_provider: { context_length: 524288, max_completion_tokens: null, is_moderated: false },
};

describe("normalizeOpenRouterModel: pinned field mapping (real captured entries)", () => {
  it("anthropic/claude-sonnet-5: per-token USD strings -> per-MTok numbers", () => {
    const result = normalizeOpenRouterModel(SONNET_5);
    expect(result).toEqual({
      id: "anthropic/claude-sonnet-5",
      inUsdPerMTok: 2.0,
      outUsdPerMTok: 10.0,
      contextLength: 1000000,
      topProvider: { contextLength: 1000000, maxCompletionTokens: 128000, isModerated: true },
    });
  });

  it("anthropic/claude-opus-4.8", () => {
    const result = normalizeOpenRouterModel(OPUS_4_8);
    expect(result).toEqual({
      id: "anthropic/claude-opus-4.8",
      inUsdPerMTok: 5.0,
      outUsdPerMTok: 25.0,
      contextLength: 1000000,
      topProvider: { contextLength: 1000000, maxCompletionTokens: 128000, isModerated: true },
    });
  });

  it("anthropic/claude-haiku-4.5", () => {
    const result = normalizeOpenRouterModel(HAIKU_4_5);
    expect(result).toEqual({
      id: "anthropic/claude-haiku-4.5",
      inUsdPerMTok: 1.0,
      outUsdPerMTok: 5.0,
      contextLength: 200000,
      topProvider: { contextLength: 200000, maxCompletionTokens: 64000, isModerated: true },
    });
  });

  it("z-ai/glm-5.2: sub-cent rates survive the *1e6 conversion without float noise", () => {
    const result = normalizeOpenRouterModel(GLM_5_2);
    expect(result).toEqual({
      id: "z-ai/glm-5.2",
      inUsdPerMTok: 0.2786,
      outUsdPerMTok: 0.8756,
      contextLength: 1048576,
      topProvider: { contextLength: 1048576, maxCompletionTokens: 131072, isModerated: false },
    });
  });

  it("keeps model-level contextLength and topProvider.contextLength distinct when OpenRouter reports different values", () => {
    const result = normalizeOpenRouterModel(INKLING_DIFFERING_CONTEXT);
    expect(result?.contextLength).toBe(1048576);
    expect(result?.topProvider.contextLength).toBe(524288);
  });

  it("preserves a null max_completion_tokens rather than coercing it to 0 or dropping the entry", () => {
    const result = normalizeOpenRouterModel(INKLING_DIFFERING_CONTEXT);
    expect(result).not.toBeNull();
    expect(result?.topProvider.maxCompletionTokens).toBeNull();
  });
});

describe("normalizeOpenRouterModel: rejects structurally missing fields (null, never a silent $0)", () => {
  // `key: undefined` is structurally equivalent to an absent key for every
  // check in openrouter-normalize.ts (all reads go through `typeof x !==
  // "..."` / `Number.isFinite`, neither of which treats `undefined`
  // differently from a missing property) — simpler than destructure-omit
  // without changing what's being tested.
  it("missing id -> null", () => {
    expect(normalizeOpenRouterModel({ ...SONNET_5, id: undefined })).toBeNull();
  });

  it("empty-string id -> null", () => {
    expect(normalizeOpenRouterModel({ ...SONNET_5, id: "" })).toBeNull();
  });

  it("missing pricing object -> null", () => {
    expect(normalizeOpenRouterModel({ ...SONNET_5, pricing: undefined })).toBeNull();
  });

  it("missing pricing.prompt -> null", () => {
    expect(
      normalizeOpenRouterModel({ ...SONNET_5, pricing: { ...SONNET_5.pricing, prompt: undefined } })
    ).toBeNull();
  });

  it("missing pricing.completion -> null", () => {
    expect(
      normalizeOpenRouterModel({ ...SONNET_5, pricing: { ...SONNET_5.pricing, completion: undefined } })
    ).toBeNull();
  });

  it("non-numeric pricing.prompt string -> null (never coerced to 0 or NaN)", () => {
    const result = normalizeOpenRouterModel({
      ...SONNET_5,
      pricing: { ...SONNET_5.pricing, prompt: "call-for-pricing" },
    });
    expect(result).toBeNull();
  });

  it("missing context_length -> null", () => {
    expect(normalizeOpenRouterModel({ ...SONNET_5, context_length: undefined })).toBeNull();
  });

  it("missing top_provider -> null", () => {
    expect(normalizeOpenRouterModel({ ...SONNET_5, top_provider: undefined })).toBeNull();
  });

  it("missing top_provider.context_length -> null", () => {
    const result = normalizeOpenRouterModel({
      ...SONNET_5,
      top_provider: { ...SONNET_5.top_provider, context_length: undefined },
    });
    expect(result).toBeNull();
  });
});

describe("normalizeOpenRouterModel: a genuine $0 price is a value, not a rejection", () => {
  it("real free-tier pricing (\"0\" per token) normalizes to inUsdPerMTok/outUsdPerMTok: 0, not null", () => {
    const freeModel: RawOpenRouterModel = {
      id: "tencent/hy3:free",
      pricing: { prompt: "0", completion: "0" },
      context_length: 32768,
      top_provider: { context_length: 32768, max_completion_tokens: null, is_moderated: false },
    };
    const result = normalizeOpenRouterModel(freeModel);
    expect(result).not.toBeNull();
    expect(result?.inUsdPerMTok).toBe(0);
    expect(result?.outUsdPerMTok).toBe(0);
  });
});

describe("normalizeOpenRouterModelsResponse", () => {
  it("normalizes every valid entry, skips invalid ones, and sorts by id", () => {
    const body = {
      data: [
        HAIKU_4_5,
        { id: "broken/no-pricing", context_length: 1000, top_provider: { context_length: 1000, max_completion_tokens: null, is_moderated: false } },
        SONNET_5,
        OPUS_4_8,
      ],
    };
    const { models, skippedCount } = normalizeOpenRouterModelsResponse(body);
    expect(skippedCount).toBe(1);
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("non-array data -> zero models, zero skipped (never throws)", () => {
    expect(normalizeOpenRouterModelsResponse({ data: undefined })).toEqual({ models: [], skippedCount: 0 });
    expect(normalizeOpenRouterModelsResponse({})).toEqual({ models: [], skippedCount: 0 });
  });

  it("empty data array -> zero models, zero skipped", () => {
    expect(normalizeOpenRouterModelsResponse({ data: [] })).toEqual({ models: [], skippedCount: 0 });
  });
});
