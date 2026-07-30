/**
 * Composite secret splitting (Task P0, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`) — the generic mechanism a two-part
 * credential (Langfuse `pk-lf-…:sk-lf-…`, Datadog `apiKey:appKey`,
 * Prometheus `user:pass`, …) is stored and read back through.
 *
 * AgentRail's `connectors.secret` column is a SINGLE text column — one
 * encrypted credential per provider (`packages/db-postgres/src/schema/
 * connectors.ts`). A provider needing two (or more) parts stores them
 * joined by a literal `:` (client-side, before the PUT — see
 * `connectors-panel.tsx`'s `SecretManage`) and THIS module is the single
 * place that joined string is split back apart, server-side.
 *
 * A catalog entry opts in by declaring `connect.secretParts` — display
 * metadata only (e.g. `[{name:"Public key"},{name:"Secret key"}]`), read by
 * `connectors-panel.tsx` to render one password input per part and by
 * `validateConnectorCredential`'s generic per-part pattern check
 * (`connector-helpers.ts`). An entry that declares none is a plain
 * single-secret provider, and `splitCompositeSecret` is a harmless
 * passthrough (`parts: [secret]`, never splitting on `:`) — every provider
 * shipped before this wave (linear/figma/context7/railway) takes this
 * branch, unchanged.
 *
 * Consumers: `verify.ts` (splits before dispatching to a provider's live
 * verifier — see that module's own doc-comment) and `connector-helpers.ts`'s
 * `validateConnectorCredential` (splits before running `secretPartPatterns`).
 * A future adapter (P2-P8, `apps/console/lib/evidence/*.ts`) that reads a
 * composite secret back via `getConnectorSecret` imports this module
 * directly too, so the split logic is written and tested in exactly ONE
 * place — never re-derived per provider.
 *
 * A raw part value containing the delimiter itself (`:`) is guarded
 * TWICE: `connectors-panel.tsx`'s submit handler rejects a part containing
 * `:` BEFORE joining, client-side (the primary gate); server-side, this
 * function's own PART-COUNT check (see {@link SplitCompositeSecretResult}'s
 * failure case) catches it independently — an extra `:` produces MORE split
 * parts than declared, which fails the count check loudly (`Expected N
 * parts, got N+1`), not a silent misparse. The only way this module could
 * misparse a smuggled colon is the narrow, coincidental case where a missing
 * `:` in one part and an extra `:` in another cancel out and the total count
 * happens to still match — a known, accepted residual risk given the
 * client-side gate already covers the general case; not a TODO.
 */

/**
 * Minimal shape `splitCompositeSecret` needs — structurally satisfied by a
 * catalog entry's `connect` object (`ConnectorConnectMeta`) or a synthetic
 * `{ secretParts: [...] }` in a test — so this module never has to import
 * `connector-helpers.ts` (keeping it a leaf, dependency-free utility usable
 * from routes, the pure model, and future adapters alike).
 */
export interface CompositeSecretSpec {
  secretParts?: Array<{ name: string }>;
}

export type SplitCompositeSecretResult =
  | { ok: true; parts: string[] }
  | { ok: false; error: string };

/**
 * Split `secret` into its declared parts.
 *
 * No `secretParts` (or an empty array) → single-secret passthrough:
 * `{ ok: true, parts: [secret] }`, the raw secret untouched (never split on
 * `:`, so an unrelated colon in a plain single-part token — none exist
 * today, but nothing here would break if one did — is never misinterpreted).
 *
 * Declared → splits `secret` on `:`; the resulting part COUNT must match
 * `secretParts.length` exactly, and every part must be non-empty after
 * trimming. Each returned part is trimmed.
 */
export function splitCompositeSecret(
  spec: CompositeSecretSpec,
  secret: string
): SplitCompositeSecretResult {
  const partSpecs = spec.secretParts ?? [];
  if (partSpecs.length === 0) {
    return { ok: true, parts: [secret] };
  }

  const parts = secret.split(":").map((p) => p.trim());
  if (parts.length !== partSpecs.length) {
    return {
      ok: false,
      error: `Expected ${partSpecs.length} parts (${partSpecs
        .map((p) => p.name)
        .join(", ")}), got ${parts.length}.`,
    };
  }

  const emptyIdx = parts.findIndex((p) => p.length === 0);
  if (emptyIdx !== -1) {
    return { ok: false, error: `${partSpecs[emptyIdx].name} must not be empty.` };
  }

  return { ok: true, parts };
}
