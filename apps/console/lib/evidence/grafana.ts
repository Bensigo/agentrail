import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `grafana` evidence adapter (Task P6, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The fifth Wave-2 provider —
 * `verbs: ["search_events"]` ONLY (no `signals`: see "PIVOT DECISION" below
 * for why this task's believed `signals`-via-datasource-proxy shape was
 * abandoned in favor of the plan's own sanctioned fallback).
 *
 * PIVOT DECISION (this task's own P6 section names this as a SANCTIONED
 * option, exercised here after the mandatory doc-verify step, reasons
 * recorded for reviewer adjudication — not a shortcut): the plan believed
 * `signals` would proxy a fixed RED/USE query set through Grafana's
 * datasource-proxy endpoint, `POST /api/ds/query`, against the
 * default/named Prometheus-type datasource — mirroring `prometheus.ts`'s
 * own fixed-query-set thinking. Doc-verified instead, THREE independent,
 * confirmed problems with that path for a v1:
 *
 *   1. UNDOCUMENTED REQUEST/RESPONSE SHAPE, BY GRAFANA'S OWN FIRST-PARTY
 *      ADMISSION: Grafana's own HTTP API reference for `/api/ds/query`
 *      (`grafana.com/docs/grafana/latest/developer-resources/api-reference/
 *      http-api/data_source/`) documents only the generic envelope
 *      (`queries[].refId`, `queries[].datasource.uid`, `format`,
 *      `maxDataPoints`, `intervalMs`, `from`, `to`) and states PLAINLY that
 *      "specific properties of each data source should be added... use the
 *      Developer Tools in your browser... to understand how to form a query
 *      for a certain data source" — i.e. the PromQL-carrying fields
 *      (`expr`, `range`/`instant`, `editorMode`, …) a Prometheus-type query
 *      actually needs are NOT part of any versioned, stable, first-party
 *      contract; every worked example found (GitHub issues, a Medium
 *      reverse-engineering write-up) is COMMUNITY-sourced, never
 *      docs-confirmed. Every sibling adapter in this wave lives by "docs
 *      govern over believed shapes" (Global Constraints, the T6/T7 lesson)
 *      — building this adapter's CORE mechanism on a reverse-engineered,
 *      unversioned shape would be the one adapter in the wave NOT held to
 *      that standard. The RESPONSE shape compounds this: `/api/ds/query`
 *      answers in Grafana's own generic "data frame" envelope
 *      (`results.<refId>.frames[].schema.fields` + parallel
 *      `data.values[]` arrays), NOT Prometheus's native
 *      `{status,data:{resultType,result}}` shape — so despite this task's
 *      own framing ("Grafana's proxy path to a Prometheus datasource reuses
 *      ALL of that thinking"), NONE of `prometheus.ts`'s response-parsing
 *      code would actually be reusable; only its PromQL two-layer-escaping
 *      functions would be (moot once `expr`-construction itself is out of
 *      scope).
 *   2. A PERMISSION MISMATCH FOR A MINIMALLY-SCOPED SERVICE ACCOUNT:
 *      discovering the default/named Prometheus-type datasource UID needs
 *      `GET /api/datasources`, confirmed (same doc page) to require the
 *      `datasources:read` RBAC permission. Confirmed separately
 *      (`grafana.com/docs/grafana/latest/administration/roles-and-
 *      permissions/access-control/rbac-fixed-basic-role-definitions/`, and
 *      Grafana's own community forum threads on the same topic): the
 *      built-in VIEWER basic role — the role a security-conscious operator
 *      would reach for on a READ-ONLY evidence integration, exactly this
 *      connector's own `credentialHint` recommendation below — carries only
 *      `datasources.id:read` (see a datasource's bare id), NOT the broader
 *      `datasources:read` `/api/datasources` itself demands; that needs
 *      Editor or Admin. The task's own anticipated "Auth/roles wrinkle:
 *      /api/datasources may require admin" is confirmed real, not
 *      hypothetical.
 *   3. THE QUESTION-SHAPE FITS BETTER ANYWAY: alert firing/resolving is an
 *      EVENT (something that HAPPENED, at an instant), not a numeric health
 *      reading — `search_events` is the more honest verb for
 *      "Grafana-managed alerts + annotations" than shoehorning it into
 *      `signals`' pre-aggregated-numeric-summary contract.
 *
 * The chosen path, `GET /api/annotations`, has NONE of problem 1/2's
 * gaps: fully documented by Grafana's own first-party HTTP API reference
 * (`grafana.com/docs/grafana/latest/developer-resources/api-reference/
 * http-api/api-legacy/annotations/`), confirmed to need only
 * `annotations:read` — confirmed to be PART of the built-in Viewer role
 * (unlike `datasources:read` above) — and needs no PromQL/datasource-type
 * dependency of any kind: annotation objects are a single, stable,
 * datasource-agnostic shape regardless of what's plugged into Grafana.
 *
 * GRAFANA HTTP API SHAPES — confirmed against Grafana's own docs during
 * implementation (this task's mandatory first step; NOT trusted from
 * memory):
 *
 *   - AUTH: service account tokens use the confirmed `glsa_` prefix
 *     (`grafana.com/docs/grafana/latest/administration/service-accounts/`
 *     and Grafana's own blog announcing the format,
 *     `grafana.com/blog/new-in-grafana-9-1-service-accounts-are-now-ga/`),
 *     sent as `Authorization: Bearer glsa_...`. LEGACY API keys (the
 *     pre-service-account credential) are confirmed DEPRECATED but still
 *     functioning — Grafana's own migration doc
 *     (`.../service-accounts/migrate-api-keys/`) states migrated keys
 *     "will continue working as before" — and are confirmed to be
 *     base64-JSON-shaped, starting with the literal prefix `eyJ` (that same
 *     doc's own worked example shows a `"key": "eyJ…"` value that decodes to
 *     a JSON object with `k`/`n`/`id` fields — deliberately NOT reproduced
 *     verbatim here, or in this adapter's own test fixtures, since the
 *     literal string is real-key-shaped enough to trip a secret scanner;
 *     see that doc page directly for the exact example).
 *     BOTH generations use the IDENTICAL `Authorization: Bearer <token>`
 *     scheme — a genuine simplification worth calling out explicitly next
 *     to `prometheus.ts`'s own bearer-vs-Basic heuristic: THIS adapter never
 *     needs to disambiguate two auth SCHEMES, only accept two documented
 *     token SHAPES at the format gate (`connector-helpers.ts`'s own
 *     `case "grafana"`) while sending the same header either way.
 *   - VERIFY ENDPOINT: `GET /api/org` — confirmed
 *     (multiple Grafana community-forum threads on service-account
 *     permission boundaries, cross-checked against the Organization HTTP
 *     API's own docs page) to work with service account tokens. `GET
 *     /api/user`, by contrast, is confirmed to REJECT service account
 *     tokens outright — that endpoint requires Basic auth or a Grafana
 *     SERVER admin, a privilege level service accounts structurally cannot
 *     hold (they are scoped to one org and one org role). This directly
 *     resolves the ambiguity this task's own mandatory-first-step wording
 *     flagged ("or /api/user with SA tokens? confirm which works") —
 *     `/api/org` is the only one of the two that actually works for the
 *     credential this connector stores.
 *   - SEARCH_EVENTS (annotations + Grafana-managed alerts): `GET
 *     /api/annotations?from=&to=&limit=&tags=` — confirmed
 *     (`.../api-legacy/annotations/`). `from`/`to` are epoch
 *     MILLISECONDS — confirmed on BOTH the request params AND the
 *     response's own `time`/`timeEnd` fields (the docs' own worked example:
 *     `1507266395000`) — a genuine, disclosed SIMPLIFICATION over
 *     `datadog.ts`'s confirmed seconds-request/milliseconds-response
 *     asymmetry: there is no unit conversion of any kind on either side of
 *     this adapter's window handling. `limit` defaults to 100 server-side
 *     if omitted; this adapter always sends an explicit, generous
 *     {@link ANNOTATIONS_FETCH_LIMIT} instead (mirrors
 *     `datadog.ts`'s/`sentry.ts`'s "request a generous single page,
 *     independent of the caller's own render-time `q.limit`" precedent — no
 *     documented MAX was found for this endpoint, so this is a disclosed,
 *     generous-but-arbitrary v1 bound, same spirit as every sibling's own
 *     single-page discipline). Response: a bare JSON ARRAY (not a wrapper
 *     object) of annotation objects, confirmed shape per that page's own
 *     worked example: `{id, alertId, dashboardUID, panelId, userId,
 *     userName, newState, prevState, time, timeEnd, text, tags, data}`.
 *     `alertId` is confirmed present on EVERY annotation, `0` for a plain
 *     user/API-created annotation and non-zero for a Grafana-managed alert
 *     state change — the field this adapter reads to derive the rendered
 *     `{type}` slot (see {@link annotationType}); `newState`/`prevState`
 *     carry the alert's state-transition text when `alertId !== 0` but are
 *     NOT surfaced in v1's rendered line (the pinned format has no slot for
 *     them — `text` already carries Grafana's own human-readable summary
 *     for both annotation kinds). `timeEnd` (region-annotation end time) is
 *     confirmed present but likewise NOT rendered — the pinned line format
 *     has exactly one `at={iso}` slot, so this adapter renders `time` only
 *     (a disclosed v1 simplification, not an oversight).
 *   - REQUIRED PERMISSION: `annotations:read` (scope `annotations:*`) —
 *     confirmed (`.../api-legacy/annotations/`'s own permissions note) —
 *     and separately confirmed to be PART of the built-in Viewer role's
 *     default permission set (see "PIVOT DECISION" above) — the
 *     `credentialHint` below can honestly recommend the least-privileged
 *     role for a read-only evidence connector.
 *   - NO FREE-TEXT SEARCH PARAMETER: confirmed — the endpoint's full
 *     documented parameter list is `from`/`to`/`limit`/`alertId`/
 *     `dashboardUID`/`panelId`/`userId`/`type`/`tags` only; there is no
 *     `query=`/`text=`-shaped free-text search of any kind, unlike Sentry's
 *     `query`/Datadog's `filter.query`. `q.query` therefore CANNOT ride
 *     server-side at all for this verb — see "Q.QUERY" below.
 *   - NO DSL, NO ESCAPING (task's own anticipated framing, confirmed true
 *     by the absence of any query-language parameter): every value this
 *     adapter sends — `from`/`to` (numeric strings), `limit` (a numeric
 *     string), `tags` (`q.scope`, when present) — goes into a plain
 *     `application/x-www-form-urlencoded` query STRING via
 *     `URLSearchParams`, which percent-encodes automatically; there is no
 *     quoting grammar, no metacharacter set, no "does this provider's own
 *     mini-language need escaping" question to answer AT ALL, structurally
 *     unlike every PromQL/Sentry-search/Datadog-log-search-syntax case this
 *     wave has otherwise had to reason about. Round-trip tested
 *     (`grafana.test.ts`) by capturing the real request URL and confirming
 *     `URL.searchParams.get("tags")` recovers `q.scope` byte-for-byte for
 *     text containing spaces, `&`, `=`, `#`, `+`, and non-ASCII characters —
 *     the "round-trip tests" pin, satisfied for a no-DSL context by proving
 *     transport fidelity rather than an unescape/re-match proof (there is no
 *     grammar to unescape).
 *
 * Q.SCOPE MAPS TO `tags=<scope>` (this adapter's own disclosed judgment
 * call, mirroring every sibling's own scope-to-provider-primitive pick —
 * `prometheus.ts`'s `job=~`, `datadog.ts`'s `service:` tag): a single tag
 * filter, sent server-side, ANDed by Grafana against the annotation's own
 * stored tags. No validate-or-ignore gate is needed (unlike
 * `datadog.ts`'s `SCOPE_TAG_VALUE_RE`) — there is no mini-grammar for an
 * arbitrary tag value to violate; any string is a legal `tags` value once
 * percent-encoded.
 *
 * Q.QUERY (`search_events`): confirmed to have NO server-side home (see
 * above) — applied CLIENT-SIDE ONLY, as a substring match against each
 * candidate's own (already-truncated) `text` field specifically — mirrors
 * `sentry.ts`'s/`langfuse.ts`'s "one named field" convention rather than
 * `datadog.ts`'s "match the full rendered line" convention: `text` is the
 * one meaningful free-text field Grafana gives an annotation (there is no
 * separate "title" vs "body" split to choose between), so matching it
 * specifically (rather than incidental formatting like `event alert "..."
 * at=...`) is the more precise reading of "does this event mention what the
 * caller asked about."
 *
 * RENDERING: the task's own pinned annotation-event line,
 * `event {type|-} "{text-120}" at={iso}` — CHRONOLOGICAL (ascending, per
 * the task's own pinned wording), capped `Math.max(1, q.limit ??
 * {@link SEARCH_EVENTS_DEFAULT_LIMIT})`, keeping the MOST RECENT entries
 * when over cap (`sentry.ts`'s/`railway.ts`'s/`datadog.ts`'s identical "keep
 * the tail of the ascending sort" precedent). `{type}` is `alert` when
 * `alertId` is a finite, non-zero number, `annotation` when it is finite
 * and zero, or the honest `-` fallback for the (undocumented, defensive
 * only) case of a response missing `alertId` entirely. `{text}` is
 * newline-collapsed (`singleLine`, every sibling's identical "one record
 * per rendered line" discipline) then truncated to
 * {@link TEXT_MAX_LEN} — this task's own pinned "text-120" bound, matching
 * `datadog.ts`'s identical `MESSAGE_MAX_LEN` figure for its own free-text
 * field (github.ts's "TITLES ARE UNTRUSTED TEXT" precedent, applied here to
 * annotation text).
 *
 * WINDOW FILTERING: server-side (`from`/`to`, confirmed milliseconds both
 * ways — see above) AND client-side (belt-and-braces, every sibling's
 * identical doctrine, unqualified by verb) — every annotation's own `time`
 * is re-checked against `[windowStart, windowEnd]` regardless of what the
 * server-side params already did.
 *
 * FAILURE HANDLING mirrors `datadog.ts`'s/`sentry.ts`'s `search_events`
 * exactly: a SINGLE-SCOPE, single-page fetch — NOT try/catch-wrapped
 * locally (Global Constraints: "no whole-query try/catch" — a thrown fetch
 * propagates uncaught to the route, converted to `unreachable` there). A
 * clean 401/403 maps to `unauthorized`; any other non-2xx maps to
 * `upstream_error`; a 2xx response body that isn't a JSON array (confirmed
 * shape is always a bare array — anything else is a malformed/unexpected
 * body) is treated as ZERO elements, `ok: true` (mirrors
 * `prometheus.ts`'s/`datadog.ts`'s identical "malformed 200 body → zero
 * elements, not an error" precedent for their own inner-shape checks —
 * only a clean 2xx ever reaches this branch, the status-code checks above
 * already own every real error case).
 *
 * CONFIG_MISSING (mirrors every sibling's identical reasoning): a null
 * `secret`, OR an absent/blank `config.grafanaUrl`, degrade to
 * `config_missing` — neither is the caller's fault, neither is a credential
 * Grafana itself REJECTED (that is `unauthorized`); both are connector
 * configuration gaps only reconnecting (or fixing the stored URL) resolves.
 * `grafanaUrl` is NOT re-validated for scheme here — exactly like
 * `langfuseHost`/`prometheusUrl`, it is ALREADY scheme-gated at WRITE time
 * by `validateUrlConfigString` (`packages/db-postgres/src/queries/
 * connectors.ts` — `grafanaUrl` was already added to that scheme-gated
 * field list by Task P0, confirmed by reading that file directly) — by the
 * time a value reaches a STORED connector row, it is already trusted; this
 * adapter's own read only needs to check for PRESENCE (see
 * {@link resolveGrafanaUrl}). `verify.ts`'s OWN read, by contrast, DOES
 * re-apply the scheme gate defensively (its existing `resolveHttpUrl`
 * helper, reused verbatim — already generalized for exactly this by P2) —
 * see that module's own doc-comment, "LANGFUSE HOST — THE ORDERING GAP."
 *
 * NO OPTIONAL DATASOURCE-UID CONFIG FIELD: the task's own contingency
 * ("an optional `grafanaDatasourceUid` extra config field... if you take
 * the signals path and docs justify it") does not apply — the pivot away
 * from datasource-proxy querying makes that field's entire purpose (naming
 * which Prometheus-type datasource to query) moot. `ConnectorConfig`
 * already carries `grafanaUrl` only (P0); no new `packages/db-postgres`
 * config key, validator, or preservation case is added by this task.
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`, single attempt (no retries).
 */

const GRAFANA_FETCH_TIMEOUT_MS = 8000;
const ANNOTATIONS_PATH = "/api/annotations";

// Grafana's own confirmed default (100) for `/api/annotations`'s `limit` —
// no documented MAX was found for this endpoint. This adapter always sends
// an explicit, generous single-page request size instead of relying on the
// server default, independent of the caller's own render-time `q.limit` —
// mirrors `datadog.ts`'s `LOGS_PAGE_LIMIT`/`sentry.ts`'s own page-size
// precedent ("fetch enough to make the render cap meaningful, in one
// page, no cursor-following"). A window with more than this many in-window
// annotations still under-reports — a disclosed, accepted v1 bound, same
// spirit as every sibling's single-page discipline.
const ANNOTATIONS_FETCH_LIMIT = 500;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

// Pinned "TITLES ARE UNTRUSTED TEXT" discipline (github.ts's own doc-comment)
// applied to annotation text — this task's own pinned render format spells
// this out explicitly: "text-120".
const TEXT_MAX_LEN = 120;

const NO_MATCHING_EVENTS_MARKER = "(no matching events)";

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/** Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` (and every
 * sibling adapter's duplicate of it) exactly — never assumes the route
 * already validated the window first. */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Collapse embedded newlines so a free-text field can never split a
 * rendered "one record per line" line in two — mirrors every sibling
 * adapter's identical helper. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** The one adapter-side text transformation this task's own pinned format
 * calls for ("text-120") — mirrors `datadog.ts`'s identical
 * `truncateMessage` shape exactly (same 120-char bound). */
function truncateText(text: string): string {
  const collapsed = singleLine(text);
  return collapsed.length > TEXT_MAX_LEN ? collapsed.slice(0, TEXT_MAX_LEN) : collapsed;
}

function grafanaHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agentrail-console",
  };
}

function grafanaFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: grafanaHeaders(token),
    signal: AbortSignal.timeout(GRAFANA_FETCH_TIMEOUT_MS),
  });
}

/**
 * One GET, mapped to the pinned taxonomy. Deliberately NOT try/catch-wrapped
 * around the `fetch` call itself — see the module doc-comment ("FAILURE
 * HANDLING"): a thrown fetch propagates uncaught to this adapter's caller
 * (the route), exactly like `datadog.ts`'s/`sentry.ts`'s own
 * `search_events` verb.
 */
async function grafanaRequest(
  url: string,
  token: string
): Promise<{ ok: true; data: unknown } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await grafanaFetch(url, token);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "unauthorized" };
  }
  if (!res.ok) {
    return { ok: false, reason: "upstream_error" };
  }
  const body = await res.json().catch(() => null);
  if (body === null || body === undefined) {
    return { ok: false, reason: "upstream_error" };
  }
  return { ok: true, data: body };
}

// ---------------------------------------------------------------------------

interface Candidate {
  /** Epoch ms — the sort key AND the rendered `at=` source; never itself
   * rendered raw. */
  at: number;
  line: string;
  /** The (already-truncated) free text this candidate's `q.query` re-filter
   * matches against — see the module doc-comment ("Q.QUERY"). */
  text: string;
}

interface GrafanaAnnotation {
  alertId?: unknown;
  time?: unknown;
  text?: unknown;
}

/** `alertId` is confirmed present on every real annotation (0 for a plain
 * annotation, non-zero for a Grafana-managed alert state change) — see the
 * module doc-comment. The `-` fallback is defensive only (an
 * undocumented/malformed response missing the field entirely); never
 * observed against a real, doc-compliant Grafana instance. */
function annotationType(entry: GrafanaAnnotation): string {
  const alertId = entry.alertId;
  if (typeof alertId === "number" && Number.isFinite(alertId)) {
    return alertId !== 0 ? "alert" : "annotation";
  }
  return "-";
}

/** `event {type|-} "{text-120}" at={iso}` — this task's own pinned field
 * order. */
function renderEventLine(type: string, text: string, atIso: string): string {
  return `event ${type} "${text}" at=${atIso}`;
}

/** Presence + trim + trailing-slash-strip ONLY — see the module doc-comment
 * ("CONFIG_MISSING") for why this adapter does not re-validate scheme here
 * (mirrors `prometheus.ts`'s/`langfuse.ts`'s identical
 * `host.replace(/\/+$/, "")` read exactly — `grafanaUrl` is already
 * scheme-gated at write time). */
function resolveGrafanaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

/** `from`/`to` are epoch MILLISECONDS on the request side too (confirmed —
 * see the module doc-comment, "SEARCH_EVENTS") — no unit conversion, unlike
 * `datadog.ts`'s confirmed seconds-request asymmetry. `tags` (from
 * `q.scope`) is the ONLY caller-supplied text in this URL — see the module
 * doc-comment ("NO DSL, NO ESCAPING") for why `URLSearchParams`'s own
 * automatic percent-encoding is the entire "escaping" story here. */
function buildAnnotationsUrl(
  base: string,
  windowStart: string,
  windowEnd: string,
  scope: string | undefined
): string {
  const params = new URLSearchParams({
    from: String(new Date(windowStart).getTime()),
    to: String(new Date(windowEnd).getTime()),
    limit: String(ANNOTATIONS_FETCH_LIMIT),
  });
  if (scope) params.set("tags", scope);
  return `${base}${ANNOTATIONS_PATH}?${params}`;
}

/** Parses + belt-and-braces window-re-filters (never trusts the server-side
 * `from`/`to` alone — same doctrine as every sibling adapter's identical
 * re-filter) fetched annotation entries into candidate rendered lines. An
 * entry that isn't an object, or whose `time` isn't a finite number, is
 * skipped rather than throwing. */
function parseAnnotations(entries: unknown[], windowStart: string, windowEnd: string): Candidate[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const out: Candidate[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as GrafanaAnnotation;

    const atMs = typeof entry.time === "number" && Number.isFinite(entry.time) ? entry.time : null;
    if (atMs === null) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const type = annotationType(entry);
    const text = typeof entry.text === "string" ? truncateText(entry.text) : "";

    out.push({ at: atMs, text, line: renderEventLine(type, text, new Date(atMs).toISOString()) });
  }
  return out;
}

async function querySearchEvents(base: string, token: string, q: EvidenceQuery): Promise<AdapterResult> {
  const url = buildAnnotationsUrl(base, q.windowStart, q.windowEnd, q.scope);
  const result = await grafanaRequest(url, token);
  if (!result.ok) return result;

  // Confirmed shape is always a bare JSON array (see the module doc-comment,
  // "SEARCH_EVENTS") — anything else is malformed and treated as zero
  // elements, not an error (mirrors prometheus.ts's/datadog.ts's identical
  // "malformed 200 body → zero elements" precedent for their own inner
  // shapes).
  const entries = Array.isArray(result.data) ? result.data : [];
  let candidates = parseAnnotations(entries, q.windowStart, q.windowEnd);

  // q.query has no server-side home for this endpoint (see the module
  // doc-comment, "Q.QUERY") — client-side substring match against each
  // candidate's own (already-truncated) text field specifically.
  if (q.query) {
    const needle = q.query.toLowerCase();
    candidates = candidates.filter((c) => c.text.toLowerCase().includes(needle));
  }

  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_EVENTS_MARKER };
  }

  // Chronological (ascending) — this task's own pinned ordering.
  candidates.sort((a, b) => a.at - b.at);

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors sentry.ts's/railway.ts's/datadog.ts's identical reasoning.
  const capped = candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates;
  return { ok: true, raw: capped.map((c) => c.line).join("\n") };
}

// ---------------------------------------------------------------------------

export const grafanaAdapter: EvidenceAdapter = {
  provider: "grafana",
  verbs: ["search_events"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "search_events":
        break;
      default:
        // This adapter declares only [search_events] — the route never asks
        // it for a verb it didn't declare, but a direct caller (this
        // module's own tests included) is not bound by that, so this stays
        // defensive rather than throwing (mirrors every sibling adapter's
        // identical default case).
        return { ok: false, reason: "bad_request" };
    }

    // See the module doc-comment ("CONFIG_MISSING") — cheapest check (no DB
    // read needed) first, same order as every sibling.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }

    const row = await getConnector(workspaceId, "grafana");
    const base = resolveGrafanaUrl(row?.config.grafanaUrl);
    if (!base) {
      return { ok: false, reason: "config_missing" };
    }

    return querySearchEvents(base, secret, q);
  },
};

registerAdapter(grafanaAdapter);
