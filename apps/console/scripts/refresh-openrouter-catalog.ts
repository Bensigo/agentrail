/**
 * Refreshes the committed OpenRouter model catalog snapshot
 * (`lib/alignment/openrouter-catalog.snapshot.json`) from the live
 * `GET https://openrouter.ai/api/v1/models` endpoint (#1337).
 *
 * This is the ONLY place in the console that makes this network call. Every
 * runtime lookup (`getModelFromCatalog`, `isKnownModelSlug`,
 * `getSnapshotMeta` in `../lib/alignment/gateway-catalog.ts`) reads the
 * committed snapshot file — never the network, never on any request hot
 * path. `openrouter-normalize.ts` (imported here) does the actual field
 * mapping and is unit-tested against real captured entries in
 * `openrouter-normalize.test.ts`; this script is deliberately thin — fetch,
 * normalize, write.
 *
 * Refresh cadence: MANUAL, v1. Run this before a release, when validating a
 * newly-shipped model slug, or whenever OpenRouter pricing is suspected to
 * have drifted (e.g. `anthropic/claude-sonnet-5`'s introductory pricing
 * lapsing 2026-08-31 — see `catalog.ts`'s module doc). There is no scheduled
 * job wired up yet; adding one (e.g. a periodic CI workflow that runs this
 * script and opens a PR on diff) is future work, not required by #1337 —
 * the snapshot-is-the-served-source-of-truth design means a stale snapshot
 * degrades gracefully (AC2) rather than breaking anything, so there is no
 * correctness reason this has to run on any particular schedule.
 *
 * Usage:
 *   pnpm --filter @agentrail/console catalog:refresh
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeOpenRouterModelsResponse } from "../lib/alignment/openrouter-normalize";
import type { RawOpenRouterModelsResponse } from "../lib/alignment/openrouter-normalize";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAPSHOT_PATH = resolve(__dirname, "../lib/alignment/openrouter-catalog.snapshot.json");

async function main(): Promise<void> {
  console.log(`Fetching ${OPENROUTER_MODELS_URL} ...`);
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter ${OPENROUTER_MODELS_URL} returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as RawOpenRouterModelsResponse;

  const { models, skippedCount } = normalizeOpenRouterModelsResponse(body);
  if (models.length === 0) {
    throw new Error(
      "Normalized 0 models from the OpenRouter response — refusing to overwrite the committed " +
        "snapshot with an empty one. Check the response shape against openrouter-normalize.ts's " +
        "module doc (the field mapping may have changed)."
    );
  }

  const snapshot = {
    schemaVersion: 1,
    sourceUrl: OPENROUTER_MODELS_URL,
    fetchedAt: new Date().toISOString(),
    modelCount: models.length,
    models,
  };

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${models.length} models to ${SNAPSHOT_PATH} ` +
      `(${skippedCount} skipped: missing/unparseable pricing or context fields).`
  );
}

main().catch((err: unknown) => {
  console.error("catalog refresh failed:", err);
  process.exitCode = 1;
});
