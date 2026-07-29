import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `railway` evidence adapter (Task 7, debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows). The first EXTERNAL, CREDENTIALED evidence provider — Task 5's
 * `factory` answers from this console's own store (no credential at all);
 * Task 6's `github` reaches an external tool but over an OAuth installation
 * token, never a `connectors.secret` value. `railway` is the end-to-end
 * proof of "add a provider = catalog entry + adapter + credential pair":
 * the workspace pastes a Railway Account/Team token (`secret/route.ts`,
 * catalog-derived allowlist) and a project id
 * (`connectors/route.ts`'s config path — see
 * `connector-helpers.ts`'s `ConnectorConnectMeta.extraConfigField`
 * doc-comment for why the project id is NOT part of the secret payload).
 *
 * `verbs: ["changes", "search_events"]`: `changes` lists deployments in the
 * window; `search_events` searches those same deployments' logs.
 *
 * CREDENTIAL: unlike `factory`/`github`, this adapter DOES use its `secret`
 * parameter directly — it IS the Railway Account/Team token, sent as
 * `Authorization: Bearer <token>` on every GraphQL call.
 *
 * CONFIG_MISSING, NOT bad_request / unauthorized (pinned decision): a null
 * `secret` OR an absent `railwayProjectId` on the connector row both degrade
 * to `config_missing` — NEITHER is the caller's (the investigation's) fault,
 * and neither is a credential the provider actively REJECTED (that is
 * `unauthorized`, reserved for a token Railway itself refused). Both are
 * connector CONFIGURATION gaps the caller cannot fix by resubmitting a
 * different query — only reconnecting the workspace's Railway connector
 * fixes either. The route's own fan-out loop does not pre-check for a null
 * secret before calling any adapter (see `runner/evidence/route.ts`'s own
 * doc-comment, "FAN-OUT" step 2/3) — every adapter is responsible for its
 * own config-completeness check, and this is railway's.
 *
 * RAILWAY API SHAPES — confirmed against Railway's public docs during
 * implementation (this task's mandatory first step; do not trust these from
 * memory), NOT assumed:
 *   - Endpoint: `POST https://backboard.railway.com/graphql/v2`. Auth:
 *     `Authorization: Bearer <token>`.
 *     (https://docs.railway.com/integrations/api)
 *   - `deployments(input: DeploymentListInput!, first: Int)` returns a
 *     Relay-style `{ edges { node { ... } } }` connection;
 *     `DeploymentListInput` accepts `projectId`/`serviceId`/`environmentId`/
 *     `status`, all independently optional per the docs' own example
 *     variables blocks — this adapter passes `projectId` only (the
 *     workspace's connector row stores no environment/service id in v1).
 *     Confirmed response fields on a deployment node: `id`, `status`,
 *     `createdAt`, `meta` (plus `url`/`staticUrl`/`canRedeploy`/
 *     `canRollback`, unused here).
 *     (https://docs.railway.com/guides/manage-deployments,
 *     https://docs.railway.com/integrations/api/api-cookbook)
 *   - `deploymentLogs(deploymentId: String!, limit: Int)` returns
 *     `{ timestamp, message, severity }` per line. `filter`/`startDate`/
 *     `endDate` are ALSO documented as accepted, but their exact GraphQL
 *     scalar TYPE NAMES are never shown in any fetched example (only
 *     `deploymentId: String!` and `limit: Int` have confirmed type
 *     annotations) — declaring a wrong `$var: Type` for an untyped-per-docs
 *     argument would make the WHOLE query fail GraphQL validation, not just
 *     that one field, so this adapter deliberately omits them and does
 *     100% client-side filtering instead (window + `q.query` substring),
 *     mirroring `factory.ts`/`github.ts`'s own "transparency: match against
 *     the SAME text the caller receives" philosophy — one degree more
 *     cautious here because the type-safety risk of a wrong scalar name is
 *     categorically worse than a wrong runtime filter string.
 *     (https://docs.railway.com/guides/manage-deployments,
 *     https://docs.railway.com/integrations/api/api-cookbook)
 *   - A companion `environmentLogs(environmentId: String!, filter: String)`
 *     query also exists (https://docs.railway.com/guides/manage-environments)
 *     but requires an `environmentId` this connector's config does not
 *     store (only `railwayProjectId`) — v1 uses `deploymentLogs` per
 *     deployment-in-window instead (see "search_events" below), which needs
 *     no new stored id and naturally reuses the same "deployments in
 *     window" fetch `changes` already performs.
 *   - `me { name email }` (verify.ts's live-verify query) — see that file's
 *     own doc-comment; not used here.
 *
 * meta.commitHash (the `commit=` field in "changes" below): the docs' own
 * "Fetch single deployment" example confirms `meta` as a bare, queryable
 * top-level field on a deployment node, but never shows its INTERNAL shape.
 * A real, observed CLI usage pattern
 * (`railway status --json | jq '...latestDeployment.meta | {commit:
 * .commitHash, message: .commitMessage}'`) demonstrates `meta` behaves as a
 * plain JSON object once fetched, with (at least) `commitHash`/
 * `commitMessage` keys — consistent with `meta` being a JSON-scalar field
 * (queried bare, no GraphQL sub-selection), not a strongly-typed nested
 * object (which would need `meta { commitHash }` sub-selection syntax and
 * risk the SAME whole-query-breaks-on-one-wrong-field-name problem noted
 * above for deploymentLogs' extra filters). This adapter therefore queries
 * `meta` bare and reads `.commitHash` off the parsed result DEFENSIVELY
 * (absent/non-string → the render format's own `-` fallback) — a wrong
 * guess here degrades ONE field on ONE line, never the whole call.
 *
 * ENV FIELD — KNOWN v1 GAP: the pinned render format for `changes` is
 * `deployment {id} status={status} at={iso} commit={sha|-} env={name|-}`.
 * No deployment-node field or relation exposing the environment's NAME (nor
 * even a plain `environmentId` scalar) appeared in any fetched, confirmed
 * example — and unlike `meta`'s internal keys, guessing a WRONG top-level
 * field name here would break the ENTIRE `deployments` query (a GraphQL
 * validation error), taking down `changes` for every deployment, not just
 * degrading this one column. Given the render format's own union already
 * allows the empty case (`{name|-}`), this adapter renders `env=-`
 * UNCONDITIONALLY in v1 — an honest "unknown", not a guess — rather than
 * risk the whole verb on an unconfirmed field. A follow-up with a live
 * token can confirm the real field via GraphiQL introspection
 * (https://railway.com/graphiql) and wire it in as a pure additive change.
 *
 * REQUEST HYGIENE mirrors `github.ts`: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`.
 *
 * FAILURE HANDLING — mirrors `github.ts`'s own split exactly (pinned
 * decision): the SINGLE-SCOPE `deployments` fetch (shared by both verbs) is
 * NOT wrapped in a try/catch of its own — a thrown fetch (network error, or
 * the 8s timeout firing) propagates uncaught to the ROUTE, which already
 * catches an adapter's thrown `query()` call and reports `unreachable` (see
 * `runner/evidence/route.ts`'s own doc-comment, FAN-OUT step 3) — handling
 * that case here too would be a second, divergent write path for the exact
 * same fact. A clean (non-throwing) `401`/`403` response maps to
 * `unauthorized`; any other non-2xx status OR a `200` carrying a GraphQL
 * `errors` array maps to `upstream_error` (the pinned mapping — this
 * adapter does not further subdivide into `unexpected_status`/`bad_body`,
 * matching `factory.ts`/`github.ts`'s own precedent of not using those two
 * reasons either). `search_events`' PER-DEPLOYMENT `deploymentLogs`
 * sub-fetches DO each get their own try/catch and a cap-exempt marker line
 * (`(deployment {id}: railway {reason|unreachable})`, rendered first) — this
 * mirrors `github.ts`'s per-repo marker discipline exactly, because this is
 * the one place railway.ts has multiple independent sub-fetches within a
 * single verb call (per the task's own pinned wording).
 */

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const RAILWAY_FETCH_TIMEOUT_MS = 8000;

// How many of the project's most-recent deployments this adapter looks at
// as its own candidate set before window-filtering — mirrors factory.ts's
// CANDIDATE_RUN_FETCH_LIMIT in spirit (a plain local number, not a
// documented Railway maximum). KNOWN v1 LIMIT, same shape as factory.ts's:
// a window whose matching deployments are all older than the project's most
// recent 100 will under-report; out of scope for this task to fix with a
// real date-ranged query (no confirmed date-range argument — see this
// module's own doc-comment).
const DEPLOYMENTS_FETCH_LIMIT = 100;

const CHANGES_DEFAULT_LIMIT = 50;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

// Bounds how many of the in-window deployments' logs are fetched at all
// (search_events) — mirrors github.ts's MAX_REPOS: a debugging
// investigation searches the project's recent deployments' logs, not an
// unbounded fan-out across every deployment a wide window might contain.
const SEARCH_EVENTS_MAX_DEPLOYMENTS = 20;
// How many log lines to request per deployment — generous enough that the
// client-side window/query filtering below has real material to work with.
const SEARCH_EVENTS_LOGS_PER_DEPLOYMENT = 200;
// Bounds concurrent in-flight deploymentLogs calls, mirroring factory.ts's
// SEARCH_EVENTS_RUN_BATCH_SIZE (same reasoning: without this, a window with
// SEARCH_EVENTS_MAX_DEPLOYMENTS deployments would fire that many concurrent
// requests in one burst).
const SEARCH_EVENTS_BATCH_SIZE = 5;

const NO_DEPLOYMENTS_MARKER = "(no deployments in window)";
const NO_MATCHING_LOGS_MARKER = "(no matching log lines)";

const DEPLOYMENTS_QUERY = `
  query deployments($input: DeploymentListInput!, $first: Int) {
    deployments(input: $input, first: $first) {
      edges {
        node {
          id
          status
          createdAt
          meta
        }
      }
    }
  }
`;

const DEPLOYMENT_LOGS_QUERY = `
  query deploymentLogs($deploymentId: String!, $limit: Int) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/** Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` (and
 * `factory.ts`/`github.ts`'s duplicates of it) exactly — this adapter must
 * degrade `bad_request` correctly even when called directly, as its own
 * tests do, never assuming the route already validated the window first. */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Collapse embedded newlines so a free-text field (a log `message`) can
 * never split a rendered "one record per line" line in two — mirrors
 * `factory.ts`'s identical helper. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function railwayHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agentrail-console",
  };
}

interface RailwayGraphQLBody<T> {
  data?: T;
  errors?: unknown;
}

/**
 * One GraphQL POST, mapped to the pinned taxonomy. Deliberately NOT
 * try/catch-wrapped around the `fetch` call itself — see this module's own
 * doc-comment ("FAILURE HANDLING") for why a thrown fetch propagates
 * uncaught to whichever caller needs that (the route, for the single-scope
 * `deployments` call; `fetchDeploymentLogs`'s OWN try/catch, for the
 * per-deployment logs fan-out).
 */
async function railwayQuery<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: railwayHeaders(token),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(RAILWAY_FETCH_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "unauthorized" };
  }
  if (!res.ok) {
    return { ok: false, reason: "upstream_error" };
  }

  const body = (await res.json().catch(() => null)) as RailwayGraphQLBody<T> | null;
  if (!body || (Array.isArray(body.errors) && body.errors.length > 0) || body.data === undefined) {
    return { ok: false, reason: "upstream_error" };
  }
  return { ok: true, data: body.data };
}

/** Defensive read of `meta.commitHash` — see this module's own doc-comment
 * ("meta.commitHash") for why this is read off a loosely-typed JSON value
 * rather than a GraphQL sub-selection, and why an absent/non-string value
 * falls back to `-` rather than failing the whole line. */
function commitShaFromMeta(meta: unknown): string {
  if (meta && typeof meta === "object" && "commitHash" in meta) {
    const v = (meta as Record<string, unknown>).commitHash;
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "-";
}

interface RailwayDeploymentNode {
  id?: unknown;
  status?: unknown;
  createdAt?: unknown;
  meta?: unknown;
}

interface RailwayDeployment {
  id: string;
  status: string;
  createdAtMs: number;
  createdAtIso: string;
  commit: string;
}

/** The project's deployments whose `createdAt` falls in
 * `[windowStart, windowEnd]` (inclusive both ends), most-recent-first.
 * Shared by both verbs — `search_events` fetches logs FOR the deployments
 * this returns (see this module's own doc-comment, "search_events"). */
async function deploymentsInWindow(
  token: string,
  projectId: string,
  windowStart: string,
  windowEnd: string
): Promise<{ ok: true; deployments: RailwayDeployment[] } | { ok: false; reason: EvidenceDegradationReason }> {
  const result = await railwayQuery<{
    deployments: { edges: Array<{ node: RailwayDeploymentNode } | null> | null } | null;
  }>(token, DEPLOYMENTS_QUERY, { input: { projectId }, first: DEPLOYMENTS_FETCH_LIMIT });
  if (!result.ok) return result;

  const edges = result.data.deployments?.edges ?? [];
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const deployments: RailwayDeployment[] = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const createdAtRaw = typeof node.createdAt === "string" ? node.createdAt : null;
    if (!createdAtRaw) continue;
    const createdAtMs = new Date(createdAtRaw).getTime();
    if (Number.isNaN(createdAtMs) || createdAtMs < startMs || createdAtMs > endMs) continue;

    deployments.push({
      id: typeof node.id === "string" ? node.id : "-",
      status: typeof node.status === "string" ? node.status : "-",
      createdAtMs,
      createdAtIso: new Date(createdAtMs).toISOString(),
      commit: commitShaFromMeta(node.meta),
    });
  }

  // Defensive — do not trust the server's own edge ordering (never
  // documented as most-recent-first in any fetched example).
  deployments.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { ok: true, deployments };
}

/** `deployment {id} status={status} at={iso} commit={sha|-} env={name|-}` —
 * pinned field order. `env` is always `-` in v1 — see this module's own
 * doc-comment ("ENV FIELD — KNOWN v1 GAP"). */
function renderChangeLine(d: RailwayDeployment): string {
  return `deployment ${d.id} status=${d.status} at=${d.createdAtIso} commit=${d.commit} env=-`;
}

async function queryChanges(token: string, projectId: string, q: EvidenceQuery): Promise<AdapterResult> {
  const result = await deploymentsInWindow(token, projectId, q.windowStart, q.windowEnd);
  if (!result.ok) return result;
  if (result.deployments.length === 0) {
    return { ok: true, raw: NO_DEPLOYMENTS_MARKER };
  }

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // factory.ts/github.ts's identical clamp.
  const limit = Math.max(1, q.limit ?? CHANGES_DEFAULT_LIMIT);
  const limited = result.deployments.slice(0, limit);
  return { ok: true, raw: limited.map(renderChangeLine).join("\n") };
}

interface RailwayLogEntry {
  timestamp?: unknown;
  message?: unknown;
  severity?: unknown;
}

interface RenderedLogLine {
  at: number;
  line: string;
}

type DeploymentLogsOutcome = { ok: true; lines: RenderedLogLine[] } | { ok: false; marker: string };

/** One deployment's logs — its OWN try/catch (per-deployment granularity;
 * see this module's own doc-comment, "FAILURE HANDLING"). `deployment_log
 * deployment={id} at={iso} severity={severity|-} message={message}` —
 * this adapter's own line format (not pinned by the task brief beyond
 * "filtered by q.query substring case-insensitive, chronological"). */
async function fetchDeploymentLogs(token: string, deploymentId: string): Promise<DeploymentLogsOutcome> {
  let result: Awaited<ReturnType<typeof railwayQuery<{ deploymentLogs: RailwayLogEntry[] | null }>>>;
  try {
    result = await railwayQuery<{ deploymentLogs: RailwayLogEntry[] | null }>(
      token,
      DEPLOYMENT_LOGS_QUERY,
      { deploymentId, limit: SEARCH_EVENTS_LOGS_PER_DEPLOYMENT }
    );
  } catch {
    return { ok: false, marker: `(deployment ${deploymentId}: railway unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(deployment ${deploymentId}: railway ${result.reason})` };
  }

  const entries = Array.isArray(result.data.deploymentLogs) ? result.data.deploymentLogs : [];
  const lines: RenderedLogLine[] = [];
  for (const entry of entries) {
    const ts = typeof entry?.timestamp === "string" ? entry.timestamp : null;
    if (!ts) continue;
    const atMs = new Date(ts).getTime();
    if (Number.isNaN(atMs)) continue;
    const severity = typeof entry?.severity === "string" && entry.severity ? entry.severity : "-";
    const message = singleLine(typeof entry?.message === "string" ? entry.message : "");
    lines.push({
      at: atMs,
      line: `deployment_log deployment=${deploymentId} at=${new Date(atMs).toISOString()} severity=${severity} message=${message}`,
    });
  }
  return { ok: true, lines };
}

/** Split `items` into fixed-size, order-preserving batches — mirrors
 * `factory.ts`'s identical helper. */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function querySearchEvents(token: string, projectId: string, q: EvidenceQuery): Promise<AdapterResult> {
  const result = await deploymentsInWindow(token, projectId, q.windowStart, q.windowEnd);
  if (!result.ok) return result;
  if (result.deployments.length === 0) {
    return { ok: true, raw: NO_MATCHING_LOGS_MARKER };
  }

  // Bounds the fan-out — see this module's own doc-comment
  // (SEARCH_EVENTS_MAX_DEPLOYMENTS). `deploymentsInWindow` already sorts
  // most-recent-first, so this keeps the MOST RECENT in-window deployments.
  const targetDeployments = result.deployments.slice(0, SEARCH_EVENTS_MAX_DEPLOYMENTS);

  const allLines: RenderedLogLine[] = [];
  const markers: string[] = [];
  let successCount = 0;
  for (const batch of chunk(targetDeployments, SEARCH_EVENTS_BATCH_SIZE)) {
    const outcomes = await Promise.all(batch.map((d) => fetchDeploymentLogs(token, d.id)));
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successCount += 1;
        allLines.push(...outcome.lines);
      } else {
        markers.push(outcome.marker);
      }
    }
  }

  // Every targeted deployment's log fetch failed — nothing useful was
  // learned this call. Mirrors github.ts's identical "all repos failing"
  // collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // Substring match against the SAME text the caller receives — never a
  // hidden field the rendered line doesn't show (transparency, mirrors
  // factory.ts/github.ts).
  let filtered = allLines;
  if (q.query) {
    const needle = q.query.toLowerCase();
    filtered = filtered.filter((l) => l.line.toLowerCase().includes(needle));
  }

  // Chronological (ascending) — pinned.
  filtered.sort((a, b) => a.at - b.at);

  if (filtered.length === 0 && markers.length === 0) {
    return { ok: true, raw: NO_MATCHING_LOGS_MARKER };
  }

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors github.ts's Fix
  // Round 1: a busy deployment's real lines filling the cap must never
  // silently push a sibling deployment's failure marker out of the
  // response. Only the real log lines are subject to `limit`.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors factory.ts's identical reasoning: a debugging investigator is
  // better served by recency than an arbitrary truncation from the window's
  // start. Output stays chronological.
  const cappedLines = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

  return { ok: true, raw: [...markers, ...cappedLines.map((l) => l.line)].join("\n") };
}

export const railwayAdapter: EvidenceAdapter = {
  provider: "railway",
  verbs: ["changes", "search_events"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "changes":
      case "search_events":
        break;
      default:
        // This adapter declares only [changes, search_events] — the route
        // never asks it for a verb it didn't declare, but a direct caller
        // (this module's own tests included) is not bound by that, so this
        // stays defensive rather than throwing (mirrors factory.ts/
        // github.ts's identical default case).
        return { ok: false, reason: "bad_request" };
    }

    // See this module's own doc-comment ("CONFIG_MISSING, NOT bad_request /
    // unauthorized") — both checks below degrade identically.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }

    const row = await getConnector(workspaceId, "railway");
    const projectId = row?.config.railwayProjectId;
    if (!projectId) {
      return { ok: false, reason: "config_missing" };
    }

    return q.verb === "changes"
      ? queryChanges(secret, projectId, q)
      : querySearchEvents(secret, projectId, q);
  },
};

registerAdapter(railwayAdapter);
