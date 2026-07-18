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
 */

import { classifyTaskType } from "./classifier";
import type { TaskInput } from "./classifier";
import { MODEL_CATALOG } from "./catalog";
import type { ModelSeat } from "./catalog";
import type { TaskType } from "./classifier";

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
  /** USD, rounded to cents. Never 0 for a valid catalog model (see estimate.test.ts). */
  estimateUsd: number;
  /** Honest, human-readable list the brief displays alongside the number. */
  assumptions: string[];
}

/**
 * Compute the alignment brief's suggested model + cost estimate for a task.
 *
 * Pure: classification, bucketing, and pricing are all deterministic lookups
 * over the input plus the two constant tables above — no I/O, no clock, no
 * randomness.
 */
export function estimateBrief(input: TaskInput): BriefEstimate {
  const taskType = classifyTaskType(input);
  const suggestedModel = MODEL_CATALOG[taskType];
  const volumeBucket = bucketVolume(input);
  const { inTokens, outTokens } = VOLUME_TOKEN_ASSUMPTIONS[volumeBucket];

  const rawUsd =
    (inTokens / 1_000_000) * suggestedModel.inUsdPerMTok +
    (outTokens / 1_000_000) * suggestedModel.outUsdPerMTok;

  // Rounded to cents. Never 0 for a valid catalog model: every MODEL_CATALOG
  // rate is > 0 (cheapest is mechanical's $1.00/$5.00 per MTok) and every
  // VOLUME_TOKEN_ASSUMPTIONS bucket has > 0 tokens both directions, so rawUsd
  // is always strictly positive before rounding (smallest possible value is
  // mechanical x S = $0.06 — see estimate.test.ts's exact-math table).
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
    `Priced at ${suggestedModel.displayName} rates ($${suggestedModel.inUsdPerMTok}/` +
      `$${suggestedModel.outUsdPerMTok} per MTok in/out).`,
  ];

  return { taskType, suggestedModel, volumeBucket, estimateUsd, assumptions };
}
