import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MODEL_CATALOG, CATALOG_PRICE_TABLE_MAPPING } from "./catalog";

// ---------------------------------------------------------------------------
// Cross-language drift guard.
//
// This is the sanctioned pattern for a TS mirror of a Python source of
// truth: read `agentrail/context/pricing.py`'s TEXT at test time (no Python
// interpreter, no import — just the file's own source), regex out the
// `PRICE_TABLE` entry for each model this catalog mirrors, and assert an
// exact match against the constants in catalog.ts. This file (catalog.ts)
// never reads the Python source itself — that would make it an impure
// module with a filesystem dependency; only the TEST does the reading.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// apps/console/lib/alignment -> repo root -> agentrail/context/pricing.py
const PRICING_PY_PATH = resolve(__dirname, "../../../../agentrail/context/pricing.py");

let pricingSource: string;

beforeAll(() => {
  pricingSource = readFileSync(PRICING_PY_PATH, "utf8");
});

interface PriceTableRates {
  input: number;
  output: number;
  cached_read: number;
  cached_write: number;
}

/**
 * Extract one `PRICE_TABLE` entry from the raw Python source by name.
 *
 * Anchored on `'<name>':  {` so a shorter name never false-matches inside a
 * longer one that happens to share a prefix (e.g. `claude-haiku-4-5` vs the
 * real `claude-haiku-4-5-20251001` entry that also exists in the table —
 * the anchor requires the closing quote to land immediately after `name`,
 * which only the exact entry satisfies).
 *
 * Returns `null` when no entry with that exact name exists — the caller
 * must treat `null` as a hard failure (never a silent $0 stand-in).
 */
function extractPriceTableEntry(source: string, modelName: string): PriceTableRates | null {
  const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryPattern = new RegExp(`'${escaped}':\\s*\\{([^}]*)\\}`);
  const entryMatch = source.match(entryPattern);
  if (!entryMatch) return null;

  const body = entryMatch[1];
  const field = (key: string): number | null => {
    const fieldMatch = body.match(new RegExp(`"${key}":\\s*([\\d.]+)`));
    return fieldMatch ? Number(fieldMatch[1]) : null;
  };

  const input = field("input");
  const output = field("output");
  const cached_read = field("cached_read");
  const cached_write = field("cached_write");
  if (input === null || output === null || cached_read === null || cached_write === null) {
    return null;
  }
  return { input, output, cached_read, cached_write };
}

describe("drift guard vs agentrail/context/pricing.py::PRICE_TABLE", () => {
  it("mirrors claude-opus-4-8 exactly (refactor seat)", () => {
    const entry = extractPriceTableEntry(pricingSource, "claude-opus-4-8");
    expect(entry, "PRICE_TABLE has no 'claude-opus-4-8' entry").not.toBeNull();
    expect(MODEL_CATALOG.refactor.inUsdPerMTok).toBe(entry!.input);
    expect(MODEL_CATALOG.refactor.outUsdPerMTok).toBe(entry!.output);
  });

  it("mirrors claude-haiku-4-5 exactly (mechanical seat) without colliding with the dated variant", () => {
    const entry = extractPriceTableEntry(pricingSource, "claude-haiku-4-5");
    expect(entry, "PRICE_TABLE has no 'claude-haiku-4-5' entry").not.toBeNull();
    expect(MODEL_CATALOG.mechanical.inUsdPerMTok).toBe(entry!.input);
    expect(MODEL_CATALOG.mechanical.outUsdPerMTok).toBe(entry!.output);
    // Sanity: the dated sibling entry is a DIFFERENT PRICE_TABLE key. If our
    // anchor were a loose substring match instead of an exact-name anchor,
    // this would still happen to pass today (both entries share rates) —
    // this assertion exists to document the distinction, not to catch drift.
    const dated = extractPriceTableEntry(pricingSource, "claude-haiku-4-5-20251001");
    expect(dated, "PRICE_TABLE should still carry the dated id too").not.toBeNull();
  });

  it("mirrors claude-sonnet-4-6 exactly (the ui/general stand-in — see catalog.ts KNOWN GAP)", () => {
    const entry = extractPriceTableEntry(pricingSource, "claude-sonnet-4-6");
    expect(entry, "PRICE_TABLE has no 'claude-sonnet-4-6' entry").not.toBeNull();
    expect(MODEL_CATALOG.ui.inUsdPerMTok).toBe(entry!.input);
    expect(MODEL_CATALOG.ui.outUsdPerMTok).toBe(entry!.output);
    expect(MODEL_CATALOG.general.inUsdPerMTok).toBe(entry!.input);
    expect(MODEL_CATALOG.general.outUsdPerMTok).toBe(entry!.output);
  });

  it("CANARY: claude-sonnet-5 itself still has no dedicated PRICE_TABLE entry", () => {
    // If this starts failing, someone added a real `claude-sonnet-5` entry to
    // PRICE_TABLE — that is GOOD NEWS, but it means catalog.ts's stand-in
    // mapping (CATALOG_PRICE_TABLE_MAPPING["anthropic/claude-sonnet-5"] ->
    // "claude-sonnet-4-6") is now stale and must be repointed at the real
    // entry. Do not silently delete this test when it fails — fix the
    // mapping first.
    expect(extractPriceTableEntry(pricingSource, "claude-sonnet-5")).toBeNull();
  });

  it("fails loudly — never $0 — for every name this catalog actually depends on", () => {
    // This is the assertion that makes the recon's "$0 hazard" structurally
    // impossible: every mapped PRICE_TABLE name this catalog relies on
    // (CATALOG_PRICE_TABLE_MAPPING's values) must resolve to a real entry.
    // `extractPriceTableEntry` returning `null` for any of these throws here,
    // in every CI run — there is no code path anywhere in this library that
    // treats a missing rate as 0.
    for (const [slug, priceTableName] of Object.entries(CATALOG_PRICE_TABLE_MAPPING)) {
      const entry = extractPriceTableEntry(pricingSource, priceTableName);
      expect(
        entry,
        `catalog slug "${slug}" maps to PRICE_TABLE name "${priceTableName}", which has no entry — ` +
          `this must fail the build, never silently price at $0`
      ).not.toBeNull();
    }
  });

  it("mutation-argument: a rate change in PRICE_TABLE without mirroring here fails this suite", () => {
    // Not a runnable mutation test (no source is mutated) — this documents
    // WHY the exact-equality assertions above have bite, per the brief's
    // "mutation-argue in a comment" requirement:
    //
    // Suppose a future PR bumps claude-opus-4-8's output rate in
    // agentrail/context/pricing.py from 25.0 to, say, 30.0, without touching
    // this file. `extractPriceTableEntry(pricingSource, "claude-opus-4-8")`
    // would then return `{ output: 30, ... }`, while
    // `MODEL_CATALOG.refactor.outUsdPerMTok` is still the old constant, 25.
    // The `toBe` equality assertion in the "mirrors claude-opus-4-8 exactly"
    // test above compares 25 to 30 and fails immediately — the drift is
    // caught the same run it lands in, not discovered later as a wrong
    // dollar figure in a rendered brief.
    expect(true).toBe(true);
  });
});
