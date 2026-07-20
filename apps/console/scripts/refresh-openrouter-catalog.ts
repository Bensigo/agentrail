/**
 * Refreshes the committed OpenRouter model catalog snapshot from the live
 * `GET https://openrouter.ai/api/v1/models` endpoint (#1337).
 *
 * Writes BOTH byte-identical committed copies (the snapshot is hand-mirrored,
 * the same #1334/#1335 drift-guard convention PRICE_TABLE uses, because the
 * console image and the runner/fleet image have disjoint file sets — see
 * `agentrail/run/pricing.py`'s `_SNAPSHOT_PATH` comment):
 *   - `lib/alignment/openrouter-catalog.snapshot.json`  (console reader:
 *     `gateway-catalog.ts`)
 *   - `../../agentrail/context/openrouter-catalog.snapshot.json`  (Python
 *     reader: `agentrail/run/pricing.py`, ships in the runner image)
 * `test_gateway_snapshot_parity` (Python) fails CI if they ever diverge, so a
 * refresh that forgets one copy is caught — but this script writing both is
 * the primary guard.
 *
 * This is the ONLY place in the repo that makes this network call. Every
 * runtime lookup (`getModelFromCatalog`, `isKnownModelSlug`,
 * `getSnapshotMeta` in `../lib/alignment/gateway-catalog.ts`, and the Python
 * `_resolve_rates`) reads a committed snapshot file — never the network,
 * never on any request hot path. `openrouter-normalize.ts` (imported here)
 * does the actual field mapping and is unit-tested against real captured
 * entries in `openrouter-normalize.test.ts`; this script is deliberately
 * thin — fetch, normalize, write both.
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
// apps/console/scripts -> the two committed copies (see module doc for why two).
const CONSOLE_SNAPSHOT_PATH = resolve(__dirname, "../lib/alignment/openrouter-catalog.snapshot.json");
const PACKAGE_SNAPSHOT_PATH = resolve(
  __dirname,
  "../../../agentrail/context/openrouter-catalog.snapshot.json"
);

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

  // The SAME serialized bytes go to both copies so they stay byte-identical
  // (test_gateway_snapshot_parity enforces it); a single `fetchedAt` computed
  // once above guarantees the two files can't differ by even a timestamp.
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  writeFileSync(CONSOLE_SNAPSHOT_PATH, serialized, "utf8");
  writeFileSync(PACKAGE_SNAPSHOT_PATH, serialized, "utf8");
  console.log(
    `Wrote ${models.length} models to both snapshot copies ` +
      `(${skippedCount} skipped: missing/unparseable pricing or context fields):\n` +
      `  console: ${CONSOLE_SNAPSHOT_PATH}\n` +
      `  package: ${PACKAGE_SNAPSHOT_PATH}`
  );
}

main().catch((err: unknown) => {
  console.error("catalog refresh failed:", err);
  process.exitCode = 1;
});
