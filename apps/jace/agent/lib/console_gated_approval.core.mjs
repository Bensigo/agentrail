// consoleGatedApproval — the Approval fn for Jace's three gated tools
// (create_issue, create_workspace, create_repo), issue #1273 PR ②. Wired as
// `approval: (ctx) => consoleGatedApproval(ctx)`, this REPLACES Eve's stock
// `always()` HITL renderer (a bare "Approve tool call: <name>" + Yes/No on
// Telegram, no input, no description at all — see each tool's own file
// comment) with the console-owned seam built in PR ①: POST
// /api/v1/runner/approvals records the request and renders the rich
// per-tool message + Approve/Deny keyboard; GET .../approvals/[id] is the
// status poll this function drives to a decision.
//
// THE SAFETY LINE (binding, do not weaken): no path through this function
// may ever resolve to "approved" except an EXPLICIT `status: "approved"`
// reply from the console's poll. Every other outcome — console unreachable,
// non-2xx, a malformed body, TTL expiry, a malformed ctx, or any unexpected
// internal error — resolves to an explicit `{ type: "denied", reason }`.
// This function NEVER throws.
//
// Why "never throws" is load-bearing, not just tidy: verified against the
// vendored eve@0.19.0 harness (node_modules/eve/dist/src/harness/tools.js —
// `buildApprovalFn`/`buildToolApproval` — and the AI SDK's own
// `resolveToolApproval` in node_modules/ai/dist/index.js). None of those
// call sites wrap the approval fn's own `await` in a try/catch, so a thrown
// error propagates up to eve's tool-loop.js `executeStepBody`, which DOES
// catch it there — but treats it as a generic `MODEL_CALL_FAILED`: the
// model's whole turn/step aborts (conversation mode: the session parks
// "recoverably failed" for the user to retry; task mode: the task ends in
// error) and the gated tool never executes either way. That IS
// blocked-safe (the tool is never silently approved by a throw), but it is
// a strictly worse outcome than an explicit denial: the failure is
// turn-wide rather than scoped to this one tool call, it surfaces a generic
// framework code instead of an honest chat reply the model can react to,
// and the thrown Error's own `.message` text rides into that
// MODEL_CALL_FAILED event verbatim (`eve/dist/src/shared/errors.js`'s
// `toErrorMessage`) — a real leak risk if a thrown message ever happened to
// carry anything sensitive. So this module does not rely on "throwing is
// safe enough" — every function here catches its own failures and always
// resolves to a typed ApprovalStatus.
//
// Server-derived input ONLY (never trusts model-shaped data): eveSessionId =
// ctx.session.id, toolName = ctx.toolName, toolInput = ctx.toolInput — all
// three read straight off Eve's own ApprovalContext. Verified against the
// vendored eve@0.19.0 type defs (node_modules/eve/dist/src/public/
// definitions/approval.d.ts + callback-context.d.ts): `ApprovalContext`
// extends `SessionContext`, whose `session.turn` field is REQUIRED — not
// optional — typed `{ id: string, sequence: number }`
// (node_modules/eve/dist/src/channel/types.d.ts). So `ctx.session.turn.id`
// is always present in practice; this module still reads it defensively
// (never assumes a third-party object's runtime shape matches its
// compile-time type) but does not need a magic placeholder for "turn id
// absent" the way an earlier sketch of this design considered.
//
// idempotencyKey derivation (own design decision, documented here because it
// deliberately goes beyond the shape first sketched for this seam):
// `${eveSessionId}:${turnId}:${toolName}:${hash(toolInput)}`. A key of just
// `eveSessionId:turnId:toolName` is stable across retries of the SAME call
// but ALSO collides across a genuinely different call to the SAME tool
// within the SAME turn — e.g. the model calling `create_issue` twice back to
// back for two different slices, which Eve's own multi-step-per-turn loop
// allows (turn.id is stable across every step of one turn; only
// step/sequence advances). Without folding toolInput in, a human approving
// slice 1 would cause slice 2's (unreviewed, different-content) call to
// replay slice 1's already-approved decision — a real safety gap, not a
// cosmetic one. Hashing toolInput closes it: two calls with different
// content get different keys (correctly treated as separate approvals),
// while a true retry of the identical logical call (identical parsed input)
// still lands on the identical key (correctly deduped, matching the
// console's own (eveSessionId, requestId) idempotent-insert in PR ②'s
// console-side change).
//
// No SDK, no network primitives baked into the pure driver
// (`runConsoleGatedApproval`): the HTTP transport and the poll's
// sleep/clock are injected seams (real fetch-with-timeout + real
// setTimeout-based sleep + real Date.now in the thin `consoleGatedApproval`
// wrapper at the bottom of this file), so every branch — approval, denial,
// expiry, and every infrastructure failure — is unit-testable without a
// live console or a real 30-minute wait. Unlike the sibling *.core.mjs
// modules (send_connect_link, fetch_workspace_memory, create_workspace,
// create_repo), this one also OWNS its transport default: it is not a whole
// tool with its own `agent/tools/*.ts` wrapper — it's the shared `approval`
// callback three DIFFERENT tools wire in — so the thin ctx-extracting entry
// point production code actually calls lives here too, right next to the
// pure core it wraps, rather than in a separate per-tool file.
//
// ARCHITECTURAL RESIDUAL (acceptable for v1; revisit if it bites): while an
// approval is pending, `pollApprovalStatus`'s `await` keeps the calling Eve
// turn open for as long as POLL_TTL_MS (up to 30 minutes) — from Eve's point
// of view, this whole approval fn call is a single durable-workflow step
// blocked on the poll, not a cheap idle wait. That's an acceptable v1
// trade-off at today's traffic, but if Eve's turn-concurrency limits or a
// workflow-level step/turn timeout ever start to bite, THIS is the mechanism
// to revisit (e.g. moving the wait outside the turn, or shortening
// POLL_TTL_MS) — tracked under issue #1273.

import { createHash } from "node:crypto";

/** The console-owned approvals seam (issue #1273 PR ①), joined onto the console base. */
export const APPROVALS_PATH = "/api/v1/runner/approvals";

// Literal reason text per Eve's ApprovalStatus contract (issue #1273 PR ②
// brief). No token/URL/raw-error text is ever interpolated into any of
// these — every reason is one of these four fixed strings, by construction,
// so nothing secret-shaped can ever ride out in a reason a human reads.
export const APPROVED_REASON = "approved in chat";
export const DENIED_REASON = "denied in chat";
export const EXPIRED_REASON =
  "the approval request timed out waiting for a response in chat — ask again if you still want this to run";
export const INFRA_FAILURE_REASON =
  "couldn't reach the approval service — try again in a moment";

// Poll backoff: 2s -> 5s -> 10s, then capped at 10s for every subsequent
// attempt, jittered by up to +250ms so many concurrent pollers don't beat in
// lockstep against the console.
const POLL_BACKOFF_SEQUENCE_MS = [2000, 5000, 10000];
const POLL_JITTER_MS = 250;

// A single transient GET failure (a dropped connection, a momentary 502)
// shouldn't be enough to deny a 30-minute human approval outright — that's a
// disproportionate outcome for one network blip that has nothing to do with
// the approval decision itself. So a failed poll gets exactly ONE immediate
// retry after this short, FIXED (unjittered, unrelated to the backoff
// schedule above) delay; only if that retry ALSO fails do we fail closed as
// before. Two consecutive failures in a row reads as genuine infrastructure
// trouble rather than a blip, and the existing fail-closed denial still
// applies at that point — this is a tolerance for one bad beat, not a
// general retry-forever policy.
const BLIP_RETRY_DELAY_MS = 500;

// Overall poll budget: past this, an unresolved "pending" is treated as an
// honest expiry, never a silent approval. This is the v1 mechanism (no
// server-side expiry sweep exists yet — see the PR brief's Out of Scope).
const POLL_TTL_MS = 30 * 60 * 1000;

// Per-HTTP-call timeout for the real transport — matches the TIMEOUT_MS
// idiom already used by the tool wrappers (send_connect_link.ts,
// create_workspace.ts, create_repo.ts) so a hung console can never hang an
// individual POST/GET indefinitely. This bounds ONE call, not the overall
// poll — the poll's own ceiling is POLL_TTL_MS above.
const REQUEST_TIMEOUT_MS = 8000;

// Hard backstop on the poll loop, independent of the TTL/clock math above.
// At the real backoff cadence (2s/5s/10s/10s/...) 30 minutes is well under
// 200 iterations, so this can never fire in honest production use — it
// exists purely so a broken `now`/clock (a bad injected fake in a test, or
// an unforeseen bug in the TTL comparison itself) can never turn this loop
// into an unbounded one. Caught the hard way: an early draft of this
// module's own test suite had exactly this bug (a fake clock that never
// advanced, paired with a transport that never resolved to a terminal
// status) and spun until the test process ran out of heap. Reached, this
// resolves the SAME way an expired TTL does — an honest denial, never a
// throw and never an approval.
const MAX_POLL_ATTEMPTS = 1000;

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared: each core module here is pure and
 * dependency-free of the others by design.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/**
 * Build the POST .../approvals URL.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildApprovalsUrl(baseUrl) {
  return `${baseUrl}${APPROVALS_PATH}`;
}

/**
 * Build the GET .../approvals/[id] poll URL.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} approvalId
 * @returns {string}
 */
export function buildApprovalStatusUrl(baseUrl, approvalId) {
  return `${baseUrl}${APPROVALS_PATH}/${encodeURIComponent(approvalId)}`;
}

/**
 * Canonicalize a value before hashing: recursively sort object keys so two
 * objects with identical content but a different key-insertion order
 * serialize identically. Arrays keep their own element order — order IS
 * meaningful there, unlike an object's key order, which is not.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Hash a tool's parsed input into a short, stable hex digest. Used only to
 * disambiguate the idempotency key (see the module comment above) — this is
 * NOT a security boundary, just a practical collision-avoidance measure, so
 * a short truncated digest is plenty. Canonicalizes first (recursively
 * sorted object keys, arrays keep their order) so two logically-identical
 * inputs whose keys just happened to be built/serialized in a different
 * order — e.g. the model producing an equivalent object a second time, or a
 * different JS engine's own enumeration order — still hash identically,
 * rather than spuriously reading as a "different" call.
 *
 * @param {unknown} toolInput
 * @returns {string}
 */
export function hashToolInput(toolInput) {
  const json = JSON.stringify(canonicalize(toolInput ?? {}));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * Derive the idempotency key a caller (this module) composes for
 * POST /api/v1/runner/approvals. Stable across retries of the SAME logical
 * call (identical session, turn, tool, and parsed input); distinct across a
 * genuinely different call — a different turn, a different tool, or the
 * SAME tool called again within the SAME turn with different input (see the
 * module comment's worked example of why toolInput must be folded in).
 *
 * @param {{ eveSessionId?: string, turnId?: string, toolName?: string, toolInput?: unknown }} args
 * @returns {string}
 */
export function deriveIdempotencyKey({ eveSessionId, turnId, toolName, toolInput }) {
  const session = String(eveSessionId ?? "").trim();
  const turn = String(turnId ?? "").trim();
  const tool = String(toolName ?? "").trim();
  return `${session}:${turn}:${tool}:${hashToolInput(toolInput)}`;
}

/**
 * The poll backoff schedule: 2s, 5s, 10s, then capped at 10s for every
 * attempt after that — each with up to +250ms of jitter so concurrent
 * pollers don't all retry in lockstep.
 *
 * @param {number} attempt — 0-based
 * @returns {number} delay in milliseconds
 */
export function nextBackoffDelay(attempt) {
  const base =
    POLL_BACKOFF_SEQUENCE_MS[Math.min(attempt, POLL_BACKOFF_SEQUENCE_MS.length - 1)];
  return base + Math.floor(Math.random() * POLL_JITTER_MS);
}

function approvedStatus() {
  return { type: "approved", reason: APPROVED_REASON };
}

function deniedStatus(reason) {
  return { type: "denied", reason };
}

/** Map a terminal console status string to Eve's ApprovalStatus shape. Any unrecognized value fails closed (denied, infra reason). */
function mapTerminalStatus(status) {
  if (status === "approved") return approvedStatus();
  if (status === "denied") return deniedStatus(DENIED_REASON);
  if (status === "expired") return deniedStatus(EXPIRED_REASON);
  return deniedStatus(INFRA_FAILURE_REASON);
}

/**
 * POST the approval request. Single attempt, no retry — matches the
 * sibling core modules' "one attempt, report don't retry" philosophy applied
 * to this one HTTP call (the RETRY-shaped behavior in this module is the
 * poll loop below, which is waiting for a human, not recovering from a
 * transport error).
 */
async function postApprovalRequest({
  baseUrl,
  token,
  eveSessionId,
  toolName,
  toolInput,
  idempotencyKey,
  transport,
}) {
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
      body: JSON.stringify({ eveSessionId, toolName, toolInput, idempotencyKey }),
    });
  } catch {
    return { ok: false };
  }

  // Number(undefined/null/garbage) is NaN, and NaN < 200 and NaN >= 300 are
  // BOTH false — without the explicit finiteness check, a missing or
  // malformed status would silently fall through as "in range" and this
  // would go on to trust whatever body the transport handed back. Fail
  // closed instead: anything that isn't a real HTTP status is treated as a
  // failure, same as an explicit non-2xx.
  const httpStatus = Number(res && res.status);
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) return { ok: false };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false };
  }

  const approvalId = body && typeof body === "object" ? body.approvalId : undefined;
  const status = body && typeof body === "object" ? body.status : undefined;
  if (typeof approvalId !== "string" || !approvalId || typeof status !== "string" || !status) {
    return { ok: false };
  }
  return { ok: true, approvalId, status };
}

/**
 * GET one status poll. This function itself makes a single attempt with no
 * retry of its own; it's the CALLER, `pollApprovalStatus` below, that
 * retries a failed call here exactly once (see BLIP_RETRY_DELAY_MS) before
 * treating it as a fail-closed denial — see the module comment on why
 * "never throws" matters more than "never gives up".
 */
async function getApprovalStatus({ baseUrl, token, approvalId, transport }) {
  const url = buildApprovalStatusUrl(baseUrl, approvalId);
  let res;
  try {
    res = await transport(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    return { ok: false };
  }

  // See postApprovalRequest's identical guard above: Number(undefined) is
  // NaN, and NaN < 200 / NaN >= 300 are both false, so without the explicit
  // finiteness check a missing/garbage status would silently read as
  // "in range". Fail closed instead.
  const httpStatus = Number(res && res.status);
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) return { ok: false };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false };
  }

  const status = body && typeof body === "object" ? body.status : undefined;
  if (typeof status !== "string" || !status) return { ok: false };
  return { ok: true, status };
}

/**
 * Poll GET .../approvals/[id] with backoff until a terminal status or the
 * overall TTL. Backoff happens BEFORE each GET (so the first poll doesn't
 * fire immediately after the POST, when no human has had time to react
 * yet); the TTL is checked once per iteration, before sleeping again. A
 * failed GET gets exactly one immediate retry (BLIP_RETRY_DELAY_MS) before
 * this fails the poll closed — see that constant's own comment for why.
 */
async function pollApprovalStatus({ baseUrl, token, approvalId, transport, sleep, now }) {
  const deadline = now() + POLL_TTL_MS;
  let attempt = 0;

  while (attempt < MAX_POLL_ATTEMPTS) {
    if (now() >= deadline) return deniedStatus(EXPIRED_REASON);

    await sleep(nextBackoffDelay(attempt));
    attempt += 1;

    let polled = await getApprovalStatus({ baseUrl, token, approvalId, transport });
    if (!polled.ok) {
      // One transient failure gets exactly one immediate retry (see
      // BLIP_RETRY_DELAY_MS' own comment) — a 30-min human approval
      // shouldn't die to a single network blip. A second consecutive
      // failure right here IS treated as infrastructure trouble, same as
      // before this retry existed: fail closed.
      await sleep(BLIP_RETRY_DELAY_MS);
      polled = await getApprovalStatus({ baseUrl, token, approvalId, transport });
      if (!polled.ok) return deniedStatus(INFRA_FAILURE_REASON);
    }
    if (polled.status !== "pending") return mapTerminalStatus(polled.status);
    // else still pending — loop back to the top and re-check the TTL.
  }
  // MAX_POLL_ATTEMPTS reached without a real 30-minute TTL trip — only
  // reachable if `now`/the clock is broken (see MAX_POLL_ATTEMPTS' own
  // comment). Fails exactly like an honest expiry, never a throw.
  return deniedStatus(EXPIRED_REASON);
}

/**
 * The pure, fully dependency-injected driver: every network call and every
 * time source is an injected seam (`transport`, `sleep`, `now`), so this is
 * exhaustively unit-testable without a live console or a real wait.
 * `consoleGatedApproval` below is the thin, ctx-reading wrapper that
 * supplies the REAL fetch/sleep/clock and is what the three gated tools
 * actually wire as their `approval` fn.
 *
 * Never throws (see the module's SAFETY LINE comment): every branch,
 * including a wholly unexpected internal error, resolves to an explicit
 * ApprovalStatus.
 *
 * @param {{ eveSessionId?: string, toolName?: string, toolInput?: unknown,
 *           idempotencyKey?: string, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}>,
 *           sleep: (ms: number) => Promise<void>,
 *           now?: () => number }} args
 * @returns {Promise<{type: "approved"|"denied", reason: string}>}
 */
export async function runConsoleGatedApproval({
  eveSessionId,
  toolName,
  toolInput,
  idempotencyKey,
  env = {},
  transport,
  sleep,
  now = Date.now,
}) {
  try {
    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return deniedStatus(INFRA_FAILURE_REASON);

    const sessionId = String(eveSessionId ?? "").trim();
    const tool = String(toolName ?? "").trim();
    const key = String(idempotencyKey ?? "").trim();
    if (!sessionId || !tool || !key) return deniedStatus(INFRA_FAILURE_REASON);

    const posted = await postApprovalRequest({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      eveSessionId: sessionId,
      toolName: tool,
      toolInput: toolInput ?? {},
      idempotencyKey: key,
      transport,
    });
    if (!posted.ok) return deniedStatus(INFRA_FAILURE_REASON);
    if (posted.status !== "pending") return mapTerminalStatus(posted.status);

    return await pollApprovalStatus({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      approvalId: posted.approvalId,
      transport,
      sleep,
      now,
    });
  } catch {
    // Belt-and-suspenders: this function must NEVER throw. Every branch
    // above already catches its own failures explicitly; this outermost
    // catch only guards against a wholly unforeseen internal error (e.g. a
    // broken injected fake in a test) and still resolves to an honest
    // denial rather than propagating — see the module's SAFETY LINE comment
    // for why relying on "the caller catches it anyway" is not good enough.
    return deniedStatus(INFRA_FAILURE_REASON);
  }
}

/** Real fetch with a timeout — mirrors the tool wrappers' own realTransport idiom (AbortController aborts after REQUEST_TIMEOUT_MS). */
async function realTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/** Real sleep — a plain setTimeout-backed delay. */
function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The actual `approval` fn wired into create_issue.ts / create_workspace.ts /
 * create_repo.ts: `approval: (ctx) => consoleGatedApproval(ctx)`.
 *
 * Extracts eveSessionId/toolName/toolInput/turnId straight off Eve's own
 * ApprovalContext (never model-supplied data — see the module comment for
 * the verified shape), derives the idempotency key, and drives
 * `runConsoleGatedApproval` with the REAL transport/sleep/clock. `deps` is
 * an optional override seam for tests only — production call sites never
 * pass a second argument.
 *
 * Never throws, even given a malformed/empty `ctx` (defensive: this reads a
 * third-party object at a boundary and must not let a shape surprise become
 * an uncaught rejection — see the module's SAFETY LINE comment).
 *
 * @param {{ session?: { id?: string, turn?: { id?: string } }, toolName?: string, toolInput?: unknown }} ctx
 * @param {{ env?: Record<string, string|undefined>, transport?: Function, sleep?: Function, now?: () => number }} [deps]
 * @returns {Promise<{type: "approved"|"denied", reason: string}>}
 */
export async function consoleGatedApproval(ctx, deps = {}) {
  try {
    const session = ctx && typeof ctx === "object" ? ctx.session : undefined;
    const eveSessionId = session && typeof session === "object" ? session.id : undefined;
    const turn = session && typeof session === "object" ? session.turn : undefined;
    const turnId = turn && typeof turn === "object" ? turn.id : undefined;
    const toolName = ctx && typeof ctx === "object" ? ctx.toolName : undefined;
    const toolInput = ctx && typeof ctx === "object" ? ctx.toolInput : undefined;

    const idempotencyKey = deriveIdempotencyKey({ eveSessionId, turnId, toolName, toolInput });

    return await runConsoleGatedApproval({
      eveSessionId,
      toolName,
      toolInput,
      idempotencyKey,
      env: deps.env ?? process.env,
      transport: deps.transport ?? realTransport,
      sleep: deps.sleep ?? realSleep,
      now: deps.now ?? Date.now,
    });
  } catch {
    return deniedStatus(INFRA_FAILURE_REASON);
  }
}
