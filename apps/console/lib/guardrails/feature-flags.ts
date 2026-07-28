/**
 * The kill-switch for Jace's input guardrails (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
 *
 * DELIBERATE DEVIATION from this repo's default-OFF flag convention
 * (`lib/chat/feature-flags.ts`, `lib/alignment/feature-flags.ts`), approved by
 * the owner in the design review. That convention governs FEATURES, where
 * default-OFF is rollout safety. These are guardrails — a safety floor that
 * ships off is not a safety floor, and the two deterministic layers have no
 * credential, no network call, no cost and no measurable latency, so there is
 * nothing to roll out safely in the first place.
 *
 * Hence a kill-switch (`JACE_INPUT_GUARDRAILS_DISABLED`) rather than an
 * enable-flag: the guardrails are on the moment this merges, and turning them
 * OFF is the deliberate act that requires setting an environment variable.
 *
 * The moderation layer has its own, separate gate — the presence of
 * `OPENROUTER_API_KEY` (see `moderation.ts`). Absent the key it disables
 * itself and logs once; layers 1 and 2 are unaffected. So this module is the
 * ONLY switch that can turn off PII and injection screening.
 */

/**
 * The subset of `process.env` this module reads — injectable so tests never
 * mutate the real `process.env`. The index signature (rather than just the one
 * named optional prop) is what lets `process.env` itself
 * (`NodeJS.ProcessEnv`) satisfy this type as the default parameter value,
 * matching `lib/chat/feature-flags.ts`'s own shape.
 */
export interface GuardrailFeatureFlagEnv {
  JACE_INPUT_GUARDRAILS_DISABLED?: string | undefined;
  [key: string]: string | undefined;
}

/** Same truthiness rule the other flag modules use: `"1"` or `"true"` (any case). */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Whether the input guardrails run at all. TRUE unless explicitly disabled —
 * note the inversion versus every other flag helper in this repo, which is the
 * whole point (see the module doc-comment).
 */
export function areInputGuardrailsEnabled(
  env: GuardrailFeatureFlagEnv = process.env
): boolean {
  return !isTruthyFlag(env.JACE_INPUT_GUARDRAILS_DISABLED);
}
