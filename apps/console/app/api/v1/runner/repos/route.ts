import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getGithubToken,
  createRepository,
  getConnector,
  upsertConnector,
  enqueueOnboard,
  workspaceHasExecutionPath,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const NAME_MAX = 100;
const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const WEBHOOK_SECRET_BYTES = 24;
const WEBHOOK_RECEIVER_PATH = "/api/v1/connectors/github/webhook";

// Short outbound calls to GitHub's REST API — same bound + idiom as the
// other connector-verify fetches in this app (8s; see e.g.
// app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram.ts).
const GITHUB_FETCH_TIMEOUT_MS = 8000;

// Onboard-on-connect: the SAME default-OFF rollout flag the manual "connect
// an existing repo" flow already gates on
// (apps/console/app/api/v1/workspaces/[workspaceId]/repos/route.ts).
// `enqueueOnboard` (kind='onboard', packages/db-postgres/src/queries/
// github_intake.ts) is fully wired with its own dedupe/idempotency and a
// claim-side reader in queries/runner.ts — this flow reuses it verbatim
// rather than inventing a new gate or a new queue kind. The gate itself is
// `workspaceHasExecutionPath` (#1268 PR①, swapped in from the former
// kind-agnostic `hasActiveRunner`, which required a PRIOR claim to have
// touched `last_used_at` — essentially always false for a brand-new
// workspace at the exact instant it connects its first repo; see that
// predicate's own doc-comment for the race it closes). #1268's OTHER half is
// the onboard EXECUTOR question (whether/how a runner processes a claimed
// kind='onboard' row) — orthogonal to this gate, covered elsewhere.
const ONBOARD_ON_CONNECT_FLAG = "AGENTRAIL_ONBOARD_ON_CONNECT";

interface RawBody {
  eveSessionId: string;
  name: string;
  private?: boolean;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string" || o.eveSessionId.length === 0) return false;
  if (typeof o.name !== "string") return false;
  if (o.private !== undefined && typeof o.private !== "boolean") return false;
  return true;
}

type NameValidation = { ok: true; value: string } | { ok: false; reason: string };

/** GitHub-repo-name shape: trimmed, 1-100 chars, [A-Za-z0-9._-] only. */
function validateRepoName(raw: string): NameValidation {
  const name = raw.trim();
  if (name.length < 1) {
    return { ok: false, reason: "name is required" };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, reason: `name must be at most ${NAME_MAX} characters` };
  }
  if (!GITHUB_REPO_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: "name may only contain letters, numbers, '.', '_', and '-'",
    };
  }
  return { ok: true, value: name };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "agentrail-console",
  };
}

/**
 * True when a 422 response body carries GitHub's documented "name already
 * exists" shape — `errors[].field === "name"` AND a message matching
 * GitHub's actual wording (`/already exists/i`) — so a name-field 422 for any
 * other reason (e.g. an invalid-name-shape rejection) falls through to the
 * generic 502 path instead of being misreported as a 409. Falls back to a
 * plain-text match against the same phrase for a body that doesn't parse as
 * JSON (or doesn't match the documented shape).
 */
function isNameTakenError(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as {
      errors?: Array<{ field?: string; message?: string }>;
    };
    return (parsed.errors ?? []).some(
      (e) => e.field === "name" && /already exists/i.test(e.message ?? "")
    );
  } catch {
    return /already exists/i.test(bodyText);
  }
}

interface GithubCreateRepoResponse {
  full_name?: unknown;
  html_url?: unknown;
  private?: unknown;
  default_branch?: unknown;
}

/**
 * Create a single GitHub webhook for `fullName`. Replicated (not imported)
 * from `createHookForRepo` in
 * apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/webhook/route.ts
 * — same request shape (name/active/events/config) and the same receiving
 * endpoint. That route iterates every repo a connector is configured for and
 * mints a brand-new secret on every call; this flow only ever creates a hook
 * for the ONE repo just created and resolves the secret separately (reusing
 * an existing one when the connector already has one — see the POST handler
 * below), so the call itself is replicated locally rather than shared, to
 * keep that route's tests untouched.
 */
async function createRepoWebhook(
  fullName: string,
  token: string,
  targetUrl: string,
  secret: string
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`https://api.github.com/repos/${fullName}/hooks`, {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["issues"],
        config: { url: targetUrl, content_type: "json", secret },
      }),
    });
  } catch {
    return { ok: false, error: "Could not reach GitHub to create the webhook." };
  }
  if (!res.ok) {
    return { ok: false, error: `GitHub rejected the webhook (HTTP ${res.status}).` };
  }
  return { ok: true };
}

/**
 * POST /api/v1/runner/repos
 *
 * Creates a REAL GitHub repository on behalf of the workspace's own GitHub
 * account, then runs the same connect chain the manual "connect an existing
 * repo" flow uses (spec §4.2, issue #1265 PR ①). Jace's `create_repo` tool
 * (issue #1265 PR ②, NOT this PR) calls this only after a human has approved
 * the exact name in-chat — this route performs no approval of its own; the
 * gate lives entirely Eve-side, same class as `create_workspace` (#1264).
 *
 * SECURITY POSTURE
 * Auth + resolution mirror `runner/workspaces/route.ts` (#1264) EXACTLY: a
 * bearer AgentRail API key via `requireBearer`, then `{ eveSessionId, name,
 * private? }` resolved through the session ledger
 * (`getJaceSessionByEveSessionId` -> `getChatIdentityById`) — never a
 * caller-supplied `(platform, platformUserId)` pair, and never the bearer's
 * OWN `workspaceId` (there is nothing to cross-check it against: a valid
 * bearer could in principle invoke this for an arbitrary `eveSessionId`
 * unrelated to its own traffic, the same residual #1264 accepts, offset by
 * the same compensating controls — `create_repo` never lets the model choose
 * `eveSessionId`, and every call is human-approved in the context of one
 * specific conversation). A session row with a null `chat_identity_id`, or no
 * session row at all, collapses into the SAME 404 as "chat identity not
 * found" — a distinguishable response would let any valid bearer enumerate
 * which sessions exist. The GitHub token is the WORKSPACE OWNER's stored
 * OAuth `access_token` (`getGithubToken`), read fresh at the point of use and
 * never returned to the caller or logged.
 *
 * WORKSPACE + TOKEN
 * `workspace = session.workspaceId ?? identity.workspaceId` — an honest 409
 * ("this conversation has no workspace yet") when neither is set, since
 * `create_workspace` (#1264) is the fix and Jace can relay that verbatim. A
 * missing GitHub token is a separate, distinct 409 (the connect-link flow,
 * #1263, is the fix for that one) — both refusals are DISTINCT from the
 * upstream 404, unlike connect-link's folded posture, because a human
 * already approved THIS SPECIFIC call in THIS SPECIFIC conversation before
 * this route ever runs: there is no scripted-probing surface here to protect
 * by hiding the reason, and telling Jace exactly what's missing is strictly
 * more useful than a bare 404 it cannot act on (same reasoning #1264 uses for
 * its own two 409s).
 *
 * VALIDATION
 * `name`: trimmed, 1-100 chars, `[A-Za-z0-9._-]` only — checked before any DB
 * or network call. `private` defaults to `true` when omitted: a repo Jace
 * creates on the user's behalf should default to the safe (non-public)
 * choice rather than GitHub's own API default of `false`.
 *
 * GITHUB CALL
 * `POST /user/repos` with `auto_init: true` — without it a freshly created
 * repo has no default branch / no commits, so the runner's later clone (and
 * the onboard indexer) would have nothing to check out.
 *
 * CONNECT CHAIN (each step's failure surfaces honestly rather than
 * pretending — the repo EXISTS on GitHub the moment the create call
 * succeeds, so nothing past that point may silently imply otherwise):
 *  (1) repository row + connector `config.repos` self-configure. The row
 *      insert is NOT best-effort: if it throws, the repo exists on GitHub
 *      but our own write failed, which is a genuine inconsistency (same
 *      posture as #1264's "pinConversationWorkspace refused" — thrown, not
 *      swallowed into a misleading 201). The connector self-configure IS
 *      best-effort (logged AND recorded in `warnings`, never thrown),
 *      replicated from `workspaces/[workspaceId]/repos/route.ts` — see the
 *      code comment at its call site for why it's replicated rather than
 *      shared, and why it is merged with step 2's secret handling into one
 *      read + one write. A failure here also skips step 2 entirely (below).
 *  (2) webhook creation — best-effort; a failure here does NOT fail the
 *      whole call (the repo is already connected). Skipped outright (never
 *      attempted) when step 1's connector-config write failed, since a
 *      webhook bound to a secret we know wasn't persisted is worse than no
 *      webhook at all. `webhookCreated` reports the real outcome either way
 *      and a human-readable entry always lands in `warnings` on failure.
 *  (3) onboard enqueue — see `ONBOARD_ON_CONNECT_FLAG`'s comment above:
 *      reuses the existing flag + `enqueueOnboard` verbatim (best-effort),
 *      gated on `workspaceHasExecutionPath` (#1268) rather than
 *      `hasActiveRunner` — see that predicate's own doc-comment for why a
 *      kind-agnostic "has a runner ever claimed" check is race-prone for a
 *      brand-new, runner-less (hosted) workspace at connect time. No new
 *      queue kind invented.
 *
 * RESPONSE 201: `{ repo: { fullName, url, private }, connected: true,
 * webhookCreated, onboardQueued, warnings }`. `connected` is always `true`
 * in a built response (the code either reaches this line with the repository
 * row created, or has already returned/thrown earlier); `webhookCreated` /
 * `onboardQueued` are each honest per their own step; `warnings` is always an
 * array (possibly empty) rather than a conditionally-present key, so a caller
 * never has to branch on its existence.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRawBody(body)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string) and name (string); private, if present, must be a boolean",
      },
      { status: 400 }
    );
  }

  const nameResult = validateRepoName(body.name);
  if (!nameResult.ok) {
    return NextResponse.json({ error: nameResult.reason }, { status: 400 });
  }
  const requestedName = nameResult.value;
  const isPrivate = body.private ?? true;

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;

  if (!session || !identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  const workspaceId = session.workspaceId ?? identity.workspaceId;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "this conversation has no workspace yet — create one first" },
      { status: 409 }
    );
  }

  const token = await getGithubToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      { error: "no GitHub account with repo access is connected for this workspace yet" },
      { status: 409 }
    );
  }

  let ghRes: Response;
  try {
    ghRes = await fetchWithTimeout("https://api.github.com/user/repos", {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ name: requestedName, private: isPrivate, auto_init: true }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }

  if (!ghRes.ok) {
    // 401/403: the stored OAuth token is stale/revoked/under-scoped — the
    // connect-link flow (#1263) is the fix, so say so plainly rather than a
    // bare HTTP status Jace can't act on.
    if (ghRes.status === 401 || ghRes.status === 403) {
      return NextResponse.json(
        { error: "GitHub rejected the stored credentials" },
        { status: 409 }
      );
    }
    const detailText = await ghRes.text().catch(() => "");
    if (ghRes.status === 422 && isNameTakenError(detailText)) {
      // X is the REQUESTED name only — never the raw GitHub error body,
      // which could otherwise be shaped to echo something the caller didn't
      // ask about.
      return NextResponse.json(
        { error: `a repo named ${requestedName} already exists on your GitHub` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `GitHub rejected the repo creation (HTTP ${ghRes.status}).` },
      { status: 502 }
    );
  }

  const created = (await ghRes.json()) as GithubCreateRepoResponse;
  if (typeof created.full_name !== "string" || typeof created.html_url !== "string") {
    return NextResponse.json(
      { error: "GitHub returned an unexpected response creating the repository." },
      { status: 502 }
    );
  }
  const fullName = created.full_name;
  const htmlUrl = created.html_url;
  const defaultBranch =
    typeof created.default_branch === "string" ? created.default_branch : "main";
  const createdPrivate = typeof created.private === "boolean" ? created.private : isPrivate;

  // --- connect chain: step 1 — repository row (required, not best-effort) --
  await createRepository({
    workspaceId,
    name: fullName,
    url: htmlUrl,
    defaultBranch,
  });

  // --- connect chain: step 1b — connector self-configure (best-effort) -----
  // Replicated (not imported) from the repos-list write in
  // workspaces/[workspaceId]/repos/route.ts and the webhook-secret write in
  // connectors/github/webhook/route.ts — see this file's module doc-comment
  // for why these are replicated rather than shared. Those two source routes
  // each do their own separate read/write for their own single concern; this
  // flow needs both, so it reads the connector ONCE and merges both concerns
  // into a single upsert rather than round-tripping twice. Failure here is
  // logged AND surfaced in `warnings` (never thrown: the repository row
  // above already exists, so a connector-config hiccup must not undo, or
  // fail the response for, work that already succeeded) — and it disables
  // step 2 below, since creating a webhook against a secret we know we
  // failed to persist would be actively misleading rather than merely
  // incomplete.
  const repoSet = new Set<string>([fullName]);
  let webhookSecret = randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
  const warnings: string[] = [];
  let connectorConfigured = true;
  try {
    const existingConnector = await getConnector(workspaceId, "github");
    if (existingConnector) {
      for (const r of existingConnector.config.repos) repoSet.add(r);
      if (existingConnector.config.webhookSecret) {
        webhookSecret = existingConnector.config.webhookSecret;
      }
    }
    await upsertConnector(workspaceId, "github", {
      enabled: true,
      config: { repos: [...repoSet], webhookSecret },
    });
  } catch (err) {
    console.error("[runner/repos] failed to self-configure github connector:", err);
    connectorConfigured = false;
    warnings.push(
      "workspace connector config could not be updated — the repo may not be tracked and the webhook secret was not saved; reconnect from the console"
    );
  }

  // --- connect chain: step 2 — webhook creation (best-effort) --------------
  const targetUrl = `${new URL(request.url).origin}${WEBHOOK_RECEIVER_PATH}`;
  let webhookCreated = false;
  if (!connectorConfigured) {
    // Step 1b already failed to persist `webhookSecret` (and possibly this
    // repo's entry in `config.repos`). Registering the GitHub webhook anyway
    // would create a real, live hook whose secret nothing on our side can
    // verify against — worse than no webhook, since `webhookCreated: true`
    // would then misreport a working integration. Skip the call and report
    // the same honest failure instead.
    warnings.push(
      "webhook not created — the connector config write failed above, so the webhook secret was never persisted"
    );
  } else {
    const hookResult = await createRepoWebhook(fullName, token, targetUrl, webhookSecret);
    webhookCreated = hookResult.ok;
    if (!hookResult.ok && hookResult.error) {
      warnings.push(hookResult.error);
    }
  }

  // --- connect chain: step 3 — onboard enqueue (best-effort) ---------------
  let onboardQueued = false;
  if (process.env[ONBOARD_ON_CONNECT_FLAG] === "1") {
    try {
      if (await workspaceHasExecutionPath(workspaceId)) {
        const result = await enqueueOnboard({ workspaceId, repoFullName: fullName });
        onboardQueued = result.enqueued;
      }
    } catch (err) {
      console.error("[runner/repos] failed to enqueue onboard:", err);
      warnings.push("Could not enqueue the onboard indexing job.");
    }
  }

  return NextResponse.json(
    {
      repo: { fullName, url: htmlUrl, private: createdPrivate },
      connected: true as const,
      webhookCreated,
      onboardQueued,
      warnings,
    },
    { status: 201 }
  );
}
