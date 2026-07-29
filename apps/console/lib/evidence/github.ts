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
 * A SUCCEEDING repo can STILL carry a marker (Fix Round 1, FIX 2): see
 * {@link fetchMergedPrs}'s own doc-comment for the fetch-horizon caveat this
 * adapter appends when its 2-page PR cap may have missed an in-window merge
 * — a caveat is not a failure (the fetch succeeded), so it rides alongside
 * that repo's real lines rather than replacing them, but is CAP-EXEMPT and
 * rendered first exactly like a failure marker (see "RENDERING" below).
 *
 * RENDERING: `merged_pr {repo}#{number} "{title}" merged_at={iso}
 * by={login}` / `actions_run {repo} {workflow_name}
 * conclusion={conclusion|in_progress} at={iso}` (pinned formats) — real
 * event lines are sorted globally by each line's own timestamp, most-
 * recent-first, then capped at `Math.max(1, q.limit ?? 50)` (factory.ts's
 * own clamp, mirrored: a `limit` of 0 or negative must never slice a
 * non-empty result down to a bare, empty-marker-triggering ""). Per-repo
 * markers (failures AND fetch-horizon caveats) are CAP-EXEMPT and rendered
 * FIRST, ahead of the capped event lines (Fix Round 1, FIX 1): a busy
 * repo's real lines filling the cap must never silently push a sibling
 * repo's failure — or an honest "this answer may be incomplete" caveat —
 * out of the response. Zero event lines AND zero markers (every targeted
 * repo succeeded and found nothing) renders the honest empty marker,
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
 * GITHUB API SHAPES: `GET /repos/{repo}/pulls` returns a bare array; each
 * entry's `number`/`title`/`merged_at`/`updated_at`/`user.login` are the
 * fields this adapter reads, and `state=closed` includes BOTH merged and
 * closed-without-merge PRs (the latter have `merged_at: null`, filtered out
 * below — GitHub has no "merged between" filter, hence over-fetching by
 * `sort=updated` and filtering `merged_at` client-side). `GET
 * /repos/{repo}/actions/runs` wraps its array as `{ workflow_runs: [...] }`;
 * each run's `name` is the workflow's display name, `conclusion` is `null`
 * until the run completes, and `created_at` is the field the `created`
 * range filter matches against — that filter accepts FULL ISO-8601
 * timestamps (`created:2016-03-21T14:11:00Z..*` per GitHub's own
 * search-qualifier docs), NOT date-only as this adapter's first draft
 * incorrectly assumed (Fix Round 1, FIX 3 — corrected after review; see
 * {@link fetchWorkflowRuns}'s own doc-comment).
 *
 * Fix round 1 (coordinator review): (1) failure/caveat markers made
 * cap-exempt and rendered first, so a busy repo's real lines can never push
 * a sibling repo's failure out of the response — see "RENDERING" above.
 * (2) a per-repo fetch-horizon caveat on the PR leg, mirroring factory.ts's
 * own horizon caveat — see {@link fetchMergedPrs}. (3) the `created` range
 * filter now uses full ISO-8601 timestamps (the date-only claim in this
 * adapter's first draft was wrong) plus a client-side re-filter on each
 * run's own `created_at`, belt-and-braces — see {@link fetchWorkflowRuns}.
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
  /** Fix Round 1, FIX 2 — read for the fetch-horizon caveat check; see
   * {@link fetchMergedPrs}'s own doc-comment. */
  updated_at?: unknown;
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
 * lines (plus an optional fetch-horizon `caveat`, Fix Round 1 FIX 2 — see
 * {@link fetchMergedPrs}; always `null` for the runs leg), or the one marker
 * that collapses the whole repo (see this module's own doc-comment,
 * "PER-REPO FAILURE GRANULARITY"). */
type RepoOutcome =
  | { ok: true; lines: RenderedLine[]; caveat: string | null }
  | { ok: false; marker: string };

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
 *
 * FIX ROUND 1, FIX 2 — fetch-horizon honesty (factory.ts's own horizon-
 * caveat pattern, mirrored one layer in): the {@link PR_MAX_PAGES} cap means
 * a repo with more than 200 PRs sorted ahead by `updated_at` can hide an
 * in-window merge whose `updated_at` happens to be OLDER than everything
 * this fetch saw. When BOTH pages come back full (200 items total, i.e. the
 * loop never found a natural "last page") AND the LAST-fetched item's
 * `updated_at` is STILL more recent than `windowStart` (the fetch never
 * reached back far enough to rule out matches further behind), this
 * appends a caveat line to the returned outcome. A caveat is NOT a failure
 * — the fetch succeeded, and the caveat rides alongside whatever real lines
 * were found — but is CAP-EXEMPT and rendered first exactly like a failure
 * marker (see this module's own doc-comment, "RENDERING").
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

  let pagesFetched = 0;
  let fullPageCount = 0;
  let lastUpdatedAtMs: number | null = null;

  for (let page = 1; page <= PR_MAX_PAGES; page++) {
    const url =
      `${GITHUB_API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc` +
      `&per_page=${PR_PER_PAGE}&page=${page}`;
    const res = await getJson(repo, url, token);
    if (!res.ok) return res;

    const entries = Array.isArray(res.body) ? (res.body as GithubPrEntry[]) : [];
    pagesFetched += 1;
    if (entries.length === PR_PER_PAGE) fullPageCount += 1;

    for (const entry of entries) {
      // Tracked for EVERY entry (not just ones that end up `lines`) — the
      // horizon question is "how far back by update-recency did we look",
      // independent of how many of those entries happened to be in-window
      // merges.
      const updatedAtRaw = typeof entry.updated_at === "string" ? entry.updated_at : null;
      if (updatedAtRaw) {
        const updatedAtMs = new Date(updatedAtRaw).getTime();
        if (!Number.isNaN(updatedAtMs)) lastUpdatedAtMs = updatedAtMs;
      }

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

  const horizonUncertain =
    pagesFetched === PR_MAX_PAGES &&
    fullPageCount === PR_MAX_PAGES &&
    lastUpdatedAtMs !== null &&
    lastUpdatedAtMs > startMs;
  const caveat = horizonUncertain
    ? `(repo ${repo}: note — only the 200 most recently updated PRs were searched; older in-window merges may be missing)`
    : null;

  return { ok: true, lines, caveat };
}

/**
 * Actions runs for `repo`, `created` within `[windowStart, windowEnd]`; a
 * single page. FIX ROUND 1, FIX 3: this adapter's first draft assumed
 * GitHub's `created` search qualifier was date-granularity only and sent a
 * `YYYY-MM-DD..YYYY-MM-DD` range — WRONG, confirmed against GitHub's own
 * search-qualifier docs (`created:2016-03-21T14:11:00Z..*` syntax is
 * documented and valid), so the raw `windowStart`/`windowEnd` ISO
 * timestamps are now sent verbatim, at full precision. A client-side
 * re-filter on each run's own `created_at` still runs afterward
 * (belt-and-braces — mirrors {@link fetchMergedPrs}'s inclusive-bounds
 * check) rather than trusting the server-side filter alone; this adapter
 * has already been wrong once about GitHub's exact filtering behavior.
 */
async function fetchWorkflowRuns(
  repo: string,
  token: string,
  windowStart: string,
  windowEnd: string
): Promise<RepoOutcome> {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const createdRange = `${windowStart}..${windowEnd}`;
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
    // Client-side re-filter (belt-and-braces) — inclusive bounds, same as
    // fetchMergedPrs, even though `created` is also sent server-side.
    if (Number.isNaN(createdAtMs) || createdAtMs < startMs || createdAtMs > endMs) continue;

    const name = typeof entry.name === "string" && entry.name ? entry.name : "-";
    const conclusion =
      typeof entry.conclusion === "string" && entry.conclusion ? entry.conclusion : "in_progress";

    lines.push({
      at: createdAtMs,
      line: `actions_run ${repo} ${name} conclusion=${conclusion} at=${new Date(createdAtMs).toISOString()}`,
    });
  }

  return { ok: true, lines, caveat: null };
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
  // runs.caveat is always null (fetchWorkflowRuns never produces one) — only
  // prs.caveat can carry the fetch-horizon note.
  return { ok: true, lines: [...prs.lines, ...runs.lines], caveat: prs.caveat };
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
    // Failure markers AND fetch-horizon caveats (Fix Round 1, FIX 2) share
    // this one array — both are cap-exempt and rendered first, see below.
    const markers: string[] = [];
    let successCount = 0;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successCount += 1;
        allLines.push(...outcome.lines);
        if (outcome.caveat) markers.push(outcome.caveat);
      } else {
        markers.push(outcome.marker);
      }
    }

    if (successCount === 0) {
      return { ok: false, reason: "upstream_error" };
    }

    if (allLines.length === 0 && markers.length === 0) {
      return { ok: true, raw: NO_CHANGES_MARKER };
    }

    allLines.sort((a, b) => b.at - a.at); // most recent first, across repos and event kinds

    // Fix Round 1, FIX 1: markers are CAP-EXEMPT and rendered FIRST — a
    // busy repo's real lines filling the cap must never silently push a
    // sibling repo's failure (or fetch-horizon caveat) out of the response.
    // Only the real event lines are subject to `limit`; factory.ts's clamp
    // is mirrored on that half alone: a limit of 0/negative must never
    // slice a non-empty result down to a bare "" that bypasses the honest
    // empty marker above.
    const limit = Math.max(1, q.limit ?? DEFAULT_LIMIT);
    const cappedEventLines = allLines.slice(0, limit).map((l) => l.line);
    return { ok: true, raw: [...markers, ...cappedEventLines].join("\n") };
  },
};

registerAdapter(githubAdapter);
