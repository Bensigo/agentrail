import { createHash } from "crypto";
import { appendEvidenceItem } from "@agentrail/db-postgres";
import { boundEvidence, EVIDENCE_MAX_BYTES, EVIDENCE_MAX_LINES } from "../evidence";
import { scanForSecrets } from "../secret-scan";
import type { EvidenceEnvelope, EvidenceQuery } from "./types";

/**
 * Capture one adapter's raw evidence into a durable, tamper-evident
 * `investigation_items` row and the {@link EvidenceEnvelope} handed back to
 * the caller — the ONE seam every evidence write goes through (Task 4 brief;
 * Global Constraints: "the evidence route is the only writer of `kind:
 * 'evidence'` items", which holds because THIS is the only caller of
 * `appendEvidenceItem` outside `queries/investigations.ts` itself).
 *
 * The envelope order is PINNED (brief, "Decisions already made" — do not
 * reorder):
 *
 *   1. `scanForSecrets(raw).redacted`     — scrub BEFORE any capping, so a
 *      credential straddling where the 200-line/16KB cap would later cut
 *      can never leave a live fragment on either side of the cut.
 *   2. `boundEvidence(...)`               — apply `lib/evidence.ts`'s own
 *      caps (last 200 lines, ≤16KB) to the ALREADY-redacted text. This
 *      REUSES that file's exact caps/constants rather than redefining them
 *      (Global Constraints) — see that file's own doc-comment for why it
 *      re-scrubs internally too (line-cap → scrub → byte-cap, so the byte
 *      cap can never bisect a credential the line-cap left behind); doing
 *      our own scrub first is not redundant with that — it additionally
 *      protects the identical safety property for the case where the
 *      LINE-DROPPED portion is what carried a secret humans should not have
 *      to trust silent truncation to hide (defense in depth, not just a
 *      second pass over what the first already caught).
 *   3. `sha256` digest of the CAPPED excerpt (not the raw, not the
 *      pre-cap redacted text) — so the digest is verifiable against exactly
 *      what a reader sees.
 *   4. `appendEvidenceItem` persists `{ body: excerpt, data: { provider,
 *      verb, query, digest, capturedAt, truncated } }` — the ONLY function
 *      allowed to write `kind: 'evidence'` (Task 2's own doc-comment).
 *   5. Return the {@link EvidenceEnvelope}, `ref` = the persisted item's id.
 *
 * `truncated` is computed HERE, independently — `boundEvidence` returns a
 * bare string with no signal of whether it actually cut anything, so this
 * checks the SAME redacted-but-uncapped text against `lib/evidence.ts`'s own
 * exported thresholds (mirroring, not redefining, its two cap conditions)
 * before capping.
 */
export async function captureEvidence(
  investigationId: string,
  provider: string,
  q: EvidenceQuery,
  raw: string
): Promise<EvidenceEnvelope> {
  const redacted = scanForSecrets(raw).redacted;

  const lineCount = redacted === "" ? 0 : redacted.split("\n").length;
  const byteLength = Buffer.byteLength(redacted, "utf-8");
  const truncated = lineCount > EVIDENCE_MAX_LINES || byteLength > EVIDENCE_MAX_BYTES;

  const excerpt = boundEvidence(redacted);
  const digest = createHash("sha256").update(excerpt, "utf-8").digest("hex");
  const capturedAt = new Date().toISOString();

  const { id } = await appendEvidenceItem(investigationId, {
    body: excerpt,
    data: {
      provider,
      verb: q.verb,
      query: q,
      digest,
      capturedAt,
      truncated,
    },
  });

  return {
    ref: id,
    provider,
    verb: q.verb,
    query: q,
    capturedAt,
    excerpt,
    digest,
    truncated,
  };
}
