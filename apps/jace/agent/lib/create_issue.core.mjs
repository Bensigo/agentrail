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
import {
  resolveConsoleConfig,
  buildApprovalsUrl,
  deriveIdempotencyKey,
} from "./console_gated_approval.core.mjs";

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

// ---------------------------------------------------------------------------
// Jace goal loop (issue #1289) — the pre-file leash gate and post-file
// bookkeeping record.
//
// ADVERSARIAL-REVIEW FIX (this is not the original design): the goal loop's
// `maxIssues` leash was schema-complete and exhaustively unit-tested
// (goal_rules.ts / goals.ts in packages/db-postgres) but INERT at runtime —
// nothing in production ever called `recordIssueFiled`, the ONE function
// that increments `goals.issues_filed` AND writes the `goal_events`
// `issue_filed` row the evaluate-on-outcome path (`findActiveGoalForIssue`)
// depends on to map an issue back to its goal. `git grep recordIssueFiled --
// apps/` found only test files and the live-DB proof script (which called
// it MANUALLY to simulate what production never did) — a documented, tested
// safety bound that silently never fired. This section closes that gap at
// the ONE place a goal-stamped issue is actually admitted: right here, in
// `runCreateIssue`, before/after the CLI call.
//
// THE SAFETY LINE this preserves: this is bookkeeping ALONGSIDE the existing
// human-approval gate, never a bypass of it. `create_issue`'s `approval:
// (ctx) => consoleGatedApproval(ctx)` gate is completely untouched — a human
// still approves every single issue, goal-stamped or not, before ANY of this
// runs. What's new is that a goal-stamped issue additionally (a) refuses to
// even reach the CLI when that goal's leash is already exhausted (the
// pre-file gate, `checkGoalFileLeash`), and (b) records the file once it
// really happens (`recordGoalIssueFiled`).

/** The goal stamp's own text format — `agent/lib/goal_outcome_dispatch.core.mjs::goalStamp` renders "Goal: <objective> (goal:<slug>)"; this is that format's inverse. */
const GOAL_STAMP_RE = /\(goal:([a-z0-9-]+)\)/i;

/**
 * Recover a goal's slug from an issue's about-to-be-created title+body, if
 * the synthetic refill prompt's own instruction (`buildRefillMessage`) was
 * followed and the model stamped it. Pure, no I/O. Returns `null` when no
 * stamp is present — the overwhelmingly common case (a normal, non-goal
 * issue), which must cost nothing beyond one regex test.
 *
 * @param {string} text — the title and/or house-format body to search
 * @returns {string | null}
 */
export function extractGoalSlug(text) {
  // `String(...).match(regex)` rather than `regex.exec(...)` — NOT a style
  // preference: this repo's static AC4 check (qa-no-shell-string.test.mjs)
  // greps runtime source for `exec(`/`execSync(` to ban shell-string
  // subprocess calls, and its regex has no way to tell `RegExp.prototype
  // .exec()` apart from `child_process.exec()`. `.match()` is functionally
  // identical here (a non-global regex against `.match()` returns the same
  // full-match-plus-groups array `.exec()` would) and simply doesn't
  // collide with that check.
  const match = String(text ?? "").match(GOAL_STAMP_RE);
  return match ? match[1] : null;
}

export const GOAL_FILE_CHECK_PATH = "/api/v1/runner/goals/file-check";
export const GOAL_FILE_RECORDED_PATH = "/api/v1/runner/goals/file-recorded";

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildGoalFileCheckUrl(baseUrl) {
  return `${baseUrl}${GOAL_FILE_CHECK_PATH}`;
}

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildGoalFileRecordedUrl(baseUrl) {
  return `${baseUrl}${GOAL_FILE_RECORDED_PATH}`;
}

/** The generic, safe-to-relay refusal text used whenever the pre-file leash check itself cannot be trusted (infra failure) — see `checkGoalFileLeash`'s own "fail CLOSED" contract for why this is a refusal, not a silent allow. */
export const GOAL_CHECK_INFRA_FAILURE_MESSAGE =
  "couldn't verify this goal's leash before filing — try again in a moment";

/**
 * THE pre-file leash gate. Called by `runCreateIssue` BEFORE it ever shells
 * out to the CLI, whenever `extractGoalSlug` found a stamp in the
 * about-to-be-created issue. POSTs to the console's
 * `/api/v1/runner/goals/file-check` (which itself checks the workspace's
 * `jaceGoalLoop` flag FIRST and returns `{allow:true}` unconditionally when
 * off — see that route's own doc-comment), and returns its decision.
 *
 * FAILS CLOSED, unlike this file's other best-effort calls (stampCreatedIssueUrl):
 * a missing console config, a transport error, a non-2xx, or a malformed
 * body all resolve to `{ allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE }`
 * — NEVER a silent allow. This is a genuine, deliberate posture difference
 * from the rest of this file's "best-effort, never blocks" idiom: every
 * OTHER side-effect here (the URL stamp) is pure bookkeeping whose failure
 * only degrades to a redundant confirm later; THIS one is a safety bound
 * (`maxIssues`) — the entire point of this fix is that the bound must
 * actually fire, so an unreachable check must never be indistinguishable
 * from "leash has room". Single attempt, no retry (matches this file's
 * "one attempt, report don't retry" idiom for a single HTTP call).
 *
 * @param {{ eveSessionId?: string, slug: string, env?: Record<string, string|undefined>, transport: Function }} args
 * @returns {Promise<{ allow: boolean, goalId?: string, reason?: string }>}
 */
export async function checkGoalFileLeash({ eveSessionId, slug, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };

  let res;
  try {
    res = await transport(buildGoalFileCheckUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, slug }),
    });
  } catch {
    return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };
  }

  const status = Number(res && res.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };
  }

  if (!body || typeof body !== "object" || typeof body.allow !== "boolean") {
    return { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE };
  }

  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const goalId = typeof body.goalId === "string" && body.goalId ? body.goalId : undefined;
  return { allow: body.allow, ...(goalId ? { goalId } : {}), ...(reason ? { reason } : {}) };
}

/**
 * THE post-file bookkeeping record. Best-effort, mirrors
 * `stampCreatedIssueUrl`'s own contract EXACTLY: a failure here must NEVER
 * retroactively undo an already-created GitHub issue (not even possible)
 * and must never be surfaced as a tool failure — awaited so the attempt is
 * fully made before `runCreateIssue` returns, but its result is never
 * inspected beyond that. POSTs to the console's
 * `/api/v1/runner/goals/file-recorded`, which itself no-ops safely on an
 * unresolvable `goalId`.
 *
 * @param {{ goalId: string, issueExternalId: string, env?: Record<string, string|undefined>, transport: Function }} args
 * @returns {Promise<void>}
 */
export async function recordGoalIssueFiled({ goalId, issueExternalId, env = {}, transport }) {
  try {
    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return;

    await transport(buildGoalFileRecordedUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ goalId, issueExternalId }),
    });
  } catch {
    // Belt-and-suspenders: see this function's own "NEVER throws" doc-comment.
  }
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

// ---------------------------------------------------------------------------
// #1274 PR ② — the chat-born one-confirm collapse's OWN write: stamp the
// real GitHub issue URL this call just produced onto its own (approved)
// create_issue approval row, so enqueueGithubIssue's confirmed-brief lookup
// recognizes the SAME issue arriving later via the label webhook and admits
// it straight to `queued` with the sanctioned budget/model — instead of
// parking it for a second, redundant alignment confirm.
// ---------------------------------------------------------------------------

/**
 * The console-owned stamp endpoint (#1274 PR ②), joined onto the console
 * base and parameterized by the approval's own id — the sibling of
 * `buildApprovalsUrl`/`buildApprovalStatusUrl` in console_gated_approval.core.mjs.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} approvalId
 * @returns {string}
 */
export function buildPublishedStampUrl(baseUrl, approvalId) {
  return `${baseUrl}/api/v1/runner/approvals/${encodeURIComponent(approvalId)}/published`;
}

// Per-HTTP-call timeout, mirroring console_gated_approval.core.mjs's own
// REQUEST_TIMEOUT_MS idiom (8000ms; not exported from that module, so
// mirrored here rather than imported — env/transport plumbing is each core
// module's own concern by design, see that file's resolveConsoleConfig
// comment). The idempotency-key ALGORITHM itself (deriveIdempotencyKey,
// imported above) is the one thing that genuinely must not drift: a second
// hand-rolled hash implementation here could silently diverge from the one
// consoleGatedApproval used, breaking relearnApprovalId below without any
// obvious symptom.
const STAMP_REQUEST_TIMEOUT_MS = 8000;

/** Real fetch with a timeout — mirrors console_gated_approval.core.mjs's own realTransport (AbortController aborts after STAMP_REQUEST_TIMEOUT_MS). */
async function realStampTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAMP_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-learn the console-minted approval id THIS create_issue call was
 * recorded under, by REPLAYING the exact idempotent
 * `POST /api/v1/runner/approvals` request `consoleGatedApproval`
 * (console_gated_approval.core.mjs) already made for this same logical
 * call — same eveSessionId/turnId/toolName/toolInput, so
 * `deriveIdempotencyKey` reproduces the IDENTICAL key it derived the first
 * time. The console's own `(eveSessionId, requestId)` uniqueness makes
 * this replay a durable, DB-backed no-op (`created: false`) that just
 * hands back `{approvalId, status}` — never a second approval row, and
 * never a second Telegram message (that route only sends on
 * `created: true`).
 *
 * This is the ONLY reliable way to learn the approval id here: nothing in
 * Eve's own tool-approval framework threads the resolved approval's id
 * from the approval fn into `execute()`'s `ctx` (verified against the
 * vendored eve@0.19.0 harness — see console_gated_approval.core.mjs's own
 * module comment for the same verification posture on a different
 * question), so relying on an in-process module-level cache between the
 * two would be a needless, unverified assumption about process lifetime
 * across the approval fn's own up-to-30-minute poll. Replaying the
 * console's own DOCUMENTED idempotency contract needs no such assumption.
 *
 * Returns `null` (never throws) on any failure — a missing config, a
 * transport error, a non-2xx, or a malformed body all read the same way to
 * the caller: "could not relearn the id, skip the stamp."
 */
async function relearnApprovalId({ baseUrl, token, eveSessionId, turnId, toolInput, transport }) {
  const idempotencyKey = deriveIdempotencyKey({
    eveSessionId,
    turnId,
    toolName: "create_issue",
    toolInput,
  });
  const url = buildApprovalsUrl(baseUrl);
  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId, toolName: "create_issue", toolInput, idempotencyKey }),
    });
  } catch {
    return null;
  }

  const httpStatus = Number(res && res.status);
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  const approvalId = body && typeof body === "object" ? body.approvalId : undefined;
  if (typeof approvalId !== "string" || approvalId.length === 0) return null;

  // M2 (#1274 PR ② fix round): the replay response also carries the
  // existing row's actual status — require it to be "approved" before ever
  // attempting a stamp. In the genuine flow this is always true (execute()
  // only runs after the approval resolved approved, and the replay returns
  // the EXISTING row via the console's (eveSessionId, requestId)
  // idempotency), so this is pure defense-in-depth: if the replay ever
  // matched a different/fresh row instead (a "ghost row" — some future
  // change to the idempotency-key derivation or the console's conflict
  // handling), its status would be "pending" and this guard turns the whole
  // stamp attempt into the honest skip (-> a later redundant confirm, the
  // fail-safe direction) rather than a stamp request against a row no human
  // approved. The console's own approved-only guard on the /published
  // endpoint would refuse that request anyway — this just avoids relying on
  // a single layer.
  const status = body && typeof body === "object" ? body.status : undefined;
  if (status !== "approved") return null;

  return approvalId;
}

/**
 * Resolve the url to stamp for a just-created issue (#1274 PR ② fix round,
 * M1). PREFERS the CLI-printed `ref.url` VERBATIM: that value is GitHub's
 * own canonical `html_url` (the connector returns `created.get("html_url")`
 * — see `agentrail/connectors/github.py::create_issue`), which carries
 * GitHub's canonical owner/repo CASING. The reconstruction from
 * `ref.repo`+`ref.number` is only the ABSENT-url fallback: `ref.repo` echoes
 * the INPUT repo casing (the connector passes the caller's `repo` through
 * unchanged), while the webhook side's confirmed-brief lookup compares
 * against `githubIssueUrl(payload.repository.full_name, n)` — GitHub's
 * canonical casing — with EXACT string equality. A mis-cased configured
 * repo would therefore make the reconstruction silently never match
 * (redundant second confirm forever); `html_url` always matches.
 *
 * An off-shape `ref.url` (should not happen for a real GitHub html_url) is
 * still passed through verbatim — the /published endpoint's own regex
 * guard refuses it, which fails the stamp toward the same safe redundant
 * confirm. Both directions preserve the fail-safe.
 *
 * @param {{ repo?: string, number?: number, url?: string }} ref
 * @returns {string}
 */
export function resolveStampUrl(ref = {}) {
  if (typeof ref.url === "string" && ref.url.length > 0) return ref.url;
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

/**
 * POST the real issue url onto the approval's `published_issue_url`
 * (#1274 PR②'s stamp endpoint). Single attempt, no retry — matches
 * console_gated_approval.core.mjs's own "one attempt, report don't retry"
 * posture for a single HTTP call. Returns `true` only on an explicit 2xx;
 * never throws.
 */
async function postStamp({ baseUrl, token, approvalId, url, transport }) {
  const stampUrl = buildPublishedStampUrl(baseUrl, approvalId);
  let res;
  try {
    res = await transport(stampUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url }),
    });
  } catch {
    return false;
  }
  const httpStatus = Number(res && res.status);
  return Number.isFinite(httpStatus) && httpStatus >= 200 && httpStatus < 300;
}

/**
 * Best-effort: stamp the just-created issue's real url onto THIS
 * create_issue call's own (approved) approval row — see
 * `relearnApprovalId`'s doc-comment for the full mechanism.
 *
 * NEVER throws and NEVER affects the caller's own result (locked design,
 * #1274 PR②): a failed stamp — a timeout, a non-2xx, a network error, a
 * missing console config, or missing session context (`eveSessionId`
 * absent — e.g. a malformed/absent `ctx`, see create_issue.ts's own
 * defensive optional chaining) — just means the label webhook will later
 * park this same issue for a SECOND, redundant alignment confirm. That is
 * the correct fail-safe direction, not a degraded outcome: it is exactly
 * the double-gate #1274 PR① already builds toward whenever a confirmed
 * brief can't be found, so a failed stamp here degrades to "PR① behavior",
 * never to a broken or unaligned admit.
 *
 * @param {{eveSessionId?: string, turnId?: string, toolInput?: unknown, url: string, env?: Record<string,string|undefined>, transport?: Function}} args
 * @returns {Promise<void>}
 */
export async function stampCreatedIssueUrl({
  eveSessionId,
  turnId,
  toolInput,
  url,
  env = {},
  transport = realStampTransport,
}) {
  try {
    const sessionId = String(eveSessionId ?? "").trim();
    if (!sessionId) return;

    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return;

    const approvalId = await relearnApprovalId({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      eveSessionId: sessionId,
      turnId,
      toolInput,
      transport,
    });
    if (!approvalId) return;

    await postStamp({ baseUrl: cfg.baseUrl, token: cfg.token, approvalId, url, transport });
  } catch {
    // Belt-and-suspenders: see this function's own "NEVER throws" doc-comment.
  }
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
 * @param {string} [input.eveSessionId] - #1274 PR②: the calling Eve session id, for the best-effort post-creation stamp (see stampCreatedIssueUrl). Absent -> the stamp attempt is skipped, never an error. ALSO used (#1289) as the pre-file goal-leash check's own tenant-resolution key when a goal stamp is present.
 * @param {string} [input.turnId] - #1274 PR②: the calling turn id, same purpose as eveSessionId above.
 * @param {unknown} [input.toolInput] - #1274 PR②: the FULL, unmodified tool input this call received (used to re-derive the SAME idempotency key consoleGatedApproval already used — see relearnApprovalId).
 * @param {Function} [input.stampTransport] - test-only: inject the stamp mechanism's HTTP transport.
 * @param {Function} [input.goalCheckTransport] - #1289 test-only: inject the pre-file leash-check's HTTP transport.
 * @param {Function} [input.goalRecordTransport] - #1289 test-only: inject the post-file bookkeeping record's HTTP transport.
 * @returns {Promise<{ repo: string, number: number, url: string, label: string } | { connected: false, message: string } | { blocked: true, message: string }>}
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
  eveSessionId,
  turnId,
  toolInput,
  stampTransport,
  goalCheckTransport,
  goalRecordTransport,
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

  // #1289 (Jace goal loop, adversarial-review fix) — THE PRE-FILE LEASH
  // GATE. Detect a goal stamp in the FINAL, already-hardened title+body
  // (the exact text about to reach GitHub) BEFORE ever shelling out to the
  // CLI. The overwhelmingly common case (no stamp — a normal, non-goal
  // issue) costs nothing beyond one regex test and is byte-identical to
  // before this fix: `goalId` stays undefined and neither new HTTP call
  // below is ever made.
  const goalSlug = extractGoalSlug(`${safeTitle}\n${body}`);
  let goalId;
  if (goalSlug) {
    const check = await checkGoalFileLeash({
      eveSessionId,
      slug: goalSlug,
      env: resolvedEnv,
      transport: goalCheckTransport ?? realStampTransport,
    });
    if (!check.allow) {
      // REFUSE — never reaches the CLI, never creates a GitHub issue. This
      // is what makes canFileNextIssue's stated contract ("check this FIRST
      // and only actually file when allow:true") real rather than dead code.
      return { blocked: true, message: check.reason ?? GOAL_CHECK_INFRA_FAILURE_MESSAGE };
    }
    goalId = check.goalId;
  }

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

  const ref = parseCreateOutput(result.stdout);

  // #1274 PR②: best-effort — AWAITED so the attempt is fully made (or
  // times out) before this function returns, rather than a fire-and-forget
  // that could be torn down mid-flight; see stampCreatedIssueUrl's own
  // "NEVER affects the caller's own result" doc-comment for why this can
  // never turn a successful issue creation into a failed tool call. The
  // url is GitHub's own canonical html_url whenever the CLI printed one —
  // see resolveStampUrl for why the repo+number reconstruction is only the
  // absent-url fallback (fix round M1).
  await stampCreatedIssueUrl({
    eveSessionId,
    turnId,
    toolInput,
    url: resolveStampUrl(ref),
    env: resolvedEnv,
    transport: stampTransport,
  });

  // #1289 (Jace goal loop, adversarial-review fix) — THE POST-FILE
  // BOOKKEEPING RECORD. Only when a goal stamp was found AND the pre-file
  // check resolved a real goalId (never when the check failed closed —
  // there is no goalId in that case, and execution never reaches here
  // anyway since a blocked check returns early above). Best-effort, same
  // "never affects the caller's own result" contract as the stamp above.
  if (goalId) {
    await recordGoalIssueFiled({
      goalId,
      issueExternalId: String(ref.number),
      env: resolvedEnv,
      transport: goalRecordTransport ?? realStampTransport,
    });
  }

  return ref;
}
