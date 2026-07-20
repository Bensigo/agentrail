/**
 * AC3 (#1337), SIMPLIFIED per owner direction (2026-07-20): "an invalid slug
 * in any shipped config is checkable against the catalog."
 *
 * #1337 originally made this a hard CI gate: every shipped slug had to
 * resolve in the COMMITTED snapshot file or CI failed. That machinery (the
 * snapshot file + refresh script + parity test) is gone — the catalog is now
 * a live fetch, cached once per process (see `gateway-catalog.ts`'s module
 * doc). The real safety net stays `getModelFromCatalog`'s null-on-unknown +
 * `resolveModelPrice`'s PRICE_TABLE fallback (never a silent $0); production
 * additionally logs a non-fatal `console.warn` once the catalog first loads
 * if a `MODEL_CATALOG` seat is missing (see `gateway-catalog.ts`'s
 * `warnUnknownSeatSlugs`, exercised in `gateway-catalog.test.ts`).
 *
 * This file keeps the coupling to the actual shipped hosted-runner config
 * (parses the real file, same as before) but resolves slugs against a
 * MOCKED catalog response instead of a committed file or live network — see
 * `KNOWN_SLUGS_FIXTURE` below. If either shipped config ever adds a
 * genuinely new real slug, this fixture needs a matching update (the same
 * pinned-fixture trade-off `openrouter-normalize.test.ts` already documents).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isKnownModelSlug, _awaitCatalogLoadForTests, _resetCatalogForTests } from "./gateway-catalog";
import { MODEL_CATALOG } from "./catalog";
import { MODEL_SEATS } from "./candidates";
import type { RawOpenRouterModel } from "./openrouter-normalize";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// apps/console/lib/alignment -> repo root -> deploy/runner/agentrail-config.hosted.json
const HOSTED_CONFIG_PATH = resolve(__dirname, "../../../../deploy/runner/agentrail-config.hosted.json");

// A slug that will never legitimately exist — the "deliberately-bad slug"
// case (AC3's "an invalid/retired slug is caught, not silently priced").
const DEFINITELY_FAKE_SLUG = "not-a-real-provider/definitely-fake-model-9999";

interface HostedRunnerConfig {
  runners: {
    claude: {
      models: Record<string, string>;
    };
  };
}

function loadHostedConfig(): HostedRunnerConfig {
  return JSON.parse(readFileSync(HOSTED_CONFIG_PATH, "utf8")) as HostedRunnerConfig;
}

// Every slug BOTH shipped configs use today: deploy/runner/agentrail-config.hosted.json's
// execute/verify/critic seats (sonnet-5/glm-5.2/haiku-4.5) plus catalog.ts's
// MODEL_CATALOG "refactor" seat (opus-4.8, not otherwise covered above), PLUS
// (#1338 PR③) every slug candidates.ts's widened execute-candidate pool adds:
// moonshotai/kimi-k2.7-code, moonshotai/kimi-k3, z-ai/glm-4.7,
// deepseek/deepseek-v4-pro, qwen/qwen3-coder-plus, openai/gpt-5.1-codex.
const KNOWN_SLUGS_FIXTURE: RawOpenRouterModel[] = [
  {
    id: "anthropic/claude-sonnet-5",
    pricing: { prompt: "0.000003", completion: "0.000015" },
    context_length: 1000000,
    top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
  },
  {
    id: "anthropic/claude-opus-4.8",
    pricing: { prompt: "0.000005", completion: "0.000025" },
    context_length: 1000000,
    top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    pricing: { prompt: "0.000001", completion: "0.000005" },
    context_length: 200000,
    top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: true },
  },
  {
    id: "z-ai/glm-5.2",
    pricing: { prompt: "0.0000003", completion: "0.00000094" },
    context_length: 1048576,
    top_provider: { context_length: 1048576, max_completion_tokens: 131072, is_moderated: false },
  },
  // #1338 PR③ widened execute-candidate pool (candidates.ts) — plausible
  // OpenRouter-shaped fixtures; this AC3 check only asserts the SLUG is known
  // to the (mocked) live catalog, not that the price matches
  // candidates.ts's own MODEL_SEATS constants (see candidates.test.ts for the
  // pool's own pricing/structure guard, and that file's module doc for why
  // pricing isn't cross-checked against a Python source here).
  {
    id: "moonshotai/kimi-k2.7-code",
    pricing: { prompt: "0.00000085", completion: "0.0000038" },
    context_length: 262144,
    top_provider: { context_length: 262144, max_completion_tokens: 65536, is_moderated: false },
  },
  {
    id: "moonshotai/kimi-k3",
    pricing: { prompt: "0.000003", completion: "0.000015" },
    context_length: 262144,
    top_provider: { context_length: 262144, max_completion_tokens: 65536, is_moderated: false },
  },
  {
    id: "z-ai/glm-4.7",
    pricing: { prompt: "0.0000004", completion: "0.00000175" },
    context_length: 1048576,
    top_provider: { context_length: 1048576, max_completion_tokens: 131072, is_moderated: false },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    pricing: { prompt: "0.00000043", completion: "0.00000087" },
    context_length: 128000,
    top_provider: { context_length: 128000, max_completion_tokens: 32000, is_moderated: false },
  },
  {
    id: "qwen/qwen3-coder-plus",
    pricing: { prompt: "0.00000065", completion: "0.00000325" },
    context_length: 1000000,
    top_provider: { context_length: 1000000, max_completion_tokens: 65536, is_moderated: false },
  },
  {
    id: "openai/gpt-5.1-codex",
    pricing: { prompt: "0.00000125", completion: "0.00001" },
    context_length: 400000,
    top_provider: { context_length: 400000, max_completion_tokens: 128000, is_moderated: true },
  },
];

function fakeModelsResponse(models: RawOpenRouterModel[]): Response {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

beforeEach(() => {
  _resetCatalogForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AC3: shipped hosted-runner config slugs resolve against the (mocked) catalog", () => {
  const config = loadHostedConfig();
  const seats = config.runners.claude.models;

  it("deploy/runner/agentrail-config.hosted.json carries the expected execute/verify/critic seats", () => {
    // Sanity check on the fixture itself — if this ever fails, the assertion
    // below is iterating over the wrong (or an empty) set of seats.
    expect(Object.keys(seats).sort()).toEqual(["critic", "execute", "verify"]);
  });

  it("every hosted-runner seat slug resolves once the catalog loads", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(KNOWN_SLUGS_FIXTURE))));
    await _awaitCatalogLoadForTests();

    const unresolved = Object.entries(seats).filter(([, slug]) => !isKnownModelSlug(slug));
    expect(
      unresolved,
      `hosted config seat(s) not found in the fetched catalog: ${unresolved
        .map(([seat, slug]) => `${seat}="${slug}"`)
        .join(", ")} — either the slug is wrong/retired on OpenRouter, or this test's ` +
        "KNOWN_SLUGS_FIXTURE needs updating to match a real shipped-config change"
    ).toEqual([]);
  });
});

describe("AC3: shipped alignment-brief catalog (catalog.ts MODEL_CATALOG) slugs resolve against the (mocked) catalog", () => {
  it("every MODEL_CATALOG seat's slug resolves once the catalog loads", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(KNOWN_SLUGS_FIXTURE))));
    await _awaitCatalogLoadForTests();

    const unresolved = Object.entries(MODEL_CATALOG).filter(([, seat]) => !isKnownModelSlug(seat.slug));
    expect(
      unresolved,
      `MODEL_CATALOG seat(s) not found in the fetched catalog: ${unresolved
        .map(([taskType, seat]) => `${taskType}="${seat.slug}"`)
        .join(", ")}`
    ).toEqual([]);
  });
});

describe("AC3: widened execute-candidate pool (candidates.ts MODEL_SEATS, #1338 PR③) slugs resolve against the (mocked) catalog", () => {
  it("every MODEL_SEATS slug resolves once the catalog loads", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(KNOWN_SLUGS_FIXTURE))));
    await _awaitCatalogLoadForTests();

    const unresolved = Object.entries(MODEL_SEATS).filter(([, seat]) => !isKnownModelSlug(seat.slug));
    expect(
      unresolved,
      `candidates.ts MODEL_SEATS entr(y/ies) not found in the fetched catalog: ${unresolved
        .map(([key, seat]) => `${key}="${seat.slug}"`)
        .join(", ")} — either the slug is wrong, or this test's KNOWN_SLUGS_FIXTURE needs updating ` +
        "to match a real candidates.ts pool change."
    ).toEqual([]);
  });
});

describe("AC3 mechanism proof: a deliberately-bad slug is caught by the same check, without throwing", () => {
  it("a synthetic config with one invalid slug is flagged, non-fatally", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeModelsResponse(KNOWN_SLUGS_FIXTURE))));
    await _awaitCatalogLoadForTests();

    const syntheticSeats: Record<string, string> = {
      execute: "anthropic/claude-sonnet-5", // real — should pass
      critic: DEFINITELY_FAKE_SLUG,
    };
    expect(() => {
      const unresolved = Object.entries(syntheticSeats).filter(([, slug]) => !isKnownModelSlug(slug));
      expect(unresolved).toEqual([["critic", DEFINITELY_FAKE_SLUG]]);
    }).not.toThrow();
  });
});
