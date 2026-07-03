// Pure, dependency-free helpers for Jace's single write path into the AgentRail
// factory: creating ONE GitHub issue in the house format by shelling out to the
// existing `agentrail issue create` CLI. Everything here is side-effect-free and
// dependency-injected so it is unit-testable without a network or a real CLI.
//
// This file lives under agent/lib/ which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.

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

  const criteriaLines = acceptanceCriteria
    .map((criterion, i) => `- [ ] AC${i + 1}: ${String(criterion).trim()}`)
    .join("\n");

  const sections = [
    "## Parent",
    (parent ?? "").trim(),
    "",
    "## Required context",
    (requiredContext ?? "").trim(),
    "",
    "## What to build",
    (whatToBuild ?? "").trim(),
    "",
    "## Acceptance criteria",
    criteriaLines,
    "",
    "## Verification evidence",
    (verification ?? "").trim(),
  ];

  return sections.join("\n");
}

/**
 * Build the argv array (WITHOUT the binary) for `agentrail issue create`.
 *
 * The trigger label `ready-for-agent` is applied SERVER-SIDE by the CLI in
 * connector mode; we deliberately do NOT pass any labels.
 *
 * @param {object} input
 * @param {string} input.repo - "owner/repo"
 * @param {string} input.title
 * @param {string} input.body - full house-format markdown
 * @returns {string[]}
 */
export function buildCreateArgv({ repo, title, body } = {}) {
  return [
    "issue",
    "create",
    "--connector",
    "github",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
  ];
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
 * @param {object} input
 * @param {(bin: string, argv: string[], opts: object) => Promise<{stdout: string, stderr?: string}>} input.execFileFn
 * @param {NodeJS.ProcessEnv} input.env
 * @param {string} [input.repo] - falls back to env.JACE_TARGET_REPO
 * @param {string} input.title
 * @param {string} [input.parent]
 * @param {string} [input.requiredContext]
 * @param {string} [input.whatToBuild]
 * @param {string[]} input.acceptanceCriteria
 * @param {string} [input.verification]
 * @returns {Promise<{ repo: string, number: number, url: string, label: string }>}
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
  const resolvedRepo = repo || resolvedEnv.JACE_TARGET_REPO;

  if (!resolvedRepo) {
    throw new Error(
      "runCreateIssue: no target repo. Pass `repo` or set JACE_TARGET_REPO in the environment.",
    );
  }
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
  const argv = buildCreateArgv({ repo: resolvedRepo, title, body });

  let result;
  try {
    result = await execFileFn(bin, argv, { env: resolvedEnv });
  } catch (err) {
    const stderr = err && err.stderr ? `\n${err.stderr}` : "";
    throw new Error(
      `runCreateIssue: \`${bin} issue create\` failed: ${err && err.message ? err.message : String(err)}${stderr}`,
    );
  }

  return parseCreateOutput(result.stdout);
}
