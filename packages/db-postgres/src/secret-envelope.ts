/**
 * Secret envelope parsing (OAuth Connect Wave 3, W3-T1 —
 * `.superpowers/sdd/plan-oauth.md`). A sibling of `crypto.ts`, deliberately
 * NOT folded into it: `crypto.ts` owns symmetric encryption of the
 * `connectors.secret` column's PLAINTEXT (`encryptSecret`/`decryptSecret`,
 * unchanged by this task); this module owns interpreting what that
 * plaintext, once decrypted, actually IS. Different layer, different concern
 * — encryption doesn't care what's inside, this module never touches
 * ciphertext or `CONNECTOR_SECRET_KEY` at all (pure, no I/O, no env).
 *
 * STORAGE MODEL (pinned by the plan's Global Constraints): the EXISTING
 * `connectors.secret` column stores either shape, discriminated by structure
 * after decrypt — NO schema migration, NO new column:
 *
 *   - Legacy / token-paste (every provider before this wave, and railway/
 *     sentry's own token-paste fallback, forever): the raw credential
 *     string, verbatim (a plain token like `lin_api_…`, or a client-joined
 *     composite like `pk-lf-…:sk-lf-…` — see `lib/evidence/composite-secret.ts`).
 *   - OAuth: a JSON object `{"oauth":1,"access":"...","refresh":"...",
 *     "expiresAt":"<iso>"}`. The literal `oauth:1` field is the
 *     discriminator — a legacy value that HAPPENS to parse as JSON (e.g. a
 *     user mistakenly pasted `{"foo":"bar"}` as a token) is still `kind:
 *     "token"` unless it carries `oauth:1` AND every required string field,
 *     so this never guesses.
 *
 * `hasSecret`/masking/write-only semantics are UNCHANGED: `getConnectors`
 * still reports only `hasSecret: boolean` (`Boolean(row.secret)`), never
 * which kind is stored. Only server code that has already called
 * `getConnectorSecret` (decrypting) ever calls `parseSecretEnvelope`.
 */

/** The plain (unwrapped) OAuth credential tuple — what
 * `apps/console/lib/oauth/types.ts`'s `OauthEnvelope` is structurally
 * identical to (that package depends on this one, never the reverse, so the
 * shape is duplicated rather than imported — same reasoning
 * `lib/evidence/registry.ts` gives for its own minimal structural types). */
export interface OauthCredential {
  access: string;
  refresh: string;
  /** ISO-8601. */
  expiresAt: string;
}

export type ParsedSecret =
  | { kind: "token"; value: string }
  | { kind: "oauth"; credential: OauthCredential };

/** Serialize an OAuth credential into the pinned at-rest plaintext shape.
 * Callers pass the result to `encryptSecret` before `setConnectorSecret`
 * (mirrors `setConnectorSecret`'s own existing encrypt-at-write contract —
 * this function never encrypts anything itself). */
export function serializeOauthEnvelope(credential: OauthCredential): string {
  return JSON.stringify({
    oauth: 1,
    access: credential.access,
    refresh: credential.refresh,
    expiresAt: credential.expiresAt,
  });
}

/** Discriminate an already-decrypted `connectors.secret` plaintext. Never
 * throws — a value that isn't valid JSON, or is JSON but doesn't carry the
 * exact pinned oauth shape, is unconditionally `kind: "token"` (the ENTIRE
 * legacy fleet, every non-oauth provider, and any malformed value all take
 * this branch identically; a JSON-looking legacy value is not a special
 * case). */
export function parseSecretEnvelope(plaintext: string): ParsedSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { kind: "token", value: plaintext };
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as Record<string, unknown>).oauth === 1 &&
    typeof (parsed as Record<string, unknown>).access === "string" &&
    typeof (parsed as Record<string, unknown>).refresh === "string" &&
    typeof (parsed as Record<string, unknown>).expiresAt === "string"
  ) {
    const obj = parsed as { access: string; refresh: string; expiresAt: string };
    return {
      kind: "oauth",
      credential: { access: obj.access, refresh: obj.refresh, expiresAt: obj.expiresAt },
    };
  }

  return { kind: "token", value: plaintext };
}
