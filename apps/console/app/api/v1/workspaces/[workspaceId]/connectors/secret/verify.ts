import {
  CONNECTOR_CATALOG,
  type ConnectorCatalogEntry,
  type ConnectorKind,
} from "../../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { splitCompositeSecret } from "../../../../../../../lib/evidence/composite-secret";

/**
 * Live credential verification (server-only) — "don't save a wrong key".
 *
 * Format validation (connector-helpers) is the cheap first gate; this is the real
 * one: it calls the provider with the supplied credential and only lets a key
 * through if the provider actually accepts it. A clear auth rejection (the key is
 * wrong) is reported back to the user; a transient network failure is also
 * rejected (we never store an unverified credential) with a retry hint.
 *
 * Verified live: Linear (GraphQL `viewer`), Figma (`/v1/me`), Railway (Task 7
 * — GraphQL `me`), Langfuse (Task P2 — `GET /api/public/projects`), Sentry
 * (Task P3 — `GET /api/0/projects/{org}/{project}/`), Datadog (Task P4 —
 * `GET /api/v2/validate_keys`), Prometheus (Task P5 — a documented fallback
 * chain: buildinfo → `/-/ready` → a trivial instant query), Grafana (Task P6
 * — `GET /api/org`, confirmed the one endpoint of the two candidates that
 * actually accepts a service account token), Vercel (Task P7 —
 * `GET /v2/user` unconditionally, ADDITIONALLY `GET /v9/projects/{id}` when
 * a project id is present), Cloudflare (Task P8 — `GET
 * /client/v4/user/tokens/verify`, needs no config at all). Context7 stays
 * format-only here — it has no stable side-effect-free check; its
 * format gate already rejects malformed values. Discord/Slack/Telegram are
 * no longer credential-based (Gateway → Channels cutover): `secret/route.ts`'s
 * allowlist rejects them before a call ever reaches this module. The
 * `default` case below still answers `{ok:true}` for them so this function
 * stays total over every `ConnectorKind`, but that path is unreachable
 * through the route today.
 *
 * RAILWAY (Task 7): confirmed against Railway's public API docs
 * (https://docs.railway.com/integrations/api,
 * https://docs.railway.com/reference/public-api — both fetched during
 * implementation) rather than trusted from memory, per the task's mandatory
 * first step:
 *   - Endpoint: `POST https://backboard.railway.com/graphql/v2`.
 *   - Auth: `Authorization: Bearer <token>`.
 *   - The docs' own canonical minimal verification query is
 *     `query { me { name email } }` — NOT `query { me { id } }`. Both fetched
 *     pages show the exact same worked example, and Railway also states this
 *     query "cannot be used with a workspace or project token because the
 *     data returned is scoped to your personal account" (a caveat worth
 *     keeping in mind if a future Team-scoped-only token ever fails this
 *     check). Docs govern over the originally-assumed `{ id }` shape.
 *   - A GraphQL error body (`{"errors":[...]}`, HTTP 200) is treated as
 *     rejection — Railway, like most GraphQL servers, does not always signal
 *     an invalid-token query with a non-2xx status.
 *
 * CLOUDFLARE (Task P8, Evidence Providers Wave 2 — FINAL provider):
 * confirmed against Cloudflare's own docs during implementation (this
 * task's mandatory first step), not trusted from memory — see
 * `lib/evidence/cloudflare.ts`'s own doc-comment for the full doc-verify
 * trail (token-format prefixes, the GraphQL dataset names/fields, the
 * `$zoneTag: string`/`$filter: filter` custom-scalar quirk, rate limits).
 * This module's own concern is narrower: the live-verify endpoint.
 *   - `GET https://api.cloudflare.com/client/v4/user/tokens/verify` —
 *     confirmed, current. Response: `{success, result:{id,
 *     status:"active"|"disabled"|"expired", …}, errors, messages}`.
 *     Genuinely validates the TOKEN ITSELF, independent of what it's
 *     scoped to — works unmodified for a ZONE-scoped token (this task's
 *     own "does it work with zone-scoped tokens" question), since it only
 *     ever resolves the token's own identity/status, never anything about
 *     its granted scope. NEEDS NO CONFIG (this task's own pinned
 *     expectation, confirmed) — unlike Langfuse/Sentry/Datadog/Prometheus/
 *     Grafana above, this is the SECOND Wave-2 provider (after Vercel's own
 *     UNCONDITIONAL token leg) whose verify call needs no
 *     not-yet-persisted config value at all, so `verifyCloudflare` below
 *     takes no `config` parameter — mirrors `verifyLinear`'s/
 *     `verifyFigma`'s/`verifyRailway`'s identical no-config shape, not the
 *     `config`-threading shape every OTHER Wave-2 provider needed.
 *   - `success: true` ALONE is NOT sufficient: the documented `status` enum
 *     includes `"disabled"`/`"expired"` alongside `"active"` — a disabled
 *     or expired token can still return a well-formed, successful response
 *     body. `verifyCloudflare` checks `success === true && result.status
 *     === "active"` so a technically-valid-but-unusable token is correctly
 *     rejected rather than stored.
 *
 * LANGFUSE (Task P2, Evidence Providers Wave 2): confirmed against Langfuse's
 * own docs during implementation (`langfuse.com/docs/api-and-data-platform/
 * features/public-api`, cross-checked with a live GitHub discussion + the
 * `fern/apis/server/definition/*.yml` API source files) rather than trusted
 * from memory:
 *   - Auth: HTTP Basic, public key as username, secret key as password — the
 *     docs' own worked example is
 *     `curl -u public-key:secret-key https://cloud.langfuse.com/api/public/projects`.
 *   - `GET {host}/api/public/projects` is exactly that worked example — a
 *     side-effect-free, real-project-scoped read, confirmed rejecting an
 *     ORGANIZATION-scoped key with "Invalid API key" (so it genuinely
 *     exercises the project-scoped public/secret pair this connector stores,
 *     not some other credential shape).
 *
 * LANGFUSE HOST — THE ORDERING GAP (Task P2, flagged for reviewer
 * adjudication — see the task report's own Concerns section): Langfuse has
 * no single global API host (cloud has multiple regions, e.g.
 * `cloud.langfuse.com` / `jp.cloud.langfuse.com`, and self-host is a fully
 * custom origin), so THIS live-verify call needs the workspace's own
 * `config.langfuseHost` — a catalog `extraConfigFields` value. But
 * `connectors-panel.tsx`'s `SecretManage.save()` PUTs the secret BEFORE the
 * extra-config fields (the config PUT only runs once the secret PUT already
 * succeeded), so at THIS point in a brand-new connect, no `langfuseHost` has
 * been persisted yet — `verifyConnectorCredential`'s existing signature
 * (`kind, secret, catalog`) has nothing to read it from. Rather than either
 * (a) reordering the two PUTs (a bigger, riskier behavior change to
 * shared "connect-form machinery"), or (b) skipping live-verify for
 * Langfuse entirely (violates this task's own pinned "Live verify in
 * verify.ts" decision), the fix is the SMALLEST generic extension: this
 * function gains an OPTIONAL 4th `config` parameter — the SAME request's
 * extra-config values, read generically off the request body by
 * `secret/route.ts` (via the already-catalog-derived `extraConfigFieldKeys`,
 * Task P0) and passed straight through, never persisted by this route (the
 * dedicated config PUT, unchanged, remains the sole persistence path — see
 * `connectors-panel.tsx`'s own note at its `save()` callback). Every
 * existing call site (none pass a 4th argument) is behavior-identical.
 * Because this value is UNVALIDATED raw client input at this point (the
 * scheme-gate `validateUrlConfigString`, `packages/db-postgres/src/queries/
 * connectors.ts`, only ever runs on the SEPARATE, later config PUT),
 * `resolveHttpUrl` below re-applies the SAME http/https scheme gate
 * defensively before this module ever hands it to `fetch` — never trusting
 * that the client-supplied value is well-formed. This same `config`
 * parameter is intended to generalize to P4/P5/P6 (Datadog/Prometheus/
 * Grafana), whose verify endpoints have the identical "needs a not-yet-
 * persisted host/site" shape.
 *
 * SENTRY (Task P3, Evidence Providers Wave 2): confirmed against Sentry's
 * own docs and source during implementation (this task's mandatory first
 * step), not trusted from memory:
 *   - Auth: `Authorization: Bearer <token>` (docs.sentry.io/api/auth/).
 *   - Verify endpoint: `GET /api/0/projects/{org}/{project}/` — chosen over
 *     the plan's own believed org-only shape
 *     (`GET /api/0/organizations/{org}/`, also confirmed real and
 *     side-effect-free) because this one validates BOTH the org AND the
 *     SPECIFIC connected project (and the token's access to it) in one
 *     side-effect-free call, for the same one-request cost — exactly what
 *     the task's own brief prefers ("prefer one that also validates the
 *     project if cheap"). Confirmed statuses: 200 success, 403 forbidden,
 *     404 not found (docs.sentry.io/api/projects/retrieve-a-project/); 401
 *     is handled defensively alongside 403 here too, mirroring every
 *     sibling verify function's dual-status handling, even though this
 *     specific page's fetched content only explicitly showed 403/404.
 *   - Needs BOTH `config.sentryOrg` AND `config.sentryProject` — the SAME
 *     "not yet persisted at verify-time" ordering gap Langfuse hit first
 *     (see "LANGFUSE HOST — THE ORDERING GAP" above); this function reuses
 *     the identical `config` pass-through mechanism, reading two keys
 *     instead of one. Missing EITHER value fails closed with a distinct,
 *     actionable error (checked org-first, matching the catalog's own
 *     `extraConfigFields` declaration order) rather than guessing or
 *     silently probing the org-only endpoint as a fallback.
 *
 * DATADOG (Task P4, Evidence Providers Wave 2): confirmed against Datadog's
 * own docs during implementation (this task's mandatory first step), not
 * trusted from memory:
 *   - Auth: `DD-API-KEY: <apiKey>` + `DD-APPLICATION-KEY: <appKey>` on every
 *     read (docs.datadoghq.com/api/latest/authentication/).
 *   - Verify endpoint: `GET /api/v2/validate_keys` — chosen over the plan's
 *     believed `GET /api/v1/validate`, which a docs search confirms
 *     validates the API key ONLY, never exercising the application key —
 *     `/api/v2/validate_keys`'s own docs state it checks "that the API key
 *     and application key used for the request are both valid," the
 *     cheapest confirmed read that genuinely exercises BOTH stored parts.
 *     Response `{"status":"ok"}` on success.
 *   - Needs `config.datadogSite` — the SAME "not yet persisted at
 *     verify-time" ordering gap Langfuse/Sentry hit first (see "LANGFUSE
 *     HOST — THE ORDERING GAP" above); reuses the identical `config`
 *     pass-through mechanism. UNLIKE `langfuseHost` (scheme-gated
 *     generically by `validateUrlConfigString` at write time), `datadogSite`
 *     is only ever a bare `validateSimpleConfigString` value (confirmed by
 *     reading `packages/db-postgres/src/queries/connectors.ts` directly) —
 *     it becomes part of a `fetch` URL here just like `langfuseHost` does,
 *     so this module validates it against the SAME documented-site
 *     allowlist `lib/evidence/datadog.ts`'s own `resolveDatadogSite`
 *     enforces (duplicated rather than imported — this module stays a leaf,
 *     the same independence `resolveHttpUrl` above already has from
 *     `packages/db-postgres`'s own URL validator). A site not on the
 *     allowlist (missing, garbled, or a malicious value) fails closed with
 *     the same actionable error as an absent one.
 */

export type VerifyResult = { ok: true } | { ok: false; error: string };

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Linear: a valid personal API key resolves `viewer` over GraphQL. */
async function verifyLinear(key: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Linear rejected this API key." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Linear (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { viewer?: { id?: string } };
      errors?: unknown;
    };
    if (body?.data?.viewer?.id) return { ok: true };
    return { ok: false, error: "Linear rejected this API key." };
  } catch {
    return { ok: false, error: "Couldn't reach Linear to verify the key — try again." };
  }
}

/** Figma: a valid token resolves the current user via `/v1/me`. */
async function verifyFigma(token: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout("https://api.figma.com/v1/me", {
      headers: { "X-Figma-Token": token },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Figma rejected this access token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Figma (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Figma to verify the token — try again." };
  }
}

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** Railway: a valid Account/Team token resolves `me` over GraphQL — see this
 * module's own doc-comment ("RAILWAY (Task 7)") for the doc-confirmed query
 * shape and why `{ name email }`, not the originally-assumed `{ id }`. */
async function verifyRailway(token: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: "query { me { name email } }" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Railway rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Railway (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { me?: { name?: string; email?: string } };
      errors?: unknown;
    };
    // A GraphQL error body rides on HTTP 200 — treated as rejection (see
    // this module's own doc-comment). A valid token resolves at least one
    // of the two requested scalar fields.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return { ok: false, error: "Railway rejected this token." };
    }
    if (body?.data?.me?.email || body?.data?.me?.name) return { ok: true };
    return { ok: false, error: "Railway rejected this token." };
  } catch {
    return { ok: false, error: "Couldn't reach Railway to verify the token — try again." };
  }
}

/** Defensively re-validate an untrusted `config.langfuseHost` value at
 * verify-time — see this module's own doc-comment ("LANGFUSE HOST — THE
 * ORDERING GAP") for why this value has NOT yet passed
 * `validateUrlConfigString`. Mirrors that function's own scheme-only gate
 * (parse via `new URL()`, require `http:`/`https:`) rather than importing
 * it — `packages/db-postgres/src/queries/connectors.ts` does not export it,
 * and this module stays a leaf (no db-postgres dependency for a five-line
 * check). Returns the trimmed, de-slashed origin+path string on success, or
 * `null` for anything missing/malformed. */
function resolveHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed.replace(/\/+$/, "");
}

/** Langfuse: a valid public/secret key pair resolves the CURRENT project via
 * `GET {host}/api/public/projects` — see this module's own doc-comment
 * ("LANGFUSE (Task P2)") for the confirmed endpoint/auth shape, and
 * ("LANGFUSE HOST — THE ORDERING GAP") for why `config` (not yet a
 * persisted connector row) is where `langfuseHost` comes from here. No host
 * (missing, or present but not a valid http/https URL) fails closed with a
 * clear, actionable error rather than guessing a default region — Langfuse
 * cloud regions and self-host origins are DIFFERENT deployments with
 * different projects; guessing would produce a confusing false rejection
 * for a real, well-formed key pair scoped to the "wrong" (unguessed) host. */
async function verifyLangfuse(
  publicKey: string,
  secretKey: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  const host = resolveHttpUrl(config?.langfuseHost);
  if (!host) {
    return { ok: false, error: "Set the Langfuse host before connecting." };
  }
  try {
    const res = await fetchWithTimeout(`${host}/api/public/projects`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Langfuse rejected these API keys." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Langfuse (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Langfuse to verify the keys — try again." };
  }
}

/** A trimmed, non-empty string, or `null` — a plainer sibling of
 * {@link resolveHttpUrl} for the two Sentry config values, neither of which
 * is URL-shaped (org/project slugs), so no scheme parsing applies. */
function resolveNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Sentry: a valid org/user auth token resolves the CONNECTED project via
 * `GET /api/0/projects/{org}/{project}/` — see this module's own
 * doc-comment ("SENTRY (Task P3)") for the confirmed endpoint/status shapes
 * and why this endpoint (not the org-only one) was chosen, and why `config`
 * (not yet a persisted connector row) is where BOTH `sentryOrg` and
 * `sentryProject` come from here. Either missing fails closed with a
 * distinct, actionable error rather than guessing. */
async function verifySentry(
  token: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  const org = resolveNonEmptyString(config?.sentryOrg);
  if (!org) {
    return { ok: false, error: "Set the Sentry organization before connecting." };
  }
  const project = resolveNonEmptyString(config?.sentryProject);
  if (!project) {
    return { ok: false, error: "Set the Sentry project before connecting." };
  }
  try {
    const res = await fetchWithTimeout(
      `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Sentry rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Sentry (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Sentry to verify the token — try again." };
  }
}

/**
 * The 9 confirmed Datadog site parameter values — duplicated from
 * `lib/evidence/datadog.ts`'s own `DATADOG_SITES` (not imported: this
 * module stays a leaf, the same independence `resolveHttpUrl` above already
 * has from `packages/db-postgres`'s own URL validator) rather than shared,
 * mirroring this codebase's existing precedent for small, provider-specific
 * defensive checks. See that module's own doc-comment ("SITE ROUTING") for
 * the confirmed source. EXPORTED (Fix Round 1, FOLD 3) solely so
 * `datadog.test.ts` can assert this Set stays set-equal to the adapter's own
 * duplicate — the two lists can never silently drift apart (e.g. a future
 * new Datadog region added to one and not the other) unnoticed. This does
 * NOT create a runtime import between the two modules; only the TEST
 * imports both. */
export const DATADOG_SITES = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ddog-gov.com",
  "us2.ddog-gov.com",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
]);

/** Defensively validate an untrusted `config.datadogSite` value at
 * verify-time — see this module's own doc-comment ("DATADOG") for why this
 * value has NOT passed any site-specific check yet (only the bare
 * non-empty-string `validateSimpleConfigString`). Returns the trimmed,
 * lowercased site string on an exact allowlist match, or `null` for
 * anything missing/malformed/not-on-the-list. */
function resolveDatadogSite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return DATADOG_SITES.has(trimmed) ? trimmed : null;
}

const DATADOG_VALIDATE_KEYS_PATH = "/api/v2/validate_keys";

/** Datadog: a valid apiKey/appKey pair resolves `GET
 * {https://api.<site>}/api/v2/validate_keys` — see this module's own
 * doc-comment ("DATADOG (Task P4)") for the confirmed endpoint/auth shape,
 * and ("LANGFUSE HOST — THE ORDERING GAP") for why `config` (not yet a
 * persisted connector row) is where `datadogSite` comes from here. No site
 * (missing, or present but not on the documented allowlist) fails closed
 * with a clear, actionable error rather than guessing a default region —
 * exactly like `verifyLangfuse`'s identical no-default-host discipline. */
async function verifyDatadog(
  apiKey: string,
  appKey: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  const site = resolveDatadogSite(config?.datadogSite);
  if (!site) {
    return { ok: false, error: "Set a valid Datadog site before connecting." };
  }
  try {
    const res = await fetchWithTimeout(`https://api.${site}${DATADOG_VALIDATE_KEYS_PATH}`, {
      headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Datadog rejected these API keys." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Datadog (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Datadog to verify the keys — try again." };
  }
}

/**
 * PROMETHEUS (Task P5, Evidence Providers Wave 2): confirmed against
 * Prometheus's own docs during implementation (this task's mandatory first
 * step), not trusted from memory — see `lib/evidence/prometheus.ts`'s own
 * doc-comment for the full citation trail (endpoint shapes, escaping rules,
 * the label-name ambiguity). This module's own concern is narrower: the
 * live-verify FALLBACK CHAIN the task's mandatory first step explicitly
 * asked for, since a single hard-coded endpoint isn't safe to assume across
 * every deployment shape (an old pinned version, or a reverse proxy that
 * only allowlists `/api/v1/query` itself):
 *   1. `GET /api/v1/status/buildinfo` — confirmed
 *      (prometheus.io/docs/prometheus/latest/querying/api/), but confirmed
 *      ADDED IN 2.14.0 (Nov 2019) — plausibly 404s on an old pin or a
 *      hardened reverse proxy.
 *   2. `GET /-/ready` — confirmed
 *      (prometheus.io/docs/prometheus/latest/management_api/): "returns 200
 *      when Prometheus is ready to serve traffic"; confirmed to need NO
 *      special flag (unlike `/-/reload`/`/-/quit`, which the same page
 *      confirms need `--web.enable-lifecycle`), so this leg is always
 *      available on a stock instance.
 *   3. `query=vector(1)` against `/api/v1/query` — confirmed real,
 *      dependency-free PromQL
 *      (prometheus.io/docs/prometheus/latest/querying/functions/): "returns
 *      [the scalar] as a single-element instant vector with no labels" —
 *      needs no stored metric, the closest possible proxy for "is the exact
 *      endpoint this adapter's REAL calls depend on alive and functional".
 * A 401/403 at ANY leg is a definitive credential rejection — returned
 * immediately, never falling through to try the same rejected credential
 * against a later leg. Any other non-2xx, or a thrown network error, falls
 * through to the next leg; the LAST leg's own outcome is what verify
 * finally reports.
 *
 * AUTH HEURISTIC (duplicated from `lib/evidence/prometheus.ts`'s own
 * `resolvePrometheusAuth` — NOT imported: this module stays a leaf, the
 * same independence `resolveHttpUrl`/`DATADOG_SITES` above already have
 * from `packages/db-postgres` and `lib/evidence/datadog.ts` respectively).
 * `prometheus.test.ts` asserts this duplicate and the adapter's own
 * original agree on the same table of inputs — the two can never silently
 * drift apart unnoticed, mirroring `DATADOG_SITES`' FOLD 3 sync-test
 * precedent, adapted for a FUNCTION (no shared constant to Set-equality-
 * check). See that module's own doc-comment ("AUTH HEURISTIC") for the full
 * reasoning, including the disclosed "any credential verifies against an
 * unauthenticated instance" limitation.
 */
type PrometheusAuth = { scheme: "bearer"; token: string } | { scheme: "basic"; user: string; pass: string };

export function resolvePrometheusAuthForVerify(secret: string): PrometheusAuth {
  const idx = secret.indexOf(":");
  if (idx === -1) {
    return { scheme: "bearer", token: secret };
  }
  return { scheme: "basic", user: secret.slice(0, idx), pass: secret.slice(idx + 1) };
}

function prometheusAuthHeaderForVerify(auth: PrometheusAuth): string {
  return auth.scheme === "bearer"
    ? `Bearer ${auth.token}`
    : `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
}

const PROMETHEUS_BUILDINFO_PATH = "/api/v1/status/buildinfo";
const PROMETHEUS_READY_PATH = "/-/ready";
const PROMETHEUS_QUERY_PATH = "/api/v1/query";

/** Prometheus: see this module's own doc-comment ("PROMETHEUS (Task P5)")
 * for the confirmed three-leg fallback chain and the auth heuristic. `url`
 * (not yet a persisted connector row) is where `config.prometheusUrl` comes
 * from here — the same "not yet persisted" ordering gap every Wave-2
 * provider's live-verify hits (see "LANGFUSE HOST — THE ORDERING GAP"
 * above) — re-gated via the EXISTING {@link resolveHttpUrl} (this value has
 * not passed `validateUrlConfigString` yet at this point in the flow). */
async function verifyPrometheus(
  secret: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  const url = resolveHttpUrl(config?.prometheusUrl);
  if (!url) {
    return { ok: false, error: "Set the Prometheus base URL before connecting." };
  }
  const auth = resolvePrometheusAuthForVerify(secret);
  const headers = { Authorization: prometheusAuthHeaderForVerify(auth) };

  try {
    const res = await fetchWithTimeout(`${url}${PROMETHEUS_BUILDINFO_PATH}`, { headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Prometheus rejected this credential." };
    }
    if (res.ok) {
      return { ok: true };
    }
    // Not ok, not an auth rejection (e.g. a 404 on an old pin or a hardened
    // proxy) — fall through to the next leg rather than failing closed here.
  } catch {
    // Network-level failure on this leg — still try the fallbacks rather
    // than giving up on the very first hop.
  }

  try {
    const res = await fetchWithTimeout(`${url}${PROMETHEUS_READY_PATH}`, { headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Prometheus rejected this credential." };
    }
    if (res.ok) {
      return { ok: true };
    }
  } catch {
    // fall through to the final leg
  }

  try {
    const params = new URLSearchParams({ query: "vector(1)", time: new Date().toISOString() });
    const res = await fetchWithTimeout(`${url}${PROMETHEUS_QUERY_PATH}?${params}`, { headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Prometheus rejected this credential." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Prometheus (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Prometheus to verify the credential — try again." };
  }
}

/**
 * GRAFANA (Task P6, Evidence Providers Wave 2): confirmed against Grafana's
 * own docs during implementation (this task's mandatory first step), not
 * trusted from memory — see `lib/evidence/grafana.ts`'s own doc-comment for
 * the full doc-verify trail (auth token formats, the PIVOT away from
 * datasource-proxy `signals`, the `/api/annotations` shape). This module's
 * own concern is narrower: which of the two candidate verify endpoints the
 * task's mandatory first step asked to confirm actually works with a
 * service account token.
 *   - `GET /api/user` — confirmed to REJECT service account tokens outright
 *     (that endpoint requires Basic auth or a Grafana SERVER admin, a
 *     privilege level service accounts structurally cannot hold — they are
 *     scoped to one org and one org role).
 *   - `GET /api/org` — confirmed to WORK with service account tokens (every
 *     organization-level action, including this one, is reachable with a
 *     service account token per Grafana's own docs).
 *   `/api/org` is therefore the one this function calls; `/api/user` is not
 * used anywhere in this codebase. `url` (not yet a persisted connector row)
 * is where `config.grafanaUrl` comes from here — the SAME "not yet
 * persisted" ordering gap every Wave-2 provider's live-verify hits (see
 * "LANGFUSE HOST — THE ORDERING GAP" above), re-gated via the EXISTING
 * {@link resolveHttpUrl} (this value has not passed `validateUrlConfigString`
 * yet at this point in the flow). Status-code-only gating (no body-shape
 * parsing) — a plain REST GET, mirroring `verifyFigma`'s identical
 * simplicity, since (unlike Linear/Railway's GraphQL calls) there is no
 * `{errors:[...]}`-on-200 shape to additionally guard against here.
 */
async function verifyGrafana(
  token: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  const url = resolveHttpUrl(config?.grafanaUrl);
  if (!url) {
    return { ok: false, error: "Set the Grafana base URL before connecting." };
  }
  try {
    const res = await fetchWithTimeout(`${url}/api/org`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Grafana rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Grafana (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Grafana to verify the token — try again." };
  }
}

/**
 * VERCEL (Task P7, Evidence Providers Wave 2): confirmed against Vercel's
 * own docs during implementation (this task's mandatory first step), not
 * trusted from memory — see `lib/evidence/vercel.ts`'s own doc-comment for
 * the full doc-verify trail (the `/v6/`→`/v7/` deployments-listing version
 * correction, the since/until pairing choice, the response shape).
 *   - Token leg: `GET /v2/user` — confirmed, current, unchanged from this
 *     task's believed shape. No `teamId` query param exists on this
 *     endpoint (it always resolves the token's own bound principal); a
 *     401/403 is a definitive rejection.
 *   - Project leg (this task's own pinned design: "when vercelProjectId
 *     present, confirm project visibility with a cheap project GET"):
 *     `GET /v9/projects/{idOrName}` — confirmed, current
 *     (vercel.com/docs/rest-api/reference/endpoints/projects/
 *     find-a-project-by-id-or-name), `teamId`/`slug` query params
 *     confirmed. UNLIKE `verifySentry`'s two REQUIRED companion values
 *     (org+project, both needed to even form that endpoint's path), this
 *     task's own pinned design makes the project leg CONDITIONAL, not
 *     fail-closed: `vercelProjectId` is declared `required: true` on the
 *     catalog entry, so in practice it is always present by the time a
 *     real connect flow reaches this function — but this function itself
 *     does not hinge success on it, matching the task's own literal
 *     wording ("confirm the token... AND, when vercelProjectId present,
 *     confirm project visibility...", token-check unconditional,
 *     project-check additive) rather than Sentry's "both requirements gate
 *     the ONE call" shape (Vercel's token check is independently useful
 *     and already a full call to a real Vercel endpoint on its own).
 *     `teamId` (`config.vercelTeamId`) is genuinely OPTIONAL end to end —
 *     included on the project-leg request when present, omitted otherwise
 *     (personal scope) — never itself a reason to fail closed. A 404 on
 *     the project leg reads as "Vercel could not find this project" — a
 *     wrong/stale project id is an operator CONFIGURATION mistake, not a
 *     credential Vercel rejected, so it gets its own distinct, actionable
 *     error rather than being folded into the generic "rejected this
 *     token" message a 401/403 produces.
 */
async function verifyVercel(
  token: string,
  config: Record<string, unknown> | undefined
): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Vercel rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Vercel (HTTP ${res.status}).` };
    }
  } catch {
    return { ok: false, error: "Couldn't reach Vercel to verify the token — try again." };
  }

  // Token leg passed. Project leg is ADDITIVE (see this function's own
  // doc-comment) — only runs when a project id rode along in this request.
  const projectId = resolveNonEmptyString(config?.vercelProjectId);
  if (!projectId) {
    return { ok: true };
  }

  const teamId = resolveNonEmptyString(config?.vercelTeamId);
  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  const qs = params.toString();
  const projectUrl = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetchWithTimeout(projectUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Vercel rejected this token." };
    }
    if (res.status === 404) {
      return { ok: false, error: "Couldn't find this Vercel project — check the project ID." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Vercel (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Vercel to verify the project — try again." };
  }
}

const CLOUDFLARE_TOKEN_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";

/** Cloudflare: a valid API Token resolves `GET
 * https://api.cloudflare.com/client/v4/user/tokens/verify` with
 * `result.status === "active"` — see this module's own doc-comment
 * ("CLOUDFLARE (Task P8)") for the confirmed endpoint/response shape and
 * why NO config is needed here (unlike every Wave-2 provider before
 * Vercel's own token leg). */
async function verifyCloudflare(token: string): Promise<VerifyResult> {
  try {
    const res = await fetchWithTimeout(CLOUDFLARE_TOKEN_VERIFY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Cloudflare rejected this token." };
    }
    if (!res.ok) {
      return { ok: false, error: `Couldn't verify with Cloudflare (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { status?: string };
    };
    // `success: true` alone is not sufficient — see this module's own
    // doc-comment ("CLOUDFLARE (Task P8)") for why a disabled/expired token
    // can still return a well-formed, successful response.
    if (body?.success === true && body.result?.status === "active") {
      return { ok: true };
    }
    return { ok: false, error: "Cloudflare rejected this token." };
  } catch {
    return { ok: false, error: "Couldn't reach Cloudflare to verify the token — try again." };
  }
}

/**
 * Verify a credential against its provider. Returns `{ok:true}` only when the
 * provider accepts it. Context7 has no safe live check, so it returns
 * `{ok:true}` here — its format gate is the guarantee.
 *
 * Task P0: `secret` is split into its parts ONCE, generically, off the
 * catalog entry's declared `connect.secretParts` (see
 * `apps/console/lib/evidence/composite-secret.ts`'s own doc-comment) before
 * dispatching — so a FUTURE provider's own case (P2-P8) receives
 * `split.parts` directly instead of re-deriving the split itself. Every kind
 * that predates this wave is single-part, so `splitCompositeSecret`'s
 * passthrough makes `split.parts[0] === secret.trim()` for all of them —
 * behavior-identical to before this generalization. `catalog` defaults to
 * the real {@link CONNECTOR_CATALOG} — the optional param exists so a test
 * can prove the split-before-dispatch mechanism with a synthetic composite
 * entry, without a second real composite provider in the catalog (P0 adds
 * none).
 *
 * Task P2: an optional 4th `config` parameter — see this module's own
 * doc-comment ("LANGFUSE HOST — THE ORDERING GAP"). Every pre-P2 call site
 * omits it (`undefined`), which every pre-P2 case below simply never reads —
 * behavior-identical.
 */
export async function verifyConnectorCredential(
  kind: ConnectorKind,
  secret: string,
  catalog: ConnectorCatalogEntry[] = CONNECTOR_CATALOG,
  config?: Record<string, unknown>
): Promise<VerifyResult> {
  const trimmed = secret.trim();

  const entry = catalog.find((e) => e.kind === kind);
  const split = splitCompositeSecret(entry?.connect ?? {}, trimmed);
  if (!split.ok) {
    // Defensive only — validateConnectorCredential (secret/route.ts's Gate
    // 1) already rejects a malformed composite secret before this
    // live-verify gate ever runs in the real route; this path exists so the
    // function stays correct if ever called directly (as this module's own
    // tests do).
    return { ok: false, error: split.error };
  }
  const first = split.parts[0];

  switch (kind) {
    case "linear":
      return verifyLinear(first);
    case "figma":
      return verifyFigma(first);
    case "railway":
      return verifyRailway(first);
    case "langfuse":
      return verifyLangfuse(first, split.parts[1], config);
    case "sentry":
      return verifySentry(first, config);
    case "datadog":
      return verifyDatadog(first, split.parts[1], config);
    case "prometheus":
      // No declared secretParts (see this module's own doc-comment,
      // "PROMETHEUS (Task P5)") — the split-before-dispatch step above is a
      // harmless passthrough for this kind, so `first` IS the full trimmed
      // secret; `verifyPrometheus` runs its OWN colon-presence heuristic on
      // it, mirroring `lib/evidence/prometheus.ts`'s adapter-side read.
      return verifyPrometheus(first, config);
    case "grafana":
      // No declared secretParts (single field, like prometheus above) — the
      // split-before-dispatch step above is a harmless passthrough for this
      // kind, so `first` IS the full trimmed secret.
      return verifyGrafana(first, config);
    case "vercel":
      // No declared secretParts (single field) — the split-before-dispatch
      // step above is a harmless passthrough for this kind, so `first` IS
      // the full trimmed secret.
      return verifyVercel(first, config);
    case "cloudflare":
      // No declared secretParts (single field) — the split-before-dispatch
      // step above is a harmless passthrough for this kind, so `first` IS
      // the full trimmed secret. No `config` passed — see this module's
      // own doc-comment ("CLOUDFLARE (Task P8)"): the verify endpoint needs
      // no zone-scoped value at all.
      return verifyCloudflare(first);
    case "context7":
      // Format-only (no safe side-effect-free live probe); already gated upstream.
      return { ok: true };
    default:
      // github (oauth) and the channel kinds (discord/slack/telegram — no
      // longer credential-based) never legitimately reach this function
      // through the route's allowlist; total and harmless if they ever do.
      // A future composite provider with no case yet added here (shouldn't
      // happen — P3-P8 each add their own case) would also fall through to
      // this harmless default rather than silently "verifying" nothing.
      return { ok: true };
  }
}
