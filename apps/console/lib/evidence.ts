/**
 * Bound + secret-scrub a raw log excerpt before it is persisted as failure
 * `evidence`.
 *
 * The runner reports its `logs_tail` verbatim in the result payload, so unlike
 * the Python producers (agentrail/run/evidence.py) that scrub before send, this
 * excerpt reaches us un-bounded and un-scrubbed. Evidence lands in a UI-facing
 * ClickHouse column and future LLM context, so we bound it here, at the write
 * boundary — the earliest place the console controls.
 *
 * Order mirrors the Python producer: keep only the last N lines (the tail is
 * where the error is), THEN scrub, THEN byte-cap. Scrubbing the line-bounded
 * tail before the byte cap guarantees the cap can never bisect a credential and
 * leak a fragment the detectors no longer recognise.
 */
import { scanForSecrets } from "./secret-scan";

export const EVIDENCE_MAX_LINES = 200;
export const EVIDENCE_MAX_BYTES = 16 * 1024;

export function boundEvidence(raw: string): string {
  if (!raw) return "";
  let lines = raw.split("\n");
  if (lines.length > EVIDENCE_MAX_LINES) {
    lines = lines.slice(-EVIDENCE_MAX_LINES);
  }
  const scrubbed = scanForSecrets(lines.join("\n")).redacted;
  const bytes = Buffer.from(scrubbed, "utf-8");
  if (bytes.length > EVIDENCE_MAX_BYTES) {
    return bytes.subarray(bytes.length - EVIDENCE_MAX_BYTES).toString("utf-8");
  }
  return scrubbed;
}
