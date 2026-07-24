import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/backlog/mutate
 *
 * The ONE write path behind Jace's `backlog-triage` grooming (issue #1291,
 * epic #1257): applies a SINGLE, already-human-approved mutation to ONE open
 * GitHub issue. It is reached only from Jace's gated `backlog_label` /
 * `backlog_close` / `backlog_dedupe` tools, each of which records a
 * per-mutation Approve/Deny with the console (`consoleGatedApproval`) and only
 * calls this route once the member has explicitly approved. This route itself
 * performs no approval — the human gate lives entirely Eve-side, the SAME
 * split every other gated tool uses (create_issue/create_repo/post_pr_review).
 * There is deliberately no silent write to the user's tracker anywhere: the
 * read route (`GET /api/v1/runner/backlog`) never writes, and this route only
 * ever runs behind an approved decision.
 *
 * NOT the run-failure "triage" feature (FAILURE DIAGNOSIS). This is BACKLOG
 * GROOMING — a distinct name and code path.
 *
 * AUTH + TENANT: the central `JACE_CONSOLE_TOKEN` via `requireJaceConsoleSecret`
 * gates WHO; the workspace is resolved server-side from `eveSessionId` through
 * the `jace_sessions` ledger, never a caller-supplied `workspaceId` — the same
 * chain `pr-review`/`repos`/`goals` use.
 *
 * REPO <-> WORKSPACE VALIDATION: like `pr-review` (and unlike auto-resolving
 * routes), the caller names an explicit `repo`, so this route refuses to
 * proxy an arbitrary repo with the workspace's token:
 * `getRepositoryByName(workspaceId, repo)` must find a connected row before
 * any GitHub call. An unconnected/unknown repo 404s identically.
 *
 * ACTIONS (each is ONE issue, ONE approved mutation):
 *  - `add_labels`    — POST labels onto the issue. `labels: string[]` required.
 *  - `remove_labels` — DELETE each named label from the issue. `labels`
 *                      required; a label the issue doesn't carry is treated as
 *                      already-absent (idempotent), not an error.
 *  - `close`         — optionally POST a reason `comment`, then PATCH the issue
 *                      closed with `state_reason` (completed | not_planned,
 *                      default not_planned).
 *  - `dedupe`        — POST a comment linking the canonical issue ("Duplicate
 *                      of #<canonicalIssue>", plus any supplied `comment`),
 *                      then PATCH the issue closed as `not_planned`.
 *
 * PARTIAL-FAILURE HONESTY: for the two-step actions (close/dedupe) the comment
 * is posted FIRST; if it fails, nothing is closed and the failure is returned.
 * If the comment lands but the close then fails, that close failure is
 * returned honestly (the response never claims a close that didn't happen).
 *
 * GITHUB ERROR CLASSIFICATION mirrors `pr-review`: 404 (issue/repo not
 * reachable), 401/403 (stale credentials -> 409), rate limiting (-> 429),
 * everything else -> 502. Raw GitHub statuses/bodies are never passed through.
 *
 * 400 — malformed body / bad action / missing required field. 401 — bad
 * secret. 404 — no session, or repo not connected. 409 — no workspace / no
 * token. 200 — `{ applied: true, action, repo, issueNumber, url, ...warnings }`.
 */

const GITHUB_FETCH_TIMEOUT_MS = 8000;
const REPO_FORMAT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const ACTIONS = ["add_labels", "remove_labels", "close", "dedupe"] as const;
type Action = (typeof ACTIONS)[number];

const STATE_REASONS = ["completed", "not_planned"] as const;
type StateReason = (typeof STATE_REASONS)[number];

const COMMENT_MAX_LEN = 4000;
const MAX_LABELS = 20;
const LABEL_MAX_LEN = 100;

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agentrail-console",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractGithubMessage(body: unknown): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return (body as Record<string, unknown>).message as string;
  }
  return "";
}

/** Map a non-2xx GitHub response to OUR OWN clean, classified status + error. */
function classifyGithubError(status: number, body: unknown): { status: number; error: string } {
  if (!Number.isFinite(status) || status <= 0) {
    return { status: 502, error: "Could not reach GitHub." };
  }
  if (status === 404) return { status: 404, error: "issue or repo not found on GitHub" };
  if (status === 429) return { status: 429, error: "GitHub rate limit exceeded — try again later" };
  if (status === 401 || status === 403) {
    if (/rate limit/i.test(extractGithubMessage(body))) {
      return { status: 429, error: "GitHub rate limit exceeded — try again later" };
    }
    return { status: 409, error: "GitHub rejected the stored credentials" };
  }
  if (status === 410) return { status: 404, error: "issue or repo not found on GitHub" };
  return { status: 502, error: `GitHub rejected the request (HTTP ${status}).` };
}

interface RawBody {
  eveSessionId: string;
  repo: string;
  issueNumber: number;
  action: Action;
  labels?: string[];
  comment?: string;
  stateReason?: StateReason;
  canonicalIssue?: number;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Validate the body shape + per-action required fields in one pass. */
function parseBody(v: unknown): { ok: true; body: RawBody } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "body must be an object" };
  const o = v as Record<string, unknown>;

  if (typeof o.eveSessionId !== "string" || o.eveSessionId.length === 0) {
    return { ok: false, error: "eveSessionId is required" };
  }
  if (typeof o.repo !== "string" || !REPO_FORMAT_RE.test(o.repo)) {
    return { ok: false, error: "repo must be in the form owner/name" };
  }
  if (!isPositiveInt(o.issueNumber)) {
    return { ok: false, error: "issueNumber must be a positive integer" };
  }
  if (typeof o.action !== "string" || !ACTIONS.includes(o.action as Action)) {
    return { ok: false, error: `action must be one of ${ACTIONS.join(", ")}` };
  }
  const action = o.action as Action;

  const body: RawBody = {
    eveSessionId: o.eveSessionId,
    repo: o.repo,
    issueNumber: o.issueNumber,
    action,
  };

  if (action === "add_labels" || action === "remove_labels") {
    if (!isStringArray(o.labels) || o.labels.length === 0) {
      return { ok: false, error: "labels must be a non-empty array of strings" };
    }
    const labels = o.labels.map((l) => l.trim()).filter((l) => l.length > 0);
    if (labels.length === 0) return { ok: false, error: "labels must contain a non-empty name" };
    if (labels.length > MAX_LABELS) return { ok: false, error: `at most ${MAX_LABELS} labels` };
    if (labels.some((l) => l.length > LABEL_MAX_LEN)) {
      return { ok: false, error: `each label must be at most ${LABEL_MAX_LEN} characters` };
    }
    body.labels = labels;
  }

  if (action === "close") {
    if (o.stateReason !== undefined) {
      if (typeof o.stateReason !== "string" || !STATE_REASONS.includes(o.stateReason as StateReason)) {
        return { ok: false, error: `stateReason must be one of ${STATE_REASONS.join(", ")}` };
      }
      body.stateReason = o.stateReason as StateReason;
    }
    if (o.comment !== undefined) {
      if (typeof o.comment !== "string") return { ok: false, error: "comment must be a string" };
      body.comment = o.comment.slice(0, COMMENT_MAX_LEN);
    }
  }

  if (action === "dedupe") {
    if (!isPositiveInt(o.canonicalIssue)) {
      return { ok: false, error: "canonicalIssue must be a positive integer" };
    }
    if (o.canonicalIssue === o.issueNumber) {
      return { ok: false, error: "canonicalIssue must differ from issueNumber" };
    }
    body.canonicalIssue = o.canonicalIssue;
    if (o.comment !== undefined) {
      if (typeof o.comment !== "string") return { ok: false, error: "comment must be a string" };
      body.comment = o.comment.slice(0, COMMENT_MAX_LEN);
    }
  }

  return { ok: true, body };
}

type ResolveOutcome =
  | { ok: true; token: string }
  | { ok: false; response: NextResponse };

async function resolveWorkspaceRepoToken(
  eveSessionId: string,
  repo: string
): Promise<ResolveOutcome> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session?.workspaceId ?? identity?.workspaceId ?? null;

  if (!session && !identity) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Chat identity not found" }, { status: 404 }),
    };
  }
  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet" },
        { status: 409 }
      ),
    };
  }

  const connectedRepo = await getRepositoryByName(workspaceId, repo);
  if (!connectedRepo) {
    return {
      ok: false,
      response: NextResponse.json({ error: "repo not connected to this workspace" }, { status: 404 }),
    };
  }

  const token = await getInstallationToken(workspaceId);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "no GitHub account with repo access is connected for this workspace yet" },
        { status: 409 }
      ),
    };
  }

  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// GitHub write primitives — each returns the raw Response so the caller can
// classify a non-2xx uniformly. `null` means the request could not even be
// sent (transport error).
// ---------------------------------------------------------------------------

async function ghPostComment(
  repo: string,
  issueNumber: number,
  token: string,
  body: string
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ body }) }
    );
  } catch {
    return null;
  }
}

async function ghPatchState(
  repo: string,
  issueNumber: number,
  token: string,
  stateReason: StateReason
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: githubHeaders(token),
      body: JSON.stringify({ state: "closed", state_reason: stateReason }),
    });
  } catch {
    return null;
  }
}

async function ghAddLabels(
  repo: string,
  issueNumber: number,
  token: string,
  labels: string[]
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`,
      { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ labels }) }
    );
  } catch {
    return null;
  }
}

async function ghRemoveLabel(
  repo: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE", headers: githubHeaders(token) }
    );
  } catch {
    return null;
  }
}

/** Turn a (possibly-null) Response into either a classified error or its parsed JSON. */
async function readOrError(
  res: Response | null
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  if (!res) {
    return { ok: false, status: 502, error: "Could not reach GitHub." };
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const { status, error } = classifyGithubError(res.status, errBody);
    return { ok: false, status, error };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, body };
}

function issueUrl(body: unknown, repo: string, issueNumber: number): string {
  if (body && typeof body === "object" && typeof (body as { html_url?: unknown }).html_url === "string") {
    return (body as { html_url: string }).html_url;
  }
  return `https://github.com/${repo}/issues/${issueNumber}`;
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { eveSessionId, repo, issueNumber, action, labels, comment, stateReason, canonicalIssue } =
    parsed.body;

  const resolved = await resolveWorkspaceRepoToken(eveSessionId, repo);
  if (!resolved.ok) return resolved.response;
  const { token } = resolved;

  // --- add_labels -----------------------------------------------------------
  if (action === "add_labels") {
    const out = await readOrError(await ghAddLabels(repo, issueNumber, token, labels!));
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(
      {
        applied: true,
        action,
        repo,
        issueNumber,
        labelsAdded: labels,
        url: `https://github.com/${repo}/issues/${issueNumber}`,
      },
      { status: 200 }
    );
  }

  // --- remove_labels --------------------------------------------------------
  if (action === "remove_labels") {
    const removed: string[] = [];
    for (const label of labels!) {
      const res = await ghRemoveLabel(repo, issueNumber, token, label);
      // A 404 here means the issue doesn't carry that label — idempotent, not a
      // failure. A 404 on the ISSUE itself is indistinguishable from that at
      // the label endpoint, but the caller already validated the issue via the
      // read sweep, so treating a label-level 404 as "already absent" is the
      // correct, least-surprising behavior.
      if (res && res.status === 404) continue;
      const out = await readOrError(res);
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
      removed.push(label);
    }
    return NextResponse.json(
      {
        applied: true,
        action,
        repo,
        issueNumber,
        labelsRemoved: removed,
        url: `https://github.com/${repo}/issues/${issueNumber}`,
      },
      { status: 200 }
    );
  }

  // --- close / dedupe (comment first, then close) ---------------------------
  const warnings: string[] = [];

  // Compose the comment. dedupe always leads with the canonical link; close
  // posts a comment only when one was supplied.
  let commentBody = "";
  if (action === "dedupe") {
    commentBody = `Duplicate of #${canonicalIssue}.`;
    if (comment && comment.trim()) commentBody += `\n\n${comment.trim()}`;
  } else if (comment && comment.trim()) {
    commentBody = comment.trim();
  }

  if (commentBody) {
    const commentOut = await readOrError(await ghPostComment(repo, issueNumber, token, commentBody));
    // The comment is the explanation for the close — if it can't be posted,
    // nothing is closed and the failure is returned as-is.
    if (!commentOut.ok) return NextResponse.json({ error: commentOut.error }, { status: commentOut.status });
  }

  const reason: StateReason = action === "dedupe" ? "not_planned" : stateReason ?? "not_planned";
  const closeOut = await readOrError(await ghPatchState(repo, issueNumber, token, reason));
  if (!closeOut.ok) {
    // The comment (if any) already landed; be honest that the close itself
    // failed rather than pretending the whole action succeeded.
    if (commentBody) warnings.push("the reason comment was posted, but closing the issue failed");
    return NextResponse.json({ error: closeOut.error, warnings }, { status: closeOut.status });
  }

  return NextResponse.json(
    {
      applied: true,
      action,
      repo,
      issueNumber,
      stateReason: reason,
      ...(action === "dedupe" ? { canonicalIssue } : {}),
      commentPosted: Boolean(commentBody),
      url: issueUrl(closeOut.body, repo, issueNumber),
      warnings,
    },
    { status: 200 }
  );
}
