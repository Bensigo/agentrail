/**
 * Coding-model override validation for the alignment brief (#1275).
 *
 * Locked design point 6: a user's pick overrides the CODING model only —
 * per-phase planner/reviewer seats stay put (protects #1270's independent-
 * review guarantee). This module is the gate that enforces that on the one
 * axis a plain string equality check can catch before any run starts:
 * refusing an override that would collide with the workspace's configured
 * verify-phase model.
 */

import { MODEL_CATALOG } from "./catalog";

export interface OverrideValidation {
  ok: boolean;
  /** Present iff ok is false. Honest, user-facing — never a generic "invalid" message. */
  reason?: string;
}

function catalogSlugs(): string[] {
  return Array.from(new Set(Object.values(MODEL_CATALOG).map((seat) => seat.slug)));
}

/**
 * Validate a user's coding-model override against the workspace's configured
 * independent-review (verify-phase) model.
 *
 * Two refusal reasons, checked in this order:
 *
 * 1. **The #1270 protection** (checked first, unconditionally — this is the
 *    load-bearing one): refuse when `overrideSlug === configuredVerifyModel`.
 *    Recon annex §4: `agentrail/cli/commands/run.py`'s verify-phase resolver
 *    (`:369-404`) requires execute and verify to resolve to DIFFERENT
 *    models; when they collide it reports `independent_review_status:
 *    "skipped_no_distinct_model"` — verify silently does not run at all.
 *    That is precisely the failure mode issue #1270 exists to make legible
 *    and prevent, so this refusal's `reason` says so by name rather than
 *    hiding behind a generic "invalid model" message.
 *
 * 2. **Catalog-only in v1**: refuse any slug that isn't one of the three
 *    catalog seats (ui/general share one slug, so effectively 3 distinct
 *    choices). Locked design point 6 calls for "the catalog ∪ a documented
 *    allowlist of additional priced models" but keeps v1 tight: the
 *    allowlist is intentionally EMPTY. Widening the override surface to
 *    arbitrary PRICE_TABLE-priced models would let a user pick something the
 *    task-type taxonomy never validated for cost/capability fit, and only
 *    increases the chance of an unnoticed future collision with whatever the
 *    verify phase is configured to — the catalog's 3 seats already span
 *    cheap/mid/strong, which is enough choice for v1. Revisit if a real
 *    request for a non-catalog override shows up.
 */
export function validateOverride(
  overrideSlug: string,
  configuredVerifyModel: string
): OverrideValidation {
  if (overrideSlug === configuredVerifyModel) {
    return {
      ok: false,
      reason:
        `"${overrideSlug}" is also this workspace's configured independent-review (verify-phase) ` +
        `model. Overriding the coding model to match it would silently disable independent review — ` +
        `the run's verify-phase resolver has no distinct model left to run against and reports ` +
        `independent_review_status: "skipped_no_distinct_model" (agentrail/cli/commands/run.py). ` +
        `This is exactly the failure issue #1270 exists to prevent, so the override is refused ` +
        `rather than silently shipping a run with no independent review.`,
    };
  }

  const validSlugs = catalogSlugs();
  if (!validSlugs.includes(overrideSlug)) {
    return {
      ok: false,
      reason:
        `"${overrideSlug}" is not one of the v1 coding-model choices (${validSlugs.join(", ")}). ` +
        `Overrides are catalog-only in v1 — see validateOverride's doc comment for why the ` +
        `allowlist isn't wider yet.`,
    };
  }

  return { ok: true };
}
