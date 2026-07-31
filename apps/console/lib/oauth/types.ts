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
 * exactly this reason). W3-T1 shipped with an EMPTY registry (no railway/
 * sentry OAuth adapter existed yet); W3-T2 registers `railway` (imported as
 * a side effect wherever `oauthAdapterFor`/`oauthConfigFor` is first needed
 * at runtime — the connectors GET route, and the link/callback routes
 * below); W3-T3 does the same for `sentry`.
 *
 * PKCE + POST-EXCHANGE (W3-T2 fix round, independent review — see
 * `.superpowers/sdd/review-W3T2.md`): two ADDITIVE extensions to the seam
 * below, both optional so neither breaks a hypothetical future adapter that
 * doesn't need them:
 *   - {@link AuthorizeUrlInput.codeChallenge} / {@link ExchangeInput.codeVerifier}
 *     thread a PKCE (RFC 7636) code_verifier/code_challenge pair through
 *     the generic link/callback routes — the CRYPTO itself lives in
 *     `./pkce.ts` (provider-agnostic, reused by any future adapter that
 *     wants it; Cloudflare's own OAuth, a documented future phase, REQUIRES
 *     PKCE, so this is built shared rather than Railway-specific).
 *   - {@link OauthProviderAdapter.postExchange} is a post-exchange gate the
 *     callback route runs after `exchange()` succeeds but before
 *     persisting, giving a provider whose grant is itself RESOURCE-scoped
 *     (Railway's `project:viewer`, which lets the user pick which
 *     project(s) to share on the VENDOR's own consent screen, independently
 *     of this workspace's stored config) a chance to catch — and where
 *     possible, resolve — a mismatch before the connector goes live. See
 *     `lib/oauth/railway.ts`'s own doc-comment for the concrete a/b/c
 *     behavior this exists to support, and `redirect.ts`'s
 *     `project_not_granted` reason for how a caught mismatch surfaces.
 */

// `import type` only — erased at compile time, so this adds no runtime
// dependency (a test mocking this module's own exports is unaffected) even
// though `redirect.ts` now supplies `PostExchangeResult`'s failure reason
// type below.
import type { OauthErrorReason } from "./redirect";

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
  /**
   * PKCE (RFC 7636, W3-T2 fix round) — the S256 `code_challenge` derived
   * from a `code_verifier` the link route mints and stores alongside
   * `state` (`./pkce.ts`'s `generateCodeVerifier`/`computeCodeChallengeS256`,
   * `mintConnectorOauthState`'s optional 4th argument). ALWAYS populated by
   * the link route (mirrors `ExchangeInput.params` always being populated
   * regardless of whether a specific adapter reads it) — an adapter that
   * doesn't use PKCE simply never reads this field, same as Railway's own
   * `exchange()` ignoring `ExchangeInput.params`. Optional on the TYPE
   * (not every hypothetical caller — e.g. a test constructing this input
   * directly — need supply one) even though the real link route always
   * does in practice.
   */
  codeChallenge?: string;
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
  /**
   * PKCE (RFC 7636, W3-T2 fix round) — the ORIGINAL `code_verifier` the
   * link route minted for this attempt
   * (`consumeConnectorOauthState`'s `codeVerifier` return field), handed
   * back so an adapter that sent `code_challenge` at authorize time can
   * complete the proof at exchange time. `undefined`/absent for a state
   * that predates this fix round, or for a provider whose adapter never
   * requested PKCE in the first place — an adapter that requires it
   * (Railway) treats an absent value as its own bug, not a silent skip; see
   * `lib/oauth/railway.ts`'s own doc-comment.
   */
  codeVerifier?: string;
}

/** Input to {@link OauthProviderAdapter.postExchange} — W3-T2 fix round. */
export interface PostExchangeInput {
  /** The freshly-exchanged (not yet persisted) envelope — an adapter's
   * postExchange may use `envelope.access` to make its own read-only
   * verification call (e.g. Railway lists the projects the grant covers). */
  envelope: OauthEnvelope;
  /**
   * The provider's CURRENT stored config (a client-safe `ConnectorRowView`
   * `config` view — whatever `getConnector` returns, `{}` if the row
   * doesn't exist yet), so the adapter can compare what the vendor's grant
   * actually covers against what the workspace already has configured
   * (e.g. Railway's `railwayProjectId`). Loosely typed (`Record<string,
   * unknown>`, not `ConnectorConfig`) so this package never has to import
   * `@agentrail/db-postgres`'s schema just for this one field's shape —
   * same reasoning `OauthProviderAdapter.provider`'s own doc-comment gives
   * for staying `string`, not the stricter `ConnectorProvider`.
   */
  config: Record<string, unknown>;
}

/**
 * Result of {@link OauthProviderAdapter.postExchange} — W3-T2 fix round.
 * `configPatch`, when present, is merged into the connector's config
 * (`upsertConnector`, which itself goes through `completeConfig` — the
 * SAME preserve-list machinery that already protects the ephemeral oauth
 * state keys applies here too, so this patch can never accidentally wipe
 * them). `reason` on failure is the SAME closed `OauthErrorReason` set the
 * callback route's every other failure branch already reports through
 * (`./redirect.ts`) — deliberately reused, not a second vocabulary.
 */
export type PostExchangeResult =
  | { ok: true; configPatch?: Record<string, string> }
  | { ok: false; reason: OauthErrorReason };

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
  /**
   * OPTIONAL (W3-T2 fix round, additive) — a post-exchange gate the
   * callback route runs immediately after `exchange()` succeeds, BEFORE
   * persisting the envelope (`setConnectorSecret`). Absent for a provider
   * whose OAuth scope isn't itself resource-scoped (nothing to reconcile
   * against the workspace's own stored config). See this interface's own
   * doc-comment ("PKCE + POST-EXCHANGE") and `PostExchangeResult`'s
   * doc-comment for the full contract. Throwing is treated by the callback
   * route exactly like a thrown `exchange()` — an unexpected failure here
   * (e.g. this adapter's OWN verification call erroring) fails the whole
   * connect attempt closed (`exchange_failed`), never silently skips the
   * check this method exists to make possible.
   */
  postExchange?(input: PostExchangeInput): Promise<PostExchangeResult>;
  /**
   * OPTIONAL, additive (W3-T3 fix round — coordinator ruling on the
   * state-round-trip finding, `.superpowers/sdd/task-W3T3-report.md`).
   * `"param"` (the default when absent — every provider before this one,
   * and Railway explicitly): the vendor round-trips the server-minted
   * `state` on its redirect; the callback route resolves which workspace a
   * hit belongs to by consuming that exact single-use token
   * (`consumeConnectorOauthState`). `"session"` (Sentry, so far the only
   * one): the vendor's redirect CANNOT carry `state` at all (doc-confirmed
   * absence for Sentry's Public Integration flow — see `lib/oauth/
   * sentry.ts`'s own doc-comment) — the callback instead resolves the
   * pending record by the REDEEMING SESSION's own user id
   * (`consumeConnectorOauthStateBySessionUser`, `@agentrail/db-postgres`),
   * requiring EXACTLY ONE unexpired pending record for
   * (provider, session.user.id) across every workspace; zero or multiple
   * is closed `state_invalid`, nothing consumed either way. See the
   * callback route's own doc-comment ("SESSION-TRANSPORT CSRF ANALYSIS")
   * for why this is CSRF-equivalent to the param-transport mechanism, not
   * a weaker substitute forced by necessity. The link route mints the SAME
   * state-record shape either way (`mintConnectorOauthState`, unchanged);
   * a `"session"` provider's link-time mint is additionally preceded by
   * `clearPendingConnectorOauthStatesForUser` (last-mint-wins per
   * (user, provider) across workspaces — bounded, since pending records
   * are rare and TTL'd) and its `authorizeUrl()` simply never embeds the
   * `state` input it's still (harmlessly) handed, mirroring how a
   * `"param"` adapter is free to ignore `ExchangeInput.params`.
   */
  stateTransport?: "param" | "session";
  /**
   * OPTIONAL, additive (W3-T3 fix round) — whether this provider's OWN
   * extra, provider-specific env vars (beyond the generic
   * `oauthConfigFor`-checked `<PROVIDER>_OAUTH_CLIENT_ID`/
   * `_CLIENT_SECRET` pair every provider already needs) are set. Absent →
   * treated as `true` (no extra requirement — every provider before Sentry
   * needs nothing beyond the generic pair). Sentry declares one
   * (`SENTRY_OAUTH_INTEGRATION_SLUG`, needed to build the external-install
   * URL) — see `lib/oauth/sentry.ts`'s own `envReady`. Read by the
   * connectors GET route's `oauthReady` derivation and the link route's
   * env-gate, ALONGSIDE (never instead of) `oauthConfigFor` — kept generic/
   * adapter-driven rather than a provider name hardcoded into either
   * shared route, mirroring this whole interface's own "additive adapter
   * capability" pattern (`postExchange`, `stateTransport` above).
   */
  envReady?(): boolean;
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
