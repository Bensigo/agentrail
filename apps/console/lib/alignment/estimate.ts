/**
 * Brief cost estimate for the alignment brief (#1275).
 *
 * Combines the task-type classifier ({@link classifyTaskType}) and model
 * catalog ({@link MODEL_CATALOG}) with a volume-bucket proxy to produce a
 * single {@link BriefEstimate}: the suggested coding model and its dollar
 * estimate that later PRs render in Jace's alignment brief, and — per the
 * binding owner decision (recon annex, both issues, 2026-07-18) — that later
 * become the run's ENFORCED budget once the user confirms the brief. That
 * wiring (queue_entries column, WorkItem budget field, --budget-usd
 * passthrough) is explicitly out of scope for this PR; this module only
 * computes the number that wiring will eventually carry.
 *
 * Pricing (#1337 PR ②): the suggested seat's rate is resolved gateway-first
 * via {@link resolveModelPrice} — the live-fetched OpenRouter catalog wins
 * when it knows the seat's slug, `suggestedModel`'s own PRICE_TABLE-mirrored
 * constants otherwise. {@link BriefEstimate.priceSource} records which one
 * won so a later persisted cost/estimate record stays auditable (AC1); the
 * resolved numbers can legitimately differ from `suggestedModel`'s own
 * constants (e.g. `claude-sonnet-5`'s live introductory rate vs. catalog.ts's
 * deliberately-conservative sticker mirror — see catalog.ts's module doc).
 */

import { classifyTaskType } from "./classifier";
import type { TaskInput } from "./classifier";
import { MODEL_CATALOG } from "./catalog";
import type { ModelSeat } from "./catalog";
import type { TaskType } from "./classifier";
import { resolveModelPrice } from "./resolve-price";
import type { PriceSource } from "./resolve-price";

export type VolumeBucket = "S" | "M" | "L";

// ---------------------------------------------------------------------------
// Volume buckets (ASSUMPTION — v1 proxies only; see module doc + recon §3:
// "Expected-volume signal — no existing code computes this for anything
// cost-related." acceptanceCriteria.length and whatToBuild/AC body length are
// the only signals free at brief-render time, before any clone or context
// pack exists.)
// ---------------------------------------------------------------------------

/** ASSUMPTION: <=2 acceptance criteria reads as a narrow, single-outcome task. */
const SMALL_AC_COUNT = 2;
/** ASSUMPTION: >=5 acceptance criteria reads as a multi-part, broad task. */
const LARGE_AC_COUNT = 5;
/** ASSUMPTION: combined whatToBuild + AC text at or under this is "short" prose. */
const SHORT_BODY_CHARS = 280;
/** ASSUMPTION: combined whatToBuild + AC text over this is "long" prose. */
const LONG_BODY_CHARS = 1200;

function bodyLength(input: Pick<TaskInput, "whatToBuild" | "acceptanceCriteria">): number {
  return input.whatToBuild.length + input.acceptanceCriteria.join(" ").length;
}

/**
 * Bucket a task's expected volume as Small / Medium / Large from two free
 * proxies: acceptance-criteria count and combined body length. Thresholds
 * are documented assumptions (see constants above), not measurements.
 *
 *   - L: acCount >= 5 OR bodyChars > 1200 (either alone is enough)
 *   - S: acCount <= 2 AND bodyChars <= 280 (both required)
 *   - M: everything else
 */
export function bucketVolume(input: Pick<TaskInput, "whatToBuild" | "acceptanceCriteria">): VolumeBucket {
  const acCount = input.acceptanceCriteria.length;
  const bodyChars = bodyLength(input);

  if (acCount >= LARGE_AC_COUNT || bodyChars > LONG_BODY_CHARS) return "L";
  if (acCount <= SMALL_AC_COUNT && bodyChars <= SHORT_BODY_CHARS) return "S";
  return "M";
}

interface VolumeAssumption {
  inTokens: number;
  outTokens: number;
}

/**
 * ASSUMPTION: per-bucket token volumes. Not measured — no pre-run token
 * telemetry exists (recon §3/§4: no existing code combines any volume proxy
 * into anything cost-shaped today). Anchored to an order-of-magnitude guess
 * for a context-pack-heavy agentic run (output ~10% of input: the agent
 * reads far more context than it writes diff), NOT a fitted average.
 * Recalibrate once enough completed runs have both a volume bucket and a
 * real `runs.costUsd` to correlate against (recon: "calibratable later").
 */
const VOLUME_TOKEN_ASSUMPTIONS: Record<VolumeBucket, VolumeAssumption> = {
  S: { inTokens: 40_000, outTokens: 4_000 },
  M: { inTokens: 120_000, outTokens: 12_000 },
  L: { inTokens: 300_000, outTokens: 30_000 },
};

const BUCKET_LABEL: Record<VolumeBucket, string> = { S: "Small", M: "Medium", L: "Large" };

export interface BriefEstimate {
  taskType: TaskType;
  suggestedModel: ModelSeat;
  volumeBucket: VolumeBucket;
  /**
   * The per-MTok rates actually used for `estimateUsd`'s math. Gateway-
   * sourced when the live catalog knows `suggestedModel.slug`, else
   * `suggestedModel`'s own PRICE_TABLE-mirrored constants — see
   * {@link priceSource}. Can differ from `suggestedModel.inUsdPerMTok` /
   * `.outUsdPerMTok`; those are the seat's own hand-mirrored constants,
   * these are what was actually resolved and priced.
   */
  resolvedInUsdPerMTok: number;
  resolvedOutUsdPerMTok: number;
  /** Which table produced the resolved rates above (AC1 — ledger auditability). */
  priceSource: PriceSource;
  /** USD, rounded to cents. Never 0 for a valid catalog model (see estimate.test.ts). */
  estimateUsd: number;
  /** Honest, human-readable list the brief displays alongside the number. */
  assumptions: string[];
}

const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  gateway: "live OpenRouter gateway pricing",
  price_table: "the canonical PRICE_TABLE mirror (gateway catalog had no rate for this slug)",
  fallback: "a neutral fallback rate (no known price for this model at all)",
};

/**
 * Compute the alignment brief's suggested model + cost estimate for a task.
 *
 * Pure from this function's own point of view: classification, bucketing,
 * and pricing are all deterministic lookups over the input plus the constant
 * tables above and the gateway catalog ({@link resolveModelPrice}) — this
 * function itself performs no I/O, no clock reads beyond `Date.now()`-free
 * arithmetic, no randomness. (`resolveModelPrice` -> `getModelFromCatalog`
 * does lazily trigger a background network fetch on a process's first call —
 * see `gateway-catalog.ts`'s module doc — but that fetch is fire-and-forget
 * and never awaited here, so THIS function's own execution stays
 * synchronous and side-effect-free either way.)
 */
export function estimateBrief(input: TaskInput): BriefEstimate {
  const taskType = classifyTaskType(input);
  const suggestedModel = MODEL_CATALOG[taskType];
  const volumeBucket = bucketVolume(input);
  const { inTokens, outTokens } = VOLUME_TOKEN_ASSUMPTIONS[volumeBucket];

  const { inUsdPerMTok, outUsdPerMTok, priceSource } = resolveModelPrice(suggestedModel);

  const rawUsd = (inTokens / 1_000_000) * inUsdPerMTok + (outTokens / 1_000_000) * outUsdPerMTok;

  // Rounded to cents. Never 0 for any of today's shipped seats: every
  // resolved rate (gateway or PRICE_TABLE-mirrored fallback) is > 0 for the
  // 4 real MODEL_CATALOG slugs, and every VOLUME_TOKEN_ASSUMPTIONS bucket has
  // > 0 tokens both directions, so rawUsd is always strictly positive before
  // rounding — see estimate.test.ts's exact-math table (computed against
  // whatever resolveModelPrice actually resolves, not a hardcoded literal,
  // since gateway rates can move between one process's live catalog fetch
  // and the next).
  const estimateUsd = Math.round(rawUsd * 100) / 100;

  const bodyChars = bodyLength(input);
  const assumptions = [
    `Classified as "${taskType}" from the issue's title/whatToBuild/acceptance ` +
      `criteria text (keyword heuristic, not measured — see classifier.ts).`,
    `Volume bucket "${BUCKET_LABEL[volumeBucket]}": ${input.acceptanceCriteria.length} ` +
      `acceptance criteria, ~${bodyChars} body characters.`,
    `~${inTokens.toLocaleString("en-US")} input / ${outTokens.toLocaleString("en-US")} output ` +
      `tokens assumed for a ${BUCKET_LABEL[volumeBucket]} task (an assumption, not a ` +
      `measurement — see VOLUME_TOKEN_ASSUMPTIONS).`,
    `Priced at ${suggestedModel.displayName} rates ($${inUsdPerMTok}/` +
      `$${outUsdPerMTok} per MTok in/out) from ${PRICE_SOURCE_LABEL[priceSource]}.`,
  ];

  return {
    taskType,
    suggestedModel,
    volumeBucket,
    resolvedInUsdPerMTok: inUsdPerMTok,
    resolvedOutUsdPerMTok: outUsdPerMTok,
    priceSource,
    estimateUsd,
    assumptions,
  };
}
