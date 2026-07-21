// Pure, dependency-free helpers for Jace's SECOND write path into the
// AgentRail factory (issue #1345): editing an EXISTING GitHub issue's
// title/body in the house format by shelling out to `agentrail issue update`.
// Everything here is side-effect-free and dependency-injected so it is
// unit-testable without a network or a real CLI — mirrors
// create_issue.core.mjs's own posture exactly, including the anti-prompt-
// injection hardening (issue #1124): every field a caller supplies still
// passes through hardenUntrusted() before it is rendered onto GitHub, since
// an update, same as a create, can be reached from a Jace conversation that
// drafted from untrusted (researcher-derived) text.
//
// This file lives under agent/lib/ which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.
//
// WHY THIS EXISTS (#1345): today, denying an alignment brief parks the queue
// entry with a denial reason PERMANENTLY — there is no mechanized way to
// reshape the ask and try again. This tool is the write half of the fix: Jace
// calls it (gated by the exact same consoleGatedApproval seam create_issue
// uses) to rewrite the issue's body with the user's revised scope, and then
// — best-effort, never blocking the tool's own result — asks the console to
// compose+post a FRESH alignment brief for the queue entry this issue maps
// to (see `triggerReviseAlignmentBrief` below). The actual "supersede the
// denial" state transition lives server-side
// (`@agentrail/db-postgres`'s `reviseAlignmentBrief`) — this module only
// ever asks for it; it holds no opinion on whether the entry was denied at
// all, since `update_issue` is also a plain general-purpose house-format
// edit tool independent of the revise loop.

import { buildIssueBody, NOT_CONNECTED_MARKER } from "./create_issue.core.mjs";
import { hardenUntrusted, FIELD_CAPS } from "./sanitize-untrusted.core.mjs";
import { resolveConsoleConfig } from "./console_gated_approval.core.mjs";

// Re-exported so callers/tests that only need the house-format body builder
// (or the shared not-connected marker) can import them from this module too,
// without needing to know they actually live in create_issue.core.mjs (an
// implementation detail — the two tools share ONE house-format renderer and
// ONE CLI-failure marker so the two can never drift).
export { buildIssueBody, NOT_CONNECTED_MARKER };

/**
 * Build the argv array (WITHOUT the binary) for `agentrail issue update`.
 *
 * Unlike create's argv, this never passes `--label`/nothing new gets applied
 * server-side either — `agentrail issue update` never touches labels, state,
 * or comments (see `issue.py::_update_via_connector` / `GitHubOAuthClient
 * .update_issue`), by design: a house-format BODY edit only.
 *
 * `repo` is OPTIONAL, same resolution rule as create's argv builder: when
 * omitted, `--repo` is left off and the CLI resolves it from the workspace's
 * connected GitHub repo.
 *
 * @param {object} input
 * @param {string} [input.repo] - "owner/repo"; omitted lets the CLI resolve it
 * @param {number} input.number - the existing issue number to edit
 * @param {string} input.title
 * @param {string} input.body - full house-format markdown
 * @returns {string[]}
 */
export function buildUpdateArgv({ repo, number, title, body } = {}) {
  const argv = ["issue", "update", "--connector", "github"];
  if (repo) argv.push("--repo", repo);
  argv.push("--number", String(number), "--title", title, "--body", body);
  return argv;
}

/**
 * Parse the single success line the CLI prints on stdout, e.g.:
 *   Updated Bensigo/agentrail#1042: https://github.com/Bensigo/agentrail/issues/1042
 *
 * @param {string} stdout
 * @returns {{ repo: string, number: number, url: string }}
 */
export function parseUpdateOutput(stdout) {
  const text = String(stdout ?? "");
  const match = text.match(/^Updated\s+([^#\s]+)#(\d+)\s*:\s*(\S+)/m);
  if (!match) {
    throw new Error(
      "parseUpdateOutput: could not parse the CLI success line. Raw stdout was:\n" +
        text,
    );
  }
  const [, repo, number, url] = match;
  return { repo, number: Number(number), url };
}

// ---------------------------------------------------------------------------
// #1345 PR② hook — the revise loop's re-briefing trigger. A best-effort,
// server-side POST asking the console: "if this (repo, number) maps to a
// queue entry that is currently DENIED, supersede that denial with a fresh
// alignment brief composed from the NEW title/body." The console owns every
// bit of that decision (queue-entry lookup, the denied-state guard, and the
// actual compose+record+send) — this module just asks; a "no such entry" or
// "not currently denied" answer is a perfectly normal no-op for the (more
// common) case of update_issue editing an issue that was never part of the
// alignment gate at all.
// ---------------------------------------------------------------------------

/**
 * The console-owned revise-brief seam (#1345), joined onto the console base
 * — the sibling of `buildApprovalsUrl`/`buildPublishedStampUrl`.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildReviseAlignmentBriefUrl(baseUrl) {
  return `${baseUrl}/api/v1/runner/queue-entries/revise`;
}

// Per-HTTP-call timeout, mirroring create_issue.core.mjs's own
// STAMP_REQUEST_TIMEOUT_MS idiom (8000ms) — each core module owns its own
// transport default rather than sharing one, matching the established
// pattern in this directory.
const REVISE_REQUEST_TIMEOUT_MS = 8000;

/** Real fetch with a timeout — mirrors the sibling *.core.mjs modules' own realTransport idiom. */
async function realReviseTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVISE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort: ask the console to revise+re-brief the queue entry this
 * (repo, number) maps to, using the NEW title/body this update_issue call
 * just wrote to GitHub.
 *
 * NEVER throws and NEVER affects the caller's own result (same locked design
 * as `create_issue.core.mjs::stampCreatedIssueUrl`): a failed trigger — a
 * timeout, a non-2xx, a network error, a missing console config, or missing
 * session context (`eveSessionId` absent) — just means the issue's body WAS
 * updated on GitHub but no fresh brief went out. That degrades to "the user
 * has to explicitly ask again" rather than a broken or bypassed alignment
 * gate: the queue entry, if it exists at all, is left exactly as it was
 * (still parked, still carrying whatever park reason it had) — this call
 * only ever ASKS for the supersede, it never performs any part of it
 * client-side.
 *
 * @param {{eveSessionId?: string, repo: string, number: number, title: string, body: string, env?: Record<string,string|undefined>, transport?: Function}} args
 * @returns {Promise<void>}
 */
export async function triggerReviseAlignmentBrief({
  eveSessionId,
  repo,
  number,
  title,
  body,
  env = {},
  transport = realReviseTransport,
}) {
  try {
    const sessionId = String(eveSessionId ?? "").trim();
    if (!sessionId) return;

    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return;

    const url = buildReviseAlignmentBriefUrl(cfg.baseUrl);
    await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        eveSessionId: sessionId,
        repoFullName: repo,
        number,
        title,
        body,
      }),
    });
  } catch {
    // Belt-and-suspenders: see this function's own "NEVER throws" doc-comment.
  }
}

/**
 * Orchestrate a single issue edit. Dependency-injected and otherwise
 * side-effect-free, mirroring `create_issue.core.mjs::runCreateIssue`'s own
 * shape: `execFileFn` is a promisified execFile-style function
 * `(bin, argv, opts) => Promise<{ stdout, stderr }>`.
 *
 * The target repo is NOT required from the caller or the environment — same
 * resolution rule as create (see that function's own doc-comment): omitted
 * `repo` lets the CLI resolve it from the workspace's connected GitHub repo.
 *
 * When the CLI can resolve NEITHER a repo NOR a token for this workspace, it
 * fails with {@link NOT_CONNECTED_MARKER} on stderr (re-exported from
 * create_issue.core.mjs, same marker both tools' CLI paths share); this
 * function catches that specific case and returns a friendly
 * `{ connected: false, message }` result instead of throwing. Any OTHER CLI
 * failure (bad issue number, network trouble, `gh`/API errors) still throws.
 *
 * @param {object} input
 * @param {(bin: string, argv: string[], opts: object) => Promise<{stdout: string, stderr?: string}>} input.execFileFn
 * @param {NodeJS.ProcessEnv} input.env
 * @param {string} [input.repo] - explicit override; falls back to env.JACE_TARGET_REPO (last resort), then to the CLI's own workspace lookup
 * @param {number} input.issueNumber - the existing issue number to edit
 * @param {string} input.title
 * @param {string} [input.parent]
 * @param {string} [input.requiredContext]
 * @param {string} [input.whatToBuild]
 * @param {string[]} input.acceptanceCriteria
 * @param {string} [input.verification]
 * @param {string} [input.eveSessionId] - #1345: the calling Eve session id, for the best-effort revise-brief trigger (see triggerReviseAlignmentBrief). Absent -> the trigger is skipped, never an error.
 * @param {string} [input.turnId] - unused today (parity with create_issue's signature; kept for call-site symmetry and any future use).
 * @param {unknown} [input.toolInput] - unused today (parity with create_issue's signature).
 * @param {Function} [input.reviseTransport] - test-only: inject the revise-trigger's HTTP transport.
 * @returns {Promise<{ repo: string, number: number, url: string } | { connected: false, message: string }>}
 */
export async function runUpdateIssue({
  execFileFn,
  env,
  repo,
  issueNumber,
  title,
  parent,
  requiredContext,
  whatToBuild,
  acceptanceCriteria,
  verification,
  eveSessionId,
  reviseTransport,
} = {}) {
  const resolvedEnv = env ?? {};
  const bin = resolvedEnv.JACE_AGENTRAIL_BIN || "agentrail";
  // Last-resort override only — an unset repo is NOT an error here; the CLI
  // resolves it from the workspace's connected GitHub repo.
  const resolvedRepo = repo || resolvedEnv.JACE_TARGET_REPO || "";

  if (!issueNumber) {
    throw new Error("runUpdateIssue: `issueNumber` is required.");
  }
  if (!title) {
    throw new Error("runUpdateIssue: `title` is required.");
  }

  const body = buildIssueBody({
    parent,
    requiredContext,
    whatToBuild,
    acceptanceCriteria,
    verification,
  });
  // The title never passes through buildIssueBody, so it must be hardened
  // here — otherwise a mass-ping token or hidden channel in a
  // researcher-tainted title would reach GitHub unfiltered (mirrors
  // create_issue.core.mjs's own runCreateIssue).
  const safeTitle = hardenUntrusted(title, { maxLen: FIELD_CAPS.title });
  const argv = buildUpdateArgv({
    repo: resolvedRepo,
    number: issueNumber,
    title: safeTitle,
    body,
  });

  let result;
  try {
    result = await execFileFn(bin, argv, { env: resolvedEnv });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : "";
    if (stderr.includes(NOT_CONNECTED_MARKER)) {
      const consoleUrl = String(resolvedEnv.JACE_CONSOLE_BASE_URL ?? "")
        .trim()
        .replace(/\/+$/, "");
      const where = consoleUrl ? ` (${consoleUrl})` : "";
      return {
        connected: false,
        message:
          "I can't edit that issue yet — no GitHub repo is connected for " +
          `this workspace. Connect a repo on the AgentRail console${where} ` +
          "(Settings → Connectors → GitHub), then try again.",
      };
    }
    throw new Error(
      `runUpdateIssue: \`${bin} issue update\` failed: ${err && err.message ? err.message : String(err)}${stderr ? `\n${stderr}` : ""}`,
    );
  }

  const ref = parseUpdateOutput(result.stdout);

  // #1345: best-effort — AWAITED so the attempt is fully made (or times out)
  // before this function returns, rather than a fire-and-forget that could
  // be torn down mid-flight; mirrors create_issue.core.mjs's own
  // stampCreatedIssueUrl call site and its "NEVER affects the caller's own
  // result" posture.
  await triggerReviseAlignmentBrief({
    eveSessionId,
    repo: ref.repo,
    number: ref.number,
    title: safeTitle,
    body,
    env: resolvedEnv,
    transport: reviseTransport,
  });

  return ref;
}
