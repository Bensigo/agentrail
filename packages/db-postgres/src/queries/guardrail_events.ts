import { createHash } from "node:crypto";
import { db } from "../db.js";
import {
  guardrailEvents,
  type GuardrailEventCategory,
  type GuardrailEventDetector,
  type GuardrailEventVerdict,
  type GuardrailMatchType,
} from "../schema/guardrail_events.js";

/**
 * The ONLY writer of `guardrail_events` (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
 *
 * Called by `apps/console/lib/channel-dispatch.ts` once per guardrail finding,
 * immediately before it decides whether the Eve turn runs.
 *
 * NEVER THROWS, and never returns a rejected promise. This is deliberate and
 * load-bearing: the caller sits inside `processRow`, whose documented
 * invariant is "never kill the loop". An audit write that threw would turn a
 * *successfully guarded* message into a failed inbox row, which then requeues
 * and replays. Losing an audit row is bad; losing the drain loop is worse. A
 * write failure is logged and swallowed, and the guardrail decision the caller
 * already made stands regardless.
 *
 * The caller passes the message text ONLY so this function can hash it —
 * `hashContent` runs here and the plaintext never reaches a column. See the
 * schema doc-comment for why storing it would defeat the PII layer.
 */
export interface RecordGuardrailEventInput {
  /** Null on the intro path — a stranger with no workspace resolved yet. */
  workspaceId?: string | null;
  /** Null for console rows, which are anchored by workspace + member instead. */
  chatIdentityId?: string | null;
  channel: string;
  conversationKey: string;
  category: GuardrailEventCategory;
  verdict: GuardrailEventVerdict;
  detector: GuardrailEventDetector;
  /** Human-readable. Must never quote the matched text. */
  reason?: string;
  matchTypes?: GuardrailMatchType[];
  /**
   * The NORMALIZED message. Hashed here and discarded — never stored.
   * Callers pass the same normalized string the detectors screened, so the
   * digest is stable for a given payload no matter which layer reports it.
   */
  normalizedText: string;
}

/** Hex SHA-256 of the normalized message — the only representation of the text that persists. */
export function hashContent(normalizedText: string): string {
  return createHash("sha256").update(normalizedText, "utf8").digest("hex");
}

export async function recordGuardrailEvent(
  input: RecordGuardrailEventInput
): Promise<{ recorded: boolean }> {
  try {
    await db.insert(guardrailEvents).values({
      workspaceId: input.workspaceId ?? null,
      chatIdentityId: input.chatIdentityId ?? null,
      channel: input.channel,
      conversationKey: input.conversationKey,
      category: input.category,
      verdict: input.verdict,
      detector: input.detector,
      reason: input.reason ?? "",
      matchTypes: input.matchTypes ?? [],
      contentSha256: hashContent(input.normalizedText),
    });
    return { recorded: true };
  } catch (err) {
    // Swallowed on purpose — see the doc-comment above. Log the error only;
    // `input` carries the raw message and must never be logged.
    console.error(
      "[guardrail-events] audit write failed (guardrail decision still stands):",
      err instanceof Error ? err.message : String(err)
    );
    return { recorded: false };
  }
}
