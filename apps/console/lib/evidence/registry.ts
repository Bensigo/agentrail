import { EVIDENCE_VERBS, type EvidenceAdapter, type EvidenceVerb } from "./types";

/**
 * Evidence capability registry — the architectural heart of this layer (Task
 * 4 brief). Adding a future observability provider is exactly TWO changes:
 *
 *   1. A catalog entry declaring `capabilities.evidence: EvidenceVerb[]`
 *      (`connector-helpers.ts`'s `CONNECTOR_CATALOG`, e.g. Task 7's `railway`
 *      entry).
 *   2. An `EvidenceAdapter` that self-registers via {@link registerAdapter}
 *      when its module is imported.
 *
 * Nothing else moves: not the route (`app/api/v1/runner/evidence/route.ts`),
 * not `evidenceCapabilities`'s own logic below, not any Jace prompt/subagent.
 * `registry.test.ts`'s "a new provider = catalog entry + adapter, nothing
 * else" test is the standing proof of this — it registers a throwaway
 * `fakeobs` adapter and shows it becomes discoverable through nothing but the
 * two changes above.
 *
 * `evidenceCapabilities`'s catalog/connector-row parameters are DELIBERATELY
 * typed as minimal, structural shapes ({@link EvidenceCatalogEntry} /
 * {@link EvidenceConnectorRow}) rather than importing `ConnectorCatalogEntry`/
 * `ConnectorRowView` from `connector-helpers.ts` / `@agentrail/db-postgres`
 * directly. Two reasons: (1) it keeps this module decoupled from the specific
 * connector-catalog shape — the ONLY thing evidence capability derivation
 * needs from a catalog entry is `kind`/`availability`/`capabilities.evidence`,
 * so that is the ONLY thing it demands; (2) it is what makes the
 * architecture-preserving test possible at all — that test passes an ad hoc
 * `{ kind: "fakeobs", capabilities: { evidence: [...] } }` object literal
 * that does NOT satisfy the full `ConnectorCatalogEntry` interface (no
 * `type`/`connectMethod`/`label`/… — none of which evidence derivation
 * cares about). The real `CONNECTOR_CATALOG` (a `ConnectorCatalogEntry[]`) is
 * structurally a superset of `EvidenceCatalogEntry`, so it flows in
 * unchanged; the real `getConnectors(workspaceId)` result (`ConnectorRowView[]`)
 * is likewise a structural superset of `EvidenceConnectorRow[]`.
 */

/** The minimal shape `evidenceCapabilities` needs from a catalog entry — see the module doc-comment for why this is not `ConnectorCatalogEntry` itself. */
export interface EvidenceCatalogEntry {
  kind: string;
  /** `"internal"` short-circuits the credentialed check entirely — see below. Absent/`"available"`/`"planned"` all go through the normal enabled+hasSecret check. */
  availability?: string;
  /**
   * Task 6 fix: `"oauth"` changes WHICH connector-row fields count as
   * credentialed — see {@link evidenceCapabilities}'s own doc-comment for
   * why. Absent/`"secret"` (every provider before Task 6) keeps the
   * original enabled+hasSecret check untouched.
   */
  connectMethod?: string;
  capabilities?: {
    evidence?: EvidenceVerb[];
  };
}

/** The minimal shape `evidenceCapabilities` needs from a connector row — see the module doc-comment. `getConnectors(workspaceId)`'s `ConnectorRowView[]` satisfies this directly (it carries more fields, which is fine — a structural superset). */
export interface EvidenceConnectorRow {
  provider: string;
  enabled: boolean;
  hasSecret: boolean;
}

/**
 * Derive, per verb, which providers are BOTH declared (the catalog says this
 * provider can answer this verb) AND credentialed (the workspace has actually
 * connected it): `declared ∩ (enabled AND hasSecret)` — with two exceptions:
 *
 *   - `availability: "internal"` (Task 5's `factory`: an adapter over this
 *     console's OWN data, nothing to connect) short-circuits the check
 *     entirely and is always considered credentialed, needing no connector
 *     row at all.
 *   - `connectMethod: "oauth"` (Task 6 fix, first exercised by `github`): an
 *     oauth-connected provider's credential is NEVER a `connectors.secret`
 *     value — GitHub's is a per-installation token minted fresh per call
 *     (`getInstallationToken`, keyed off `workspaces.githubInstallationId`),
 *     so its connector row's `hasSecret` is structurally ALWAYS `false` (no
 *     call site ever calls `setConnectorSecret` for it — see
 *     `github.ts`'s own doc-comment and `connector-helpers.ts`'s
 *     `isConnected` helper, which already draws this same oauth/secret
 *     distinction for the connectors PAGE). Under the plain `enabled AND
 *     hasSecret` formula, an oauth provider could therefore NEVER be
 *     credentialed, no matter how thoroughly connected — a real gap between
 *     T4 (which only ever exercised secret-based/internal rows) and T6 (the
 *     first EXTERNAL oauth evidence provider). The fix: for an entry whose
 *     catalog `connectMethod` is `"oauth"`, `enabled` ALONE is the
 *     credentialed signal (the row existing and being enabled at all only
 *     happens once the workspace has actually connected the provider — see
 *     the row's own `upsertConnector(..., "github", { enabled: true })` call
 *     sites). `connectMethod: "secret"` (every provider before Task 6) and an
 *     absent `connectMethod` both keep the ORIGINAL enabled+hasSecret check
 *     untouched — this is a minimal, additive branch, not a rewrite.
 *
 * The result ALWAYS carries every {@link EvidenceVerb} as a key, even ones
 * with zero providers (`caps.probe` is `[]`, not absent) — "family-nested
 * from day one" per the brief, so a caller never has to guess whether an
 * empty array means "checked, nothing available" vs. "never checked."
 */
export function evidenceCapabilities(
  catalog: EvidenceCatalogEntry[],
  connectorRows: EvidenceConnectorRow[]
): Record<EvidenceVerb, string[]> {
  const rowByProvider = new Map(connectorRows.map((row) => [row.provider, row]));

  const result = {} as Record<EvidenceVerb, string[]>;
  for (const verb of EVIDENCE_VERBS) {
    result[verb] = [];
  }

  for (const entry of catalog) {
    const declaredVerbs = entry.capabilities?.evidence;
    if (!declaredVerbs || declaredVerbs.length === 0) continue;

    const row = rowByProvider.get(entry.kind);
    const credentialed =
      entry.availability === "internal" ||
      (entry.connectMethod === "oauth"
        ? Boolean(row?.enabled)
        : Boolean(row?.enabled && row?.hasSecret));
    if (!credentialed) continue;

    for (const verb of declaredVerbs) {
      result[verb].push(entry.kind);
    }
  }

  return result;
}

// ---- Adapter registration — a plain module-level Map. Adapters self-
// register by calling registerAdapter(...) as a side effect of their own
// module being imported (T5-T7 add `import "./factory"` etc. wherever the
// route needs them loaded); this file itself never imports any concrete
// adapter, keeping the registry generic. ----

const adapters = new Map<string, EvidenceAdapter>();

/** Register (or replace, by `provider` key — idempotent, last write wins) an adapter. */
export function registerAdapter(adapter: EvidenceAdapter): void {
  adapters.set(adapter.provider, adapter);
}

/** Look up a registered adapter by provider slug, or `null` if none is registered. */
export function adapterFor(provider: string): EvidenceAdapter | null {
  return adapters.get(provider) ?? null;
}
