/**
 * Global vitest setup for @agentrail/console.
 *
 * `apps/console/lib/alignment/gateway-catalog.ts` fetches the live OpenRouter
 * catalog lazily on first use (see that module's doc comment) — since #1337's
 * committed-snapshot file is gone, ANY test that exercises the alignment
 * estimate chain (`estimateBrief`, `composeAlignmentBrief`,
 * `composeChatBornBrief`, ...), even indirectly, would otherwise make a real
 * network call to openrouter.ai the first time it runs. This default stub
 * makes `fetch` resolve to an EMPTY `/api/v1/models` list for every test that
 * doesn't set up its own — safe (every lookup just falls through to the
 * PRICE_TABLE fallback, never a silent $0 or a thrown exception) and keeps
 * the whole suite network-free.
 *
 * Tests that care about specific catalog contents (gateway-catalog.test.ts,
 * resolve-price.test.ts, estimate.test.ts, slug-validation.test.ts) call
 * `vi.stubGlobal("fetch", ...)` again in their OWN `beforeEach` — vitest runs
 * hooks outermost-first, so a test file's more specific stub registered
 * after this one simply wins for that file.
 */
import { afterEach, beforeEach, vi } from "vitest";

function emptyModelsResponse(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(emptyModelsResponse())));
});

afterEach(() => {
  vi.unstubAllGlobals();
});
