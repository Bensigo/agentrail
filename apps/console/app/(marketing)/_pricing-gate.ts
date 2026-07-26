/**
 * #1415 PR② — the landing honesty gate for the pricing claim (issue's own
 * "Landing honesty rule": "the landing pricing claim must render ONLY once
 * billing is verified live on prod"). Same convention as this codebase's
 * other rollout-safety flags (`AGENTRAIL_WIKI_RECOMPILE_ON_PUSH` in
 * `connectors/github/webhook/route.ts`, `ONBOARD_ON_CONNECT_FLAG`): only the
 * exact string "1" enables it, default OFF, so a stray truthy env value
 * ("false", "0", "") can never accidentally flip it on.
 *
 * `NEXT_PUBLIC_` because this reads at render time in a page that may be
 * statically optimized — a plain `process.env` read still works fine for a
 * server component today, but the public prefix keeps this consistent if
 * the check ever needs to run client-side too, and makes the intent (a
 * user-visible claim toggle, not a secret) unambiguous at the call site.
 *
 * The owner flips this in Railway once AC1 (real Stripe test-mode top-up
 * credits the wallet) and AC2 (billing-enabled admission + completion
 * charge) are BOTH browser-verified on prod — see the issue's own
 * "Verification evidence" section. Until then, the landing's existing
 * "Pay for what you use" step description (page.tsx, section 6b) stays as
 * the only billing-adjacent copy: it describes a future model in plain
 * steps without claiming it is live today, so it needs no gate. This flag
 * only gates the NEW claim this PR adds: a link to the real numbers on
 * `/pricing`, which — unlike the step description — asserts "this is what
 * you will actually pay right now."
 */
const PRICING_CLAIM_LIVE_FLAG = "NEXT_PUBLIC_BILLING_VERIFIED_LIVE";

export function isPricingClaimLive(): boolean {
  return process.env[PRICING_CLAIM_LIVE_FLAG] === "1";
}
