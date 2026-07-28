/**
 * Layer 3 — Moderation (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md, "Layer 3
 * — Moderation" and "Failure posture" sections).
 *
 * The only layer of Jace's input guardrails that touches the network. Layers
 * 1 (`pii.ts`) and 2 (`injection.ts`) are pure, always-on, and have already
 * run by the time `input-guardrails.ts` calls this — so a failure here never
 * leaves a message completely unscreened.
 *
 * ## Why this model
 *
 * `meta-llama/llama-guard-4-12b` (served on OpenRouter via DeepInfra/Together)
 * is a purpose-built content-safety classifier with the MLCommons hazard
 * taxonomy baked into its weights: one user turn in, `safe` or
 * `unsafe\nS<N>` out — no system prompt, no policy text, ~3 completion
 * tokens. That makes it the CHEAPEST option once total per-message cost is
 * counted, not just the headline prompt rate:
 *
 *   - meta-llama/llama-guard-4-12b:            $0.0000459/msg (taxonomy in weights)
 *   - openai/gpt-oss-safeguard-20b (low effort): $0.000063/msg (+400-token policy every call)
 *   - openai/gpt-oss-safeguard-20b (default):    $0.00012/msg  (…plus a reasoning trace at 4x completion rate)
 *
 * gpt-oss-safeguard's lower prompt rate is more than offset by its higher
 * completion rate, the mandatory policy text, and its reasoning trace. Llama
 * Guard is also not a Claude model, which satisfies the standing
 * candidate-diversity rule for anything that reaches a real cost ledger.
 *
 * ## Fail-open, always
 *
 * "Fail-open on moderation; fail-closed on nothing" (spec, "Failure
 * posture"). An OpenRouter outage must never become a Jace outage: layers 1-2
 * have already screened the message, so letting a turn through un-moderated
 * during an outage is a bounded, acceptable degradation — refusing to serve
 * Jace at all because a third-party classifier is down is not. Concretely,
 * every one of these returns `verdict: "error"` and NEVER throws:
 *
 *   - no API key configured (logged at most once per process — not once per
 *     message, which would spam logs under load for a config problem that
 *     doesn't change message-to-message)
 *   - network rejection / DNS failure
 *   - the 2s timeout firing
 *   - a non-200 response (401 bad key, 429 rate limit, 500 upstream, ...)
 *   - a 200 whose body isn't JSON
 *   - valid JSON with a missing/empty `choices[0].message.content`
 *   - content that parses as neither `safe` nor `unsafe...`
 *
 * `moderateInbound` is the seam callers can `await` unconditionally without a
 * try/catch of their own; `isModerationConfigured` lets the orchestrator skip
 * the await entirely (and the log-once for a missing key) when layer 3 is
 * simply off for this process.
 */
import type { Finding } from "./types.js";

export interface ModerationDeps {
  fetch?: typeof globalThis.fetch;
  apiKey?: string | undefined; // defaults to process.env.OPENROUTER_API_KEY
  timeoutMs?: number; // defaults to 2000
}

export interface ModerationResult {
  verdict: "allow" | "block" | "error";
  finding: Finding | null; // present when verdict === "block"
  /** Why it errored / was skipped. For logs and the audit row. Never the raw message. */
  reason?: string;
}

/** Pinned per the spec — a purpose-built classifier does not need sampling or headroom. */
const MODEL_SLUG = "meta-llama/llama-guard-4-12b";
const MAX_TOKENS = 16;
const TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 2000;
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * MLCommons hazard taxonomy Llama Guard classifies against, S1-S13, mapped to
 * a short human-readable label for logs/audit UI. `Object.freeze` so a typo'd
 * write attempt fails loud in dev rather than silently mutating a shared
 * lookup.
 *
 * S1-S14 are the full current taxonomy, verified against Meta's published
 * Llama Guard model card (the MLCommons v0.5 13-hazard taxonomy plus S14 for
 * tool-calling), not inferred. Even so, {@link hazardLabel}'s fallback exists
 * so an as-yet-unknown code from a future revision degrades to a generic label
 * instead of crashing the whole guardrail seam.
 */
const HAZARD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  S1: "Violent crimes",
  S2: "Non-violent crimes",
  S3: "Sex-related crimes",
  S4: "Child sexual exploitation",
  S5: "Defamation",
  S6: "Specialized advice (medical, legal, or financial)",
  S7: "Privacy violations",
  S8: "Intellectual property violations",
  S9: "Indiscriminate weapons (CBRNE)",
  S10: "Hate",
  S11: "Suicide and self-harm",
  S12: "Sexual content",
  S13: "Elections",
  // S14 is REAL and current, not hypothetical: Meta's Llama Guard model card
  // defines 14 categories — the MLCommons taxonomy's 13 hazards plus this one,
  // added for tool-calling use cases. It is called out here because it is the
  // category most likely to misfire on THIS product: Jace is a coding agent,
  // and "write a script that clears these files" is its actual job. The
  // orchestrator (`input-guardrails.ts`) therefore records S14 without
  // blocking on it — see MODERATION_NON_BLOCKING_HAZARDS there.
  S14: "Code interpreter abuse",
});

/** Human-readable label for a hazard code, with a fallback for unknown codes so a future taxonomy revision can never throw. */
function hazardLabel(code: string): string {
  if (code === "unspecified") {
    return "Unsafe content (model did not return a hazard category)";
  }
  return HAZARD_LABELS[code] ?? `Unrecognized hazard category (${code})`;
}

/** Logged at most once per process — see module doc on why a missing key is a log-once, not a log-per-message, condition. */
let loggedMissingKey = false;

function resolveApiKey(deps?: Pick<ModerationDeps, "apiKey">): string | undefined {
  const key = deps?.apiKey ?? process.env.OPENROUTER_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

/**
 * Whether layer 3 is active at all (an API key is present). Exported so the
 * orchestrator (`input-guardrails.ts`) can skip the `await` entirely — and
 * the log-once — when the key was never configured for this process, rather
 * than round-tripping through `moderateInbound` just to get the same
 * `verdict: "error"` back every single call.
 */
export function isModerationConfigured(deps?: Pick<ModerationDeps, "apiKey">): boolean {
  return resolveApiKey(deps) !== undefined;
}

/**
 * Pull `choices[0].message.content` out of a parsed OpenRouter chat-completion
 * body without assuming any of the shape is actually there — this is the ONE
 * place a malformed-but-still-JSON response gets normalized to `null`
 * instead of a thrown `TypeError` from an optional-chaining miss deep in the
 * caller.
 */
function extractContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0) return null;
  return content;
}

/**
 * Parse Llama Guard's own two-line output contract: FIRST line (trimmed,
 * lowercased) is `safe` or `unsafe`; for `unsafe`, the SECOND line (if
 * present) carries the hazard code. Anything else — a completion that is
 * neither — is treated as unrecognized model output and fails open as
 * `error`, never as a silent `allow`.
 */
function parseVerdict(content: string): ModerationResult {
  const lines = content.trim().split(/\r?\n/);
  const first = (lines[0] ?? "").trim().toLowerCase();

  if (first === "safe") {
    return { verdict: "allow", finding: null };
  }

  if (first === "unsafe") {
    const rawCode = lines[1]?.trim().toUpperCase();
    const type = rawCode && rawCode.length > 0 ? rawCode : "unspecified";
    const finding: Finding = {
      category: "moderation",
      type,
      reason: hazardLabel(type),
      detector: "model",
      offsets: [], // the model classifies the whole message; it does not locate spans
    };
    return { verdict: "block", finding };
  }

  return {
    verdict: "error",
    finding: null,
    reason: "unrecognized moderation output (neither safe nor unsafe)",
  };
}

/**
 * The one network call in Jace's input guardrails. Sends `text` as a single
 * user turn to `meta-llama/llama-guard-4-12b` on OpenRouter and returns a
 * verdict. NEVER throws — every failure mode described in the module doc
 * resolves to `verdict: "error"` instead.
 */
export async function moderateInbound(text: string, deps: ModerationDeps = {}): Promise<ModerationResult> {
  const apiKey = resolveApiKey(deps);
  if (!apiKey) {
    if (!loggedMissingKey) {
      loggedMissingKey = true;
      console.warn(
        "[moderation] OPENROUTER_API_KEY not configured — layer 3 (moderation) is disabled for this " +
          "process; layers 1-2 (PII, injection) are unaffected. Set the key on the console service to enable it."
      );
    }
    return { verdict: "error", finding: null, reason: "not configured: missing OPENROUTER_API_KEY" };
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // The `finally` below runs on every exit path — including the success
  // path — so the timer is always cleared and can never hold the process
  // open past this call resolving (per the task's explicit requirement).
  try {
    let res: Response;
    try {
      res = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_SLUG,
          messages: [{ role: "user", content: text }],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Covers a rejected fetch for ANY reason: DNS failure, connection
      // refused, TLS error, or the abort signal firing on timeout (a real
      // `fetch` rejects with a DOMException named "AbortError" when its
      // signal aborts). No retry — a single fast, bounded attempt is the
      // whole point of a 2s-timeout, no-retry layer sitting in front of a
      // real-time chat turn.
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        verdict: "error",
        finding: null,
        reason: aborted ? `timed out after ${timeoutMs}ms` : "network error calling OpenRouter",
      };
    }

    if (!res.ok) {
      return { verdict: "error", finding: null, reason: `OpenRouter returned ${res.status}` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { verdict: "error", finding: null, reason: "moderation response body was not valid JSON" };
    }

    const content = extractContent(body);
    if (content === null) {
      return { verdict: "error", finding: null, reason: "moderation response missing choices[0].message.content" };
    }

    return parseVerdict(content);
  } finally {
    clearTimeout(timer);
  }
}
