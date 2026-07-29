import { getConnector, getInstallationToken } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `github` evidence adapter (Task 6, debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows). The first EXTERNAL evidence provider (Task 5's `factory` answers
 * from this console's own store; this one reaches GitHub's REST API over the
 * workspace's App installation). `verbs: ["changes"]` only — two kinds of
 * "what shipped": merged pull requests and Actions workflow runs, both
 * rendered one-per-line, most-recent-first across BOTH kinds and across
 * every repo the workspace has connected.
 *
 * CREDENTIAL: never `getConnectorSecret`/the `secret` parameter the route
 * hands every adapter unconditionally (see `runner/evidence/route.ts`'s own
 * fan-out doc-comment) — GitHub's credential is a per-installation token
 * minted fresh per call, `getInstallationToken(workspaceId)`
 * (`packages/db-postgres/src/queries/github-app-token.ts`), keyed off
 * `workspaces.githubInstallationId`, never a `connectors.secret` value (no
 * call site ever calls `setConnectorSecret(..., "github", ...)`). This
 * adapter accepts `secret` (the {@link EvidenceAdapter} contract requires the
 * parameter) but never reads it — same shape as `factory.ts`'s own ignored
 * `secret`, different reason (there: no credential exists at all; here: the
 * credential exists but lives somewhere else entirely).
 *
 * REGISTRY GAP (found while building this adapter — see the Task 6 report
 * for the full write-up): `evidenceCapabilities` (`registry.ts`) previously
 * required `hasSecret` for EVERY non-internal provider. A github connector
 * row's `hasSecret` is structurally ALWAYS false (per the paragraph above),
 * so github could never have appeared as a credentialed `changes` provider
 * no matter how connected the workspace was — a real gap between T4 (which
 * only ever exercised secret-based/internal rows) and this task (the first
 * EXTERNAL oauth evidence provider). Fixed by `registry.ts` gaining a
 * `connectMethod === "oauth"` branch that treats `enabled` alone as
 * credentialed for an oauth entry — see that file's own doc-comment.
 *
 * REPOS: the workspace's connected repos live on the `github` connector
 * row's `config.repos` (`getConnector(workspaceId, "github")` —
 * `ConnectorConfig.repos: string[]`, `"owner/name"` strings), the SAME field
 * the daemon / backlog sweep / repo picker all read. Capped to the FIRST 5
 * (array order, not sorted) — five external repos already means up to 15
 * GitHub requests (2 PR pages + 1 runs page each) per evidence call; a
 * debugging investigation asks about recent changes across the workspace's
 * small connected set, not an unbounded fan-out.
 *
 * PER-REPO FAILURE GRANULARITY: a repo's merged-PR fetch and its
 * workflow-runs fetch are requested concurrently (`Promise.all`) and treated
 * as ONE unit — if EITHER leg fails (non-2xx or a thrown/aborted fetch), the
 * WHOLE repo degrades to a single marker line,
 * `(repo {repo}: github {status|unreachable})`; there is no partial salvage
 * from the leg that happened to succeed. This keeps the failure surface
 * per-repo (matching the pinned decision's own wording), not
 * per-repo-per-endpoint, and mirrors the honest-marker philosophy used
 * throughout this layer (`factory.ts`'s horizon caveat, the envelope's own
 * degradation taxonomy): tell the truth about what could not be checked
 * rather than silently omitting it. Every targeted repo failing at once
 * degrades the WHOLE adapter call to `{ ok: false, reason: "upstream_error"
 * }` (nothing useful was learned this call); ANY repo succeeding — even with
 * zero events in window — keeps the call `ok: true`, with sibling repos'
 * markers folded into the rendered text alongside real lines.
 *
 * RENDERING: `merged_pr {repo}#{number} "{title}" merged_at={iso}
 * by={login}` / `actions_run {repo} {workflow_name}
 * conclusion={conclusion|in_progress} at={iso}` (pinned formats) — sorted
 * globally by each line's own timestamp, most-recent-first, THEN per-repo
 * failure markers appended after every real line, THEN the combined list
 * capped at `Math.max(1, q.limit ?? 50)` (factory.ts's own clamp, mirrored: a
 * `limit` of 0 or negative must never slice a non-empty result down to a
 * bare, empty-marker-triggering ""). Zero combined lines (every targeted
 * repo succeeded but found nothing) renders the honest empty marker,
 * `(no changes in window)`.
 *
 * TITLES ARE UNTRUSTED TEXT: capped to 120 chars here (the one adapter-side
 * transformation the spec pins), nothing else — no escaping, no newline
 * collapsing. `hardenUntrusted`/`scanForSecrets` at the envelope seam
 * (`envelope.ts`, applied to EVERY adapter's raw output uniformly) own every
 * other sanitization concern; duplicating any of it here would be a second,
 * divergent write path for exactly the kind of thing this codebase's
 * "one gate per concern" pattern exists to prevent.
 *
 * REQUEST HYGIENE mirrors `packages/github-app/src/index.ts` /
 * `lib/github-repos.ts`: an 8s `AbortSignal.timeout` per request,
 * `User-Agent: agentrail-console`, `Accept: application/vnd.github+json`,
 * `Authorization: Bearer <token>`.
 *
 * GITHUB API SHAPES (verified against docs.github.com, not assumed from
 * memory): `GET /repos/{repo}/pulls` returns a bare array; each entry's
 * `number`/`title`/`merged_at`/`user.login` are the fields this adapter
 * reads, and `state=closed` includes BOTH merged and closed-without-merge
 * PRs (the latter have `merged_at: null`, filtered out below — GitHub has no
 * "merged between" filter, hence over-fetching by `sort=updated` and
 * filtering `merged_at` client-side). `GET /repos/{repo}/actions/runs`
 * wraps its array as `{ workflow_runs: [...] }`; each run's `name` is the
 * workflow's display name, `conclusion` is `null` until the run completes,
 * and `created_at` is the field the `created=<date>..<date>` range filter
 * (date-only granularity) matches against.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 8000;

const MAX_REPOS = 5;
const PR_PER_PAGE = 100;
const PR_MAX_PAGES = 2;
const RUNS_PER_PAGE = 100;

const TITLE_MAX_LEN = 120;
const DEFAULT_LIMIT = 50;

const NO_CHANGES_MARKER = "(no changes in window)";

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/**
 * Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` (and
 * `factory.ts`'s duplicate of it) exactly — this adapter must degrade
 * `bad_request` correctly even when called directly, as its own tests do,
 * never assuming the route already validated the window first.
 */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agentrail-console",
  };
}

function githubFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
}

/** `YYYY-MM-DD` — the date-only granularity GitHub's `created` search
 * qualifier expects for the Actions-runs range filter. */
function toDateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** The one adapter-side title transformation the spec pins — see this
 * module's own doc-comment ("TITLES ARE UNTRUSTED TEXT") for why nothing
 * else touches the text. */
function truncateTitle(title: string): string {
  return title.length > TITLE_MAX_LEN ? title.slice(0, TITLE_MAX_LEN) : title;
}

interface RenderedLine {
  /** Epoch ms — the sort key ("most recent first across repos"); never
   * itself rendered raw (each line embeds its own `.toISOString()`). */
  at: number;
  line: string;
}

interface GithubPrEntry {
  number?: unknown;
  title?: unknown;
  merged_at?: unknown;
  user?: { login?: unknown } | null;
}

interface GithubRunEntry {
  name?: unknown;
  conclusion?: unknown;
  created_at?: unknown;
}

type RepoLegOutcome = { ok: true; body: unknown } | { ok: false; marker: string };

/** One repo's outcome for a single fetch leg (or the repo as a whole, once
 * both legs are combined by {@link fetchRepoEvidence}) — either its rendered
 * lines, or the one marker that collapses the whole repo (see this module's
 * own doc-comment, "PER-REPO FAILURE GRANULARITY"). */
type RepoOutcome = { ok: true; lines: RenderedLine[] } | { ok: false; marker: string };

/** One GET, translated to a per-repo failure marker on any thrown fetch
 * (network error, or the 8s `AbortSignal.timeout` firing) or non-2xx
 * response — never throws. A malformed-but-2xx body is left for the caller
 * to treat as "nothing usable on this page" rather than a hard failure (the
 * pinned marker format has exactly two variants, `{status}` or
 * `unreachable`; GitHub returning 200 with unparseable JSON is not a case
 * either variant describes, and is not a realistic GitHub failure mode). */
async function getJson(repo: string, url: string, token: string): Promise<RepoLegOutcome> {
  let res: Response;
  try {
    res = await githubFetch(url, token);
  } catch {
    return { ok: false, marker: `(repo ${repo}: github unreachable)` };
  }
  if (!res.ok) {
    return { ok: false, marker: `(repo ${repo}: github ${res.status})` };
  }
  const body = await res.json().catch(() => null);
  return { ok: true, body };
}

/**
 * Merged PRs for `repo` within `[windowStart, windowEnd]`, up to
 * {@link PR_MAX_PAGES} pages of `state=closed&sort=updated&direction=desc`
 * — GitHub has no "merged between" filter, so this over-fetches by recency
 * of UPDATE (a merge is itself an update) and filters `merged_at`
 * client-side, inclusive of both window bounds; a closed-but-never-merged PR
 * (`merged_at: null`) is excluded the same way.
 */
async function fetchMergedPrs(
  repo: string,
  token: string,
  windowStart: string,
  windowEnd: string
): Promise<RepoOutcome> {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const lines: RenderedLine[] = [];

  for (let page = 1; page <= PR_MAX_PAGES; page++) {
    const url =
      `${GITHUB_API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc` +
      `&per_page=${PR_PER_PAGE}&page=${page}`;
    const res = await getJson(repo, url, token);
    if (!res.ok) return res;

    const entries = Array.isArray(res.body) ? (res.body as GithubPrEntry[]) : [];
    for (const entry of entries) {
      const mergedAtRaw = typeof entry.merged_at === "string" ? entry.merged_at : null;
      if (!mergedAtRaw) continue;
      const mergedAtMs = new Date(mergedAtRaw).getTime();
      if (Number.isNaN(mergedAtMs) || mergedAtMs < startMs || mergedAtMs > endMs) continue;

      const number = typeof entry.number === "number" ? entry.number : Number(entry.number);
      if (!Number.isInteger(number) || number <= 0) continue;

      const title = truncateTitle(typeof entry.title === "string" ? entry.title : "");
      const login =
        entry.user && typeof entry.user.login === "string" && entry.user.login ? entry.user.login : "-";

      lines.push({
        at: mergedAtMs,
        line: `merged_pr ${repo}#${number} "${title}" merged_at=${new Date(mergedAtMs).toISOString()} by=${login}`,
      });
    }

    if (entries.length < PR_PER_PAGE) break; // last page
  }

  return { ok: true, lines };
}

/**
 * Actions runs for `repo`, `created` within the window's DATE range
 * (GitHub's `created` search qualifier is date-granularity, not exact-time —
 * see {@link toDateOnly}); a single page. The pinned decision does not ask
 * for more, so this trusts the server-side filter rather than re-filtering
 * client-side the way {@link fetchMergedPrs} must (GitHub has no server-side
 * "merged between" filter for PRs, but `created` IS a real server-side
 * filter for runs).
 */
async function fetchWorkflowRuns(
  repo: string,
  token: string,
  windowStart: string,
  windowEnd: string
): Promise<RepoOutcome> {
  const createdRange = `${toDateOnly(windowStart)}..${toDateOnly(windowEnd)}`;
  const url =
    `${GITHUB_API}/repos/${repo}/actions/runs?created=${encodeURIComponent(createdRange)}` +
    `&per_page=${RUNS_PER_PAGE}`;
  const res = await getJson(repo, url, token);
  if (!res.ok) return res;

  const wrapper = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
  const entries = Array.isArray(wrapper.workflow_runs) ? (wrapper.workflow_runs as GithubRunEntry[]) : [];

  const lines: RenderedLine[] = [];
  for (const entry of entries) {
    const createdAtRaw = typeof entry.created_at === "string" ? entry.created_at : null;
    if (!createdAtRaw) continue;
    const createdAtMs = new Date(createdAtRaw).getTime();
    if (Number.isNaN(createdAtMs)) continue;

    const name = typeof entry.name === "string" && entry.name ? entry.name : "-";
    const conclusion =
      typeof entry.conclusion === "string" && entry.conclusion ? entry.conclusion : "in_progress";

    lines.push({
      at: createdAtMs,
      line: `actions_run ${repo} ${name} conclusion=${conclusion} at=${new Date(createdAtMs).toISOString()}`,
    });
  }

  return { ok: true, lines };
}

/** Both legs concurrently; either failing collapses the WHOLE repo to one
 * marker — see this module's own doc-comment ("PER-REPO FAILURE
 * GRANULARITY"). */
async function fetchRepoEvidence(
  repo: string,
  token: string,
  windowStart: string,
  windowEnd: string
): Promise<RepoOutcome> {
  const [prs, runs] = await Promise.all([
    fetchMergedPrs(repo, token, windowStart, windowEnd),
    fetchWorkflowRuns(repo, token, windowStart, windowEnd),
  ]);
  if (!prs.ok) return prs;
  if (!runs.ok) return runs;
  return { ok: true, lines: [...prs.lines, ...runs.lines] };
}

export const githubAdapter: EvidenceAdapter = {
  provider: "github",
  verbs: ["changes"],
  /**
   * `secret` is accepted (the {@link EvidenceAdapter} contract requires the
   * parameter) but never read — see this module's own doc-comment
   * ("CREDENTIAL").
   */
  async query(workspaceId, q: EvidenceQuery, _secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }
    if (q.verb !== "changes") {
      // This adapter declares only [changes] — the route never asks it for
      // a verb it didn't declare, but a direct caller (this module's own
      // tests included) is not bound by that, so this stays defensive
      // rather than throwing (mirrors factory.ts's identical default case).
      return { ok: false, reason: "bad_request" };
    }

    const token = await getInstallationToken(workspaceId);
    if (!token) {
      return { ok: false, reason: "unauthorized" };
    }

    const row = await getConnector(workspaceId, "github");
    const repos = row?.config.repos ?? [];
    if (repos.length === 0) {
      return { ok: false, reason: "config_missing" };
    }

    const targetRepos = repos.slice(0, MAX_REPOS);
    const outcomes = await Promise.all(
      targetRepos.map((repo) => fetchRepoEvidence(repo, token, q.windowStart, q.windowEnd))
    );

    const allLines: RenderedLine[] = [];
    const markers: string[] = [];
    let successCount = 0;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successCount += 1;
        allLines.push(...outcome.lines);
      } else {
        markers.push(outcome.marker);
      }
    }

    if (successCount === 0) {
      return { ok: false, reason: "upstream_error" };
    }

    allLines.sort((a, b) => b.at - a.at); // most recent first, across repos and event kinds

    const combined = [...allLines.map((l) => l.line), ...markers];
    if (combined.length === 0) {
      return { ok: true, raw: NO_CHANGES_MARKER };
    }

    // factory.ts's clamp, mirrored: a limit of 0/negative must never slice a
    // non-empty result down to a bare "" that bypasses the honest empty
    // marker above.
    const limit = Math.max(1, q.limit ?? DEFAULT_LIMIT);
    return { ok: true, raw: combined.slice(0, limit).join("\n") };
  },
};

registerAdapter(githubAdapter);
