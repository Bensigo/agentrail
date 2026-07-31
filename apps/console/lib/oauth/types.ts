/**
 * OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`) — the
 * generic OAuth "seam": a per-provider exchange adapter interface, a
 * registration map (W3-T2's railway adapter and W3-T3's sentry adapter
 * self-register into this, mirroring `lib/evidence/registry.ts`'s own
 * `registerAdapter`/`adapterFor` precedent), and the env-config reader that
 * gates the whole feature.
 *
 * ARCHITECTURE (plan's own framing): OAuth is a token-MINTING mechanism
 * layered onto the existing connector system — it never changes how an
 * evidence adapter PRESENTS a credential upstream (still
 * `Authorization: Bearer <token>`); only credential ACQUISITION and STORAGE
 * differ from the existing token-paste path. This directory is the boundary
 * between "how do we get/refresh a token" (here) and "how do we use a
 * token" (`lib/evidence/*.ts`, unchanged in W3-T1, switched over in
 * W3-T2/T3 via `core.ts`'s `resolveProviderAuth`).
 *
 * REACHABILITY — a provider adapter module registers itself via
 * {@link registerOauthAdapter} at module load time; some importer must load
 * that module for the registration to ever take effect (ES modules only run
 * top-level code when actually imported into the reachable graph — the SAME
 * fact `lib/evidence/registry.ts`'s own doc-comment relies on, where
 * `runner/evidence/route.ts` imports every evidence adapter file for
 * exactly this reason). W3-T1 ships with an EMPTY registry (no railway/
 * sentry OAuth adapter exists yet) — `oauthAdapterFor` returns `null` for
 * every provider until W3-T2/T3 land, which is exactly the correct "no
 * visible change yet" state (see `oauthReady`'s own doc-comment in
 * `connector-helpers.ts`). When W3-T2/T3 add their adapter files, import
 * each from wherever `oauthAdapterFor`/`oauthConfigFor` is first needed at
 * runtime (the connectors GET route, and the link/callback routes below).
 */

/** The plain OAuth credential tuple — structurally identical to
 * `@agentrail/db-postgres`'s `OauthCredential` (`secret-envelope.ts`).
 * Duplicated rather than imported: this package depends on db-postgres,
 * never the reverse, and the shape is small enough that duplicating it here
 * keeps this directory's public surface self-contained (a caller reading
 * `types.ts` alone sees the whole contract, no cross-package hop needed). */
export interface OauthEnvelope {
  /** The bearer credential itself. */
  access: string;
  /** Used to mint a fresh `access` once it is within the expiry skew. */
  refresh: string;
  /** ISO-8601. */
  expiresAt: string;
}

export interface AuthorizeUrlInput {
  state: string;
  redirectUri: string;
}

export interface ExchangeInput {
  code: string;
  redirectUri: string;
  /**
   * Every OTHER query param the vendor's redirect carried, beyond
   * `state`/`code` (which the callback route already consumes itself). Exists
   * for Sentry's Public Integration flow (plan's verified vendor facts):
   * its install redirect carries `?code=&installationId=`, and ONLY the
   * Sentry adapter knows to read `params.installationId` — the generic
   * callback route stays provider-agnostic by forwarding the whole bag
   * rather than special-casing one vendor's extra param.
   */
  params: Record<string, string>;
}

/**
 * The seam every OAuth-capable provider implements — the ENTIRE surface a
 * new provider (W3-T2 railway, W3-T3 sentry) needs. Mirrors
 * `lib/evidence/registry.ts`'s `EvidenceAdapter` in spirit: one small
 * interface, a registration map, nothing else moves.
 */
export interface OauthProviderAdapter {
  /**
   * Matches a `ConnectorProvider` string (`"railway"`, `"sentry"`, …) —
   * loosely typed as `string` here (not `ConnectorProvider`) so this
   * directory never has to import `@agentrail/db-postgres`'s schema just for
   * a string union, mirroring `EvidenceAdapter.provider`'s own reasoning.
   * The routes that call `oauthAdapterFor` already know the provider is a
   * real `ConnectorProvider` from their own validation before they ever get
   * here.
   */
  provider: string;
  /** Builds the vendor's own authorize-screen URL for one authorize
   * attempt. Pure and synchronous — no network call, no I/O. */
  authorizeUrl(input: AuthorizeUrlInput): string;
  /** Exchanges a freshly-issued authorization code for a token envelope. */
  exchange(input: ExchangeInput): Promise<OauthEnvelope>;
  /** Mints a fresh envelope from a (possibly expiring/expired) one, using
   * its `refresh` token. */
  refresh(envelope: OauthEnvelope): Promise<OauthEnvelope>;
}

const registry = new Map<string, OauthProviderAdapter>();

/** Register a provider's OAuth adapter — called once at module load by each
 * provider's own adapter file (W3-T2/T3). Re-registering the same
 * `provider` slug replaces the prior adapter (last write wins), mirroring
 * `lib/evidence/registry.ts`'s `registerAdapter`. */
export function registerOauthAdapter(adapter: OauthProviderAdapter): void {
  registry.set(adapter.provider, adapter);
}

/** Look up a provider's registered OAuth adapter, or `null` if none is
 * registered. */
export function oauthAdapterFor(provider: string): OauthProviderAdapter | null {
  return registry.get(provider) ?? null;
}

export interface OauthEnvConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Read a provider's `<PROVIDER>_OAUTH_CLIENT_ID`/`<PROVIDER>_OAUTH_CLIENT_SECRET`
 * env pair (the plan's pinned env-gating convention — e.g. `railway` reads
 * `RAILWAY_OAUTH_CLIENT_ID`/`RAILWAY_OAUTH_CLIENT_SECRET`). `null` when
 * either is absent or empty — the sheet falls back to token-paste-only
 * (`oauthReady` stays false) and the authorize-link route 409s with a clear
 * message, never attempting a half-configured authorize request.
 */
export function oauthConfigFor(provider: string): OauthEnvConfig | null {
  const key = provider.toUpperCase();
  const clientId = process.env[`${key}_OAUTH_CLIENT_ID`];
  const clientSecret = process.env[`${key}_OAUTH_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
