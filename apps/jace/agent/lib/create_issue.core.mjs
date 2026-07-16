// Pure, dependency-free helpers for Jace's single write path into the AgentRail
// factory: creating ONE GitHub issue in the house format by shelling out to the
// existing `agentrail issue create` CLI. Everything here is side-effect-free and
// dependency-injected so it is unit-testable without a network or a real CLI.
//
// This file lives under agent/lib/ which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.
//
// This is also the enforced anti-prompt-injection seam (issue #1124). The
// researcher subagent's brief reaches Jace as a MODEL-READ tool result — Eve
// lowers a task-mode subagent's structured output straight into the parent's
// tool stream, and Eve hooks are observe-only, so there is NO Jace-authored
// code between the child emitting the brief and the parent drafting from it.
// The first place Jace code touches that (now untrusted-tainted) text again is
// this write path, so every field is run through hardenUntrusted() before it is
// rendered onto GitHub. See sanitize-untrusted.core.mjs for what that removes
// and, honestly, what it cannot.

import { hardenUntrusted, FIELD_CAPS } from "./sanitize-untrusted.core.mjs";

// Stable marker the CLI (`agentrail issue create --connector github`, see
// agentrail/cli/commands/issue.py) prefixes onto its stderr when it could not
// resolve EITHER a target repo or a GitHub token for this workspace by any
// means (no --repo, no GITHUB_OAUTH_TOKEN/GITHUB_TOKEN env, AND its own
// Postgres fallback found nothing connected for AGENTRAIL_WORKSPACE_ID). This
// is what lets `runCreateIssue` tell "the user hasn't connected a repo yet"
// apart from a genuine CLI/network/auth failure, so it can hand back friendly
// guidance instead of a raw stack-trace-shaped error (issue: connect-repo
// sufficiency fix).
export const NOT_CONNECTED_MARKER = "AGENTRAIL_NOT_CONNECTED";

/**
 * Friendly "connect a repo first" guidance shown instead of the raw CLI error
 * when the CLI reports {@link NOT_CONNECTED_MARKER}. Includes the console URL
 * when Jace has one configured (JACE_CONSOLE_BASE_URL — the same var
 * fetch_workspace_memory already reads) so the user knows exactly where to go.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function notConnectedGuidance(env = {}) {
  const consoleUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const where = consoleUrl ? ` (${consoleUrl})` : "";
  return (
    "I can't create an issue yet — no GitHub repo is connected for this " +
    `workspace. Connect a repo on the AgentRail console${where} ` +
    "(Settings → Connectors → GitHub), then try again."
  );
}

/**
 * Build the AgentRail "house format" issue body.
 *
 * The Acceptance criteria section MUST render each criterion as a checkbox
 * (`- [ ] ACn: ...`). The factory's `validateAcceptanceCriteria` gate rejects
 * any body whose Acceptance criteria section has no `- [ ]` checkbox, so an
 * empty acceptanceCriteria array is a hard error here.
 *
 * @param {object} input
 * @param {string} [input.parent]
 * @param {string} [input.requiredContext]
 * @param {string} [input.whatToBuild]
 * @param {string[]} input.acceptanceCriteria - non-empty list of criteria
 * @param {string} [input.verification]
 * @returns {string} house-format markdown
 */
export function buildIssueBody({
  parent,
  requiredContext,
  whatToBuild,
  acceptanceCriteria,
  verification,
} = {}) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new Error(
      "buildIssueBody: acceptanceCriteria must be a non-empty array; " +
        "an issue with no checkboxed Acceptance criteria is rejected by the factory's validateAcceptanceCriteria gate.",
    );
  }

  // hardenUntrusted subsumes the old `.trim()`, and additionally strips hidden
  // channels, defangs dangerous URL schemes / mass-ping tokens, and caps each
  // field's length — the enforced guardrail against injection carried in from
  // researcher-derived web content.
  const criteriaLines = acceptanceCriteria
    .map(
      (criterion, i) =>
        `- [ ] AC${i + 1}: ${hardenUntrusted(String(criterion), {
          maxLen: FIELD_CAPS.acceptanceCriterion,
        })}`,
    )
    .join("\n");

  const sections = [
    "## Parent",
    hardenUntrusted(parent, { maxLen: FIELD_CAPS.parent }),
    "",
    "## Required context",
    hardenUntrusted(requiredContext, { maxLen: FIELD_CAPS.requiredContext }),
    "",
    "## What to build",
    hardenUntrusted(whatToBuild, { maxLen: FIELD_CAPS.whatToBuild }),
    "",
    "## Acceptance criteria",
    criteriaLines,
    "",
    "## Verification evidence",
    hardenUntrusted(verification, { maxLen: FIELD_CAPS.verification }),
  ];

  return sections.join("\n");
}

/**
 * Build the argv array (WITHOUT the binary) for `agentrail issue create`.
 *
 * The trigger label `ready-for-agent` is applied SERVER-SIDE by the CLI in
 * connector mode; we deliberately do NOT pass any labels.
 *
 * `repo` is OPTIONAL: when omitted (or empty), `--repo` is left off entirely
 * and the CLI resolves the target repo itself from the workspace's connected
 * GitHub repo (the same one "connect a repo" writes on the console) — this is
 * what lets Jace work without a manually-set JACE_TARGET_REPO. Pass `repo`
 * only for an explicit override (a caller-supplied repo, or the
 * JACE_TARGET_REPO last-resort env fallback — see {@link runCreateIssue}).
 *
 * @param {object} input
 * @param {string} [input.repo] - "owner/repo"; omitted lets the CLI resolve it
 * @param {string} input.title
 * @param {string} input.body - full house-format markdown
 * @returns {string[]}
 */
export function buildCreateArgv({ repo, title, body } = {}) {
  const argv = ["issue", "create", "--connector", "github"];
  if (repo) argv.push("--repo", repo);
  argv.push("--title", title, "--body", body);
  return argv;
}

/**
 * Parse the single success line the CLI prints on stdout, e.g.:
 *   Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042
 *
 * @param {string} stdout
 * @returns {{ repo: string, number: number, label: string, url: string }}
 */
export function parseCreateOutput(stdout) {
  const text = String(stdout ?? "");
  const match = text.match(
    /^Created\s+([^#\s]+)#(\d+)\s+\(label\s+([^)]+)\)\s*:\s*(\S+)/m,
  );
  if (!match) {
    throw new Error(
      "parseCreateOutput: could not parse the CLI success line. Raw stdout was:\n" +
        text,
    );
  }
  const [, repo, number, label, url] = match;
  return {
    repo,
    number: Number(number),
    label: label.trim(),
    url,
  };
}

/**
 * Orchestrate a single issue creation. Dependency-injected and otherwise
 * side-effect-free: `execFileFn` is a promisified execFile-style function
 * `(bin, argv, opts) => Promise<{ stdout, stderr }>`.
 *
 * The target repo is NOT required from the caller or the environment: when
 * `repo` is omitted, `--repo` is left off the CLI invocation entirely and the
 * CLI resolves it itself from the workspace's connected GitHub repo (the one
 * "connect a repo" writes on the console) — connecting a repo on the console is
 * the only thing a user should ever need to do. `env.JACE_TARGET_REPO` is
 * still honored, but only as a LAST-RESORT override for deployments that need
 * to pin a specific repo; it is never required. Likewise, no GitHub token needs
 * to be supplied here — the CLI resolves that from the workspace's connection
 * too (see agentrail/cli/commands/issue.py).
 *
 * When the CLI can resolve NEITHER a repo NOR a token for this workspace, it
 * fails with {@link NOT_CONNECTED_MARKER} on stderr; this function catches
 * that specific case and returns a friendly `{ connected: false, message }`
 * result instead of throwing, so the tool can relay clear guidance ("connect a
 * repo on the console") rather than a raw CLI error. Any OTHER CLI failure
 * (bad title, network trouble, `gh`/API errors) still throws as before.
 *
 * @param {object} input
 * @param {(bin: string, argv: string[], opts: object) => Promise<{stdout: string, stderr?: string}>} input.execFileFn
 * @param {NodeJS.ProcessEnv} input.env
 * @param {string} [input.repo] - explicit override; falls back to env.JACE_TARGET_REPO (last resort), then to the CLI's own workspace lookup
 * @param {string} input.title
 * @param {string} [input.parent]
 * @param {string} [input.requiredContext]
 * @param {string} [input.whatToBuild]
 * @param {string[]} input.acceptanceCriteria
 * @param {string} [input.verification]
 * @returns {Promise<{ repo: string, number: number, url: string, label: string } | { connected: false, message: string }>}
 */
export async function runCreateIssue({
  execFileFn,
  env,
  repo,
  title,
  parent,
  requiredContext,
  whatToBuild,
  acceptanceCriteria,
  verification,
} = {}) {
  const resolvedEnv = env ?? {};
  const bin = resolvedEnv.JACE_AGENTRAIL_BIN || "agentrail";
  // Last-resort override only — an unset repo is NOT an error here; the CLI
  // resolves it from the workspace's connected GitHub repo.
  const resolvedRepo = repo || resolvedEnv.JACE_TARGET_REPO || "";

  if (!title) {
    throw new Error("runCreateIssue: `title` is required.");
  }

  const body = buildIssueBody({
    parent,
    requiredContext,
    whatToBuild,
    acceptanceCriteria,
    verification,
  });
  // The title never passes through buildIssueBody, so it must be hardened here
  // — otherwise a mass-ping token or hidden channel in a researcher-tainted
  // title would reach GitHub unfiltered.
  const safeTitle = hardenUntrusted(title, { maxLen: FIELD_CAPS.title });
  const argv = buildCreateArgv({ repo: resolvedRepo, title: safeTitle, body });

  let result;
  try {
    result = await execFileFn(bin, argv, { env: resolvedEnv });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : "";
    if (stderr.includes(NOT_CONNECTED_MARKER)) {
      return { connected: false, message: notConnectedGuidance(resolvedEnv) };
    }
    throw new Error(
      `runCreateIssue: \`${bin} issue create\` failed: ${err && err.message ? err.message : String(err)}${stderr ? `\n${stderr}` : ""}`,
    );
  }

  return parseCreateOutput(result.stdout);
}
