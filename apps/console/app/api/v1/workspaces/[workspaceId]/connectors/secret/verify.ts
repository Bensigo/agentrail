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
 * (Task P3 — `GET /api/0/projects/{org}/{project}/`). Context7 stays
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
