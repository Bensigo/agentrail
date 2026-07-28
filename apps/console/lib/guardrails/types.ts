/**
 * The shared vocabulary of Jace's INPUT guardrails (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
 *
 * Jace had no input guardrails at all before this: every message from every
 * channel reached the model verbatim. `agentrail/guardrails/policies/
 * input_contract.py` screens injection, but only at the GitHub-issue queue
 * entrance; `apps/jace/agent/lib/sanitize-untrusted.core.mjs` hardens only the
 * OUTBOUND render seams and its own header states it cannot neutralize
 * natural-language injection. This module tree is the inbound half.
 *
 * Types only — no logic, no I/O — so the three detector modules (`pii.ts`,
 * `injection.ts`, `moderation.ts`) can be written and tested independently
 * against one contract that `input-guardrails.ts` then composes.
 */

/** Which guardrail produced a finding. Mirrors `guardrail_events.category`. */
export type GuardrailCategory = "pii" | "injection" | "moderation";

/**
 * How a finding was produced. Mirrors `guardrail_events.detector`.
 * `deterministic` = a pure regex/checksum layer; `model` = the Llama Guard call.
 */
export type GuardrailDetector = "deterministic" | "model";

/**
 * What the seam did about a message. Mirrors `guardrail_events.verdict`.
 *
 * - `allow`  — nothing tripped, or a bound member's injection match was only
 *              recorded (see the trust tiers in `injection.ts`).
 * - `redact` — PII was found and CLEANSED; the turn proceeds with new text.
 * - `block`  — the turn must not run.
 * - `error`  — the model layer failed; the seam FAILS OPEN and the turn runs.
 */
export type GuardrailVerdict = "allow" | "redact" | "block" | "error";

/**
 * The sender's trust tier, read from the identity spine `channel-dispatch.ts`
 * has already resolved by the time it screens.
 *
 * `stranger` is a `chat_identity` with no resolved workspace — the existing
 * intro path. `bound` is an identity resolved to a workspace, and every
 * console sender (an authenticated workspace member).
 *
 * This exists because of a concrete false positive: this team talks to Jace
 * ABOUT building injection guardrails, and "add a pattern for `ignore previous
 * instructions`" must not be blocked. The threat model is a stranger DMing the
 * shared bot, not the workspace owner — who can already direct Jace by
 * legitimate means.
 */
export type GuardrailTrust = "bound" | "stranger";

/**
 * One thing a detector found. Deliberately carries NO raw matched text: these
 * flow into the `guardrail_events` audit row, and persisting the PII we just
 * redacted would defeat the guardrail. `offsets` locate a match without
 * reproducing it.
 */
export interface Finding {
  category: GuardrailCategory;
  /**
   * Machine-readable subtype — `"card"`/`"iban"`/`"ssn"` for PII, the pattern
   * id for injection, the hazard code (`"S1"`…) for moderation. Stored in
   * `guardrail_events.match_types`.
   */
  type: string;
  /** Human-readable, safe to log and to show in an operator UI. Never quotes the match. */
  reason: string;
  detector: GuardrailDetector;
  /** `[start, end)` code-unit offsets of each match in the NORMALIZED text. */
  offsets: Array<[number, number]>;
}

/** What `screenInboundMessage` returns — the deterministic layers' combined result. */
export interface ScreenResult {
  verdict: Exclude<GuardrailVerdict, "error">;
  /** Cleansed when `verdict === "redact"`; otherwise the normalized input. */
  text: string;
  findings: Finding[];
}
