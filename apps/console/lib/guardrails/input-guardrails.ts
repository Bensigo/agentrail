/**
 * Jace's INPUT guardrail seam — the orchestrator (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
 *
 * Before this, Jace had no input guardrails at all: every message from every
 * channel reached the model verbatim. `agentrail/guardrails/policies/
 * input_contract.py` screened injection, but only at the GitHub-issue queue
 * entrance; `apps/jace/agent/lib/sanitize-untrusted.core.mjs` hardened only the
 * OUTBOUND render seams, and its own header states it cannot neutralize
 * natural-language injection. This is the inbound half.
 *
 * THREE LAYERS, CHEAPEST FIRST. Layers 1 and 2 are pure, free and always run;
 * layer 3 is the only one that touches the network, and it runs LAST and only
 * if the first two allowed the message — so a message blocked for injection
 * never costs a moderation call.
 *
 *   1. PII      -> REDACT and continue. Cleansed text goes to the model.
 *   2. injection-> BLOCK a stranger, WARN (record + proceed) a bound member.
 *   3. moderation-> BLOCK. Fails OPEN on any error.
 *
 * WHY REDACT RATHER THAN BLOCK FOR PII: blocking would throw away the user's
 * actual request over a detail they can simply restate. The card number is
 * removed from everything downstream — that is the goal — and the work still
 * happens.
 *
 * WHY THE INJECTION TRUST TIER: this team talks to Jace *about building
 * injection guardrails*. "Add a deny-list pattern for 'ignore previous
 * instructions'" must not be blocked. The threat model is a stranger DMing the
 * shared bot, not a workspace owner who can already direct Jace by legitimate
 * means. See `injection.ts`.
 *
 * This module is PURE for layers 1-2 (`screenInboundMessage` is synchronous,
 * does no I/O, and is exhaustively unit-testable) and keeps the one async
 * layer behind a separate call, so tests of the composition need no network
 * stub. Persisting findings is the CALLER's job (`channel-dispatch.ts` ->
 * `recordGuardrailEvent`) — this module writes nothing and reads no
 * environment beyond the kill-switch.
 */
import { normalizeForScreening, redactPii } from "./pii";
import { screenInjection } from "./injection";
import { moderateInbound, isModerationConfigured } from "./moderation";
import { areInputGuardrailsEnabled } from "./feature-flags";
import type { Finding, GuardrailTrust, ScreenResult } from "./types";

/**
 * Layers 1 and 2. Pure and synchronous.
 *
 * Order matters: PII redaction runs FIRST so that injection screening (and,
 * downstream, the moderation call) never sees a live card number. A message
 * that is both blocked for injection and carried PII still gets its PII
 * finding reported, so the audit trail is complete rather than
 * short-circuited at the first tripwire.
 *
 * Returns the NORMALIZED text in every case — callers must use
 * `result.text`, never the original, so the invisible-character stripping is
 * not silently discarded on the allow path.
 */
export function screenInboundMessage(
  text: string,
  opts: { trust: GuardrailTrust }
): ScreenResult {
  const normalized = normalizeForScreening(typeof text === "string" ? text : "");

  if (!areInputGuardrailsEnabled()) {
    return { verdict: "allow", text: normalized, findings: [] };
  }

  const findings: Finding[] = [];

  // Layer 1 — PII: redact and continue.
  const pii = redactPii(normalized);
  findings.push(...pii.findings);

  // Layer 2 — injection, screened against the ALREADY-REDACTED text.
  const injection = screenInjection(pii.text, opts.trust);
  if (injection.finding) findings.push(injection.finding);

  if (injection.action === "block") {
    return { verdict: "block", text: pii.text, findings };
  }

  return {
    verdict: pii.findings.length > 0 ? "redact" : "allow",
    text: pii.text,
    findings,
  };
}

/**
 * Hazard codes that are RECORDED but never block.
 *
 * S14 ("Code interpreter abuse") is in Llama Guard's taxonomy for tool-calling
 * assistants in general — but Jace is a coding agent whose literal job is
 * writing and running code. "Write a script that clears these temp files" is
 * the product working, not an attack, and blocking on S14 would break normal
 * use for every user. It is recorded so the rate is visible if we ever want to
 * revisit, and the guardrails that actually cover this risk live elsewhere:
 * the sandbox, the approval gate, and `push_guardrail`.
 *
 * This is the same reasoning as the injection trust tiers — a guardrail that
 * fires constantly on legitimate work gets disabled by whoever it annoys, and
 * then protects nothing.
 */
export const MODERATION_NON_BLOCKING_HAZARDS: ReadonlySet<string> = new Set(["S14"]);

export interface ModerationGateResult {
  /** `true` when the turn must not run. */
  blocked: boolean;
  finding: Finding | null;
  /** Set when the layer errored or was skipped — the turn still runs (fail-open). */
  errorReason?: string;
  /** `false` when no API key is configured, so the caller can skip the audit row. */
  ran: boolean;
}

/**
 * Layer 3. Call ONLY when `screenInboundMessage` did not block — a message
 * already rejected for injection should not cost a moderation call.
 *
 * FAILS OPEN, always. A timeout, outage, non-200, or unparseable body allows
 * the turn and reports `errorReason`. An OpenRouter incident must never become
 * a Jace incident, and the deterministic layers have already run, so the
 * message is not unscreened. This never throws.
 */
export async function moderationGate(text: string): Promise<ModerationGateResult> {
  if (!areInputGuardrailsEnabled() || !isModerationConfigured()) {
    return { blocked: false, finding: null, ran: false };
  }

  const result = await moderateInbound(text);

  if (result.verdict === "block" && result.finding) {
    // Recorded either way; only a blocking hazard stops the turn.
    if (MODERATION_NON_BLOCKING_HAZARDS.has(result.finding.type)) {
      return { blocked: false, finding: result.finding, ran: true };
    }
    return { blocked: true, finding: result.finding, ran: true };
  }
  if (result.verdict === "error") {
    return {
      blocked: false,
      finding: null,
      ran: true,
      ...(result.reason ? { errorReason: result.reason } : {}),
    };
  }
  return { blocked: false, finding: null, ran: true };
}

/**
 * The user-facing notice for a blocked message, per category. Deliberately
 * neutral and short: it must not coach an attacker on what tripped, and must
 * not shame a human who typed something the moderation model disliked.
 */
export function blockNotice(findings: Finding[]): string {
  const moderation = findings.find((f) => f.category === "moderation");
  if (moderation) {
    return "I can't help with that one. If you think that's a mistake, rephrase it or reach out to your workspace admin.";
  }
  return "I can't act on that message. If you're trying to reach a human, contact your workspace admin.";
}

/** The one-line note appended after PII was cleansed, so the redaction is never silent. */
export function redactionNotice(findings: Finding[]): string {
  const types = Array.from(
    new Set(findings.filter((f) => f.category === "pii").map((f) => f.type))
  );
  if (types.length === 0) return "";
  return `Heads up — I removed what looked like sensitive details (${types.join(", ")}) from your message before processing it. Don't send card or bank details here.`;
}
