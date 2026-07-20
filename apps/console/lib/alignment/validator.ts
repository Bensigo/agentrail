/**
 * Coding-model override validation for the alignment brief (#1275).
 *
 * Locked design point 6: a user's pick overrides the CODING model only —
 * per-phase planner/reviewer seats stay put (protects #1270's independent-
 * review guarantee). This module is the gate that enforces that on the one
 * axis a plain string equality check can catch before any run starts:
 * refusing an override that would collide with the workspace's configured
 * verify-phase model.
 *
 * Allowlist widened for #1338 PR②: the valid-slugs check below now reads
 * `eligibility.ts`'s {@link allEligibleModelSlugs} (the union of every task
 * type's eligible set) instead of reading `MODEL_CATALOG`'s values
 * directly. Today these are numerically the same 3 slugs (haiku is only
 * excluded from `ui`, and stays eligible for the other three task types, so
 * the union still covers every catalog seat) — the widening is about the
 * SOURCE OF TRUTH, not today's actual set: a future eligibility exclusion
 * that removes a model from EVERY task type now correctly shrinks this
 * allowlist too, without a second hand-maintained list to keep in sync.
 *
 * IMPORTANT — this allowlist is intentionally NOT scoped to the specific
 * task type an override applies to. Eligibility (`eligibility.ts`)
 * constrains the AUTO picker (`selector.ts`'s `selectExecuteModel`) only —
 * an explicit user override is a deliberate, informed human choice, and is
 * allowed even for a model `isModelEligibleForTaskType` would refuse to
 * auto-pick for that task (e.g. a user who explicitly wants haiku for a
 * `ui`-classified task can still say so; the auto picker just never
 * volunteers it). The two collision-with-verify-model and
 * not-a-known-model checks below are the full extent of what this
 * validator refuses.
 */

import { allEligibleModelSlugs } from "./eligibility";

export interface OverrideValidation {
  ok: boolean;
  /** Present iff ok is false. Honest, user-facing — never a generic "invalid" message. */
  reason?: string;
}

function catalogSlugs(): string[] {
  return allEligibleModelSlugs();
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
 * 2. **Known-model-only**: refuse any slug that isn't in
 *    `allEligibleModelSlugs()` — the union, across every task type, of
 *    models this system knows how to run at all (#1338 PR② widened this
 *    from a direct read of `MODEL_CATALOG`'s three seats to this
 *    eligibility-derived union; see this file's module doc for why they're
 *    numerically identical today and why the source-of-truth change still
 *    matters). Locked design point 6 calls for "the catalog ∪ a documented
 *    allowlist of additional priced models" but keeps v1 tight: the extra
 *    allowlist is intentionally EMPTY. Widening the override surface to
 *    arbitrary PRICE_TABLE-priced models would let a user pick something the
 *    task-type taxonomy never validated for cost/capability fit, and only
 *    increases the chance of an unnoticed future collision with whatever the
 *    verify phase is configured to — today's known models already span
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
