// ---------------------------------------------------------------------------
// CI reconciliation (#891b / #906)
// ---------------------------------------------------------------------------
//
// `recordRunnerResult` sets a run's persisted status purely from the runner's
// LOCAL gate verdict (green/red/error). The PR's real CI is async — it is still
// pending when the runner reports — so a run whose local gate went red but whose
// PR's CI is GREEN would be shown `failed` on the dashboard forever.
//
// This module reconciles the DISPLAYED status against the PR's real CI at read
// time, following the existing `reconcileStaleRuns` best-effort seam: it is
// strictly best-effort (a CI-fetch failure NEVER crashes the view) and it is
// throttled so we don't hit the GitHub API for every run on every read.
//
// The CI-conclusion → displayed-status decision is the PURE, exported
// `reconcileRunDisplayStatus` so the AC verification is a unit test with a faked
// CI fetch; the GitHub fetch + throttle are the impure shell around it.

import { getInstallationToken } from "./github-app-token.js";

/** The persisted run status enum (see schema/runs.ts). */
export type RunDisplayStatus = "queued" | "running" | "success" | "failed";

/**
 * The CI conclusion for a PR, normalised to the only three things the display
 * mapping cares about. `null` means "we have no usable CI signal" (no PR, fetch
 * failed, or the PR has no checks at all) — treated like the local verdict.
 */
export type CiConclusion = "green" | "red" | "pending" | null;

/** owner/repo/number parsed from a GitHub PR html_url. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub PR html_url into owner/repo/number. Accepts the canonical
 * `https://github.com/<owner>/<repo>/pull/<n>` form (the shape `recordRunnerResult`
 * persists). Returns null for anything else so the caller treats it as "no PR".
 */
export function parsePrUrl(prUrl: string | null | undefined): PrRef | null {
  if (!prUrl) return null;
  const m = prUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i
  );
  if (!m) return null;
  const n = Number(m[3]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { owner: m[1]!, repo: m[2]!, number: n };
}

/**
 * The PURE CI-conclusion → displayed-status decision. Extracted so the ACs are
 * verifiable without a live GitHub or Postgres.
 *
 *   AC1: PR CI green  → `success` (PR-ready), EVEN IF the local gate was red.
 *   AC2: no PR, or PR CI red → keep the local gate's terminal verdict
 *        (i.e. stays `failed`); a missing CI signal NEVER manufactures a green.
 *   AC4: PR CI pending/in-progress → `running` (in-progress), NOT terminal failed.
 *
 * Only a `failed` gate verdict is ever reconciled UP — a green/running/queued
 * run is returned unchanged (we never demote a success on a CI hiccup, and a
 * still-running run has no PR verdict to reconcile yet). This is the single
 * place a false-green could be introduced, so it is deliberately conservative:
 * `success` is returned ONLY when `ciConclusion === "green"` AND a PR was
 * actually resolved.
 */
export function reconcileRunDisplayStatus(input: {
  gateStatus: RunDisplayStatus;
  prUrl: string | null | undefined;
  ciConclusion: CiConclusion;
}): RunDisplayStatus {
  const { gateStatus, prUrl, ciConclusion } = input;

  // Only a failed run is a candidate for CI reconciliation. green/running/queued
  // are left exactly as persisted — we never demote a real success or guess a
  // verdict for a run still in flight.
  if (gateStatus !== "failed") return gateStatus;

  const pr = parsePrUrl(prUrl);
  // AC2: no PR → still failed (no false greens).
  if (!pr) return "failed";

  switch (ciConclusion) {
    // AC1: green CI → success/PR-ready, overriding the red local gate.
    case "green":
      return "success";
    // AC4: CI still running → in-progress, NOT terminal failed.
    case "pending":
      return "running";
    // AC2: red CI, or no usable CI signal (fetch failed / no checks) → stay
    // failed. Never invent a green.
    case "red":
    case null:
    default:
      return "failed";
  }
}

// ---------------------------------------------------------------------------
// Impure shell: fetch the PR's CI conclusion over the GitHub REST API.
// ---------------------------------------------------------------------------

/** Injectable fetch so the wiring is testable without real network I/O. */
export type FetchLike = typeof fetch;

interface GithubCheckRun {
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "neutral" | ... (when completed)
}

/**
 * Fetch a PR's CI conclusion via the GitHub REST API, normalised to
 * {@link CiConclusion}. Best-effort: ANY failure (network, non-2xx, malformed
 * body, parse error) resolves to `null` and is NEVER thrown — the caller must be
 * able to treat a fetch failure exactly like "no signal" so the dashboard view
 * never crashes on a flaky GitHub.
 *
 * API used (REST, no GraphQL): resolve the PR's head SHA via
 *   GET /repos/{owner}/{repo}/pulls/{number}
 * then read that commit's check-runs via
 *   GET /repos/{owner}/{repo}/commits/{sha}/check-runs
 * Conclusion roll-up over the check-runs:
 *   - any check still queued/in_progress (not completed) → "pending"  (AC4)
 *   - any completed check failed/timed_out/cancelled/etc. → "red"     (AC2)
 *   - at least one completed check, all non-failing      → "green"    (AC1)
 *   - zero check-runs (CI not configured / none reported yet) → null  (no signal)
 */
export async function fetchPrCiConclusion(
  pr: PrRef,
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<CiConclusion> {
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agentrail-console",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const prRes = await fetchImpl(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { headers }
    );
    if (!prRes.ok) return null;
    const prBody = (await prRes.json()) as { head?: { sha?: string } };
    const sha = prBody?.head?.sha;
    if (!sha) return null;

    const checksRes = await fetchImpl(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/commits/${sha}/check-runs`,
      { headers }
    );
    if (!checksRes.ok) return null;
    const checksBody = (await checksRes.json()) as {
      check_runs?: GithubCheckRun[];
    };
    const checkRuns = checksBody?.check_runs ?? [];

    return rollupCheckRuns(checkRuns);
  } catch {
    // Best-effort: never throw into the view/claim.
    return null;
  }
}

/** Roll a list of check-runs up to a single {@link CiConclusion}. Pure/exported
 * so the roll-up rules are unit-testable independently of the fetch. */
export function rollupCheckRuns(
  checkRuns: Array<{ status: string; conclusion: string | null }>
): CiConclusion {
  if (checkRuns.length === 0) return null; // no checks reported → no signal

  let anyPending = false;
  let anyFailed = false;
  for (const run of checkRuns) {
    if (run.status !== "completed") {
      anyPending = true;
      continue;
    }
    // A completed check with a non-success-ish conclusion is a failure. GitHub's
    // passing conclusions are success / neutral / skipped; everything else
    // (failure, timed_out, cancelled, action_required, stale) is a red.
    const ok =
      run.conclusion === "success" ||
      run.conclusion === "neutral" ||
      run.conclusion === "skipped";
    if (!ok) anyFailed = true;
  }

  // A hard failure beats a still-pending check: if anything has already failed,
  // the PR is not going green, so report red now (AC2 — no waiting on a doomed run).
  if (anyFailed) return "red";
  if (anyPending) return "pending";
  return "green";
}

// ---------------------------------------------------------------------------
// Read-path enrichment: reconcile a batch of runs, throttled + best-effort.
// ---------------------------------------------------------------------------

/** The minimal run shape the reconciler needs from the read path. */
export interface ReconcilableRun {
  id: string;
  status: RunDisplayStatus;
  prUrl: string | null;
}

/**
 * Reconcile the DISPLAYED status of a batch of runs against their PRs' real CI.
 * Returns a Map of run id → reconciled status, containing ONLY the runs whose
 * status changed (callers overlay it on the persisted status). Best-effort: any
 * failure resolving the token or a single PR's CI is swallowed.
 *
 * Throttle / selection — to stay GitHub-rate-considerate we only fetch CI for
 * runs that actually NEED it:
 *   - status === "failed"  (the only status `reconcileRunDisplayStatus` can move)
 *   - AND a parseable `pr_url`  (no PR → already correctly `failed`, AC2)
 * Runs that are already success/running/queued, or have no PR, are skipped
 * entirely (zero GitHub calls). The fetched count is further capped by
 * `maxFetches` so one over-long page of failed runs can't fan out into an
 * unbounded burst of GitHub requests on a single dashboard read.
 *
 * NOTE: this reconciles the DISPLAY only; it does NOT write back to Postgres. CI
 * is still in flight for many runs, so persisting here would race the runner and
 * fight `recordRunnerResult`. The display is recomputed on each read (cheap and
 * always-fresh) — a future enhancement could memoise a terminal green CI.
 */
export async function reconcileRunsCiStatus(
  workspaceId: string,
  runs: ReconcilableRun[],
  opts: { maxFetches?: number; fetchImpl?: FetchLike } = {}
): Promise<Map<string, RunDisplayStatus>> {
  const maxFetches = opts.maxFetches ?? 10;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out = new Map<string, RunDisplayStatus>();

  // Selection: only failed runs WITH a parseable PR are reconcilable.
  const candidates = runs.filter(
    (r) => r.status === "failed" && parsePrUrl(r.prUrl) !== null
  );
  if (candidates.length === 0) return out;

  let token: string | null = null;
  try {
    token = await getInstallationToken(workspaceId);
  } catch {
    // Best-effort — no token, no reconciliation.
    return out;
  }
  if (!token) return out;

  for (const run of candidates.slice(0, maxFetches)) {
    const pr = parsePrUrl(run.prUrl)!;
    let ciConclusion: CiConclusion = null;
    try {
      ciConclusion = await fetchPrCiConclusion(pr, token, fetchImpl);
    } catch {
      ciConclusion = null; // defensive; fetchPrCiConclusion already never throws
    }
    const reconciled = reconcileRunDisplayStatus({
      gateStatus: run.status,
      prUrl: run.prUrl,
      ciConclusion,
    });
    if (reconciled !== run.status) out.set(run.id, reconciled);
  }

  return out;
}
