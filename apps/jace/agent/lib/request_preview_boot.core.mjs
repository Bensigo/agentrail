// request_preview_boot — root's seam onto the console's boot plane (B2b Task
// 3, plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md; live on main
// from #1573): POST apps/console/app/api/v1/runner/preview-boots to request a
// sandboxed preview boot of a PR's head commit, then poll GET
// .../preview-boots/{id} until the boot reaches a terminal status. No SDK, no
// network primitives of its own: the HTTP call is an injected `transport`
// seam (real fetch-with-timeout in the thin tool wrapper, a fake in tests),
// and the poll's delay/clock are injected too (`sleep`, `now`) — mirrors
// console_gated_approval.core.mjs's POST-then-poll idiom (backoff BEFORE
// each GET, an overall TTL checked every iteration, one blip-retry on a
// transient GET failure, a per-call transport timeout owned by the tool
// wrapper and distinct from the overall poll TTL, and a hard
// MAX_POLL_ATTEMPTS backstop against a broken clock) — so every branch is
// unit-testable without a live console or a real wait.
//
// ROOT tool: eveSessionId is resolved by the tool wrapper from
// `ctx.session.id` directly — this is a ROOT tool, not a declared subagent's
// own child session (see post_pr_review.ts's own doc-comment for the
// root-vs-subagent session-id-resolution distinction, and contrast the
// reviewer subagent's fetch_pr_diff.ts, which must read
// `ctx.session.parent.rootSessionId` instead).
//
// UNGATED, deliberately — same posture and reasoning as post_pr_review: this
// runs inside the headless review-job worker (review_job_worker.core.mjs),
// which has no human present to answer an approval prompt. Gating it would
// simply deadlock the job the same way post_pr_review's own header documents
// for its prior incident (the console only ever delivers an approval prompt
// on Telegram; every other channel left the request recorded but never
// shown, polling until its own TTL expired). This module's own poll
// (POLL_TTL_MS below) is a wait for the BOOT to come up, not a wait for a
// human decision, so there is no equivalent deadlock risk in waiting it out.
//
// Auth + config model: same as the sibling *.core.mjs modules — resolves
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN via resolveConsoleConfig
// (duplicated verbatim from fetch_issue.core.mjs — each core module here is
// pure and dependency-free of the others by design).
//
// TWO DIFFERENT TIME BUDGETS, not to be confused: POLL_TTL_MS (8 minutes,
// below) is how long ROOT is willing to wait for a `ready` boot before
// giving up and reporting `boot_timeout` — a real `npm ci` + dev-server boot
// can take minutes, hence the generous budget relative to
// console_gated_approval's own 30-minute human-approval TTL living in a
// different module entirely. This is completely distinct from the booted
// sandbox's own live-TTL on the console/worker side (how long it stays up
// once `ready`, before the worker tears it down) — this module has no
// visibility into, and does not enforce, that second number at all; it only
// ever asks "has this reached a terminal status yet".
//
// DOUBLE-BLIP DESIGN CHOICE (deliberately NOT a mirror of
// console_gated_approval's fail-fast-to-INFRA_FAILURE_REASON posture — see
// pollPreviewBoot's own comment below for the full reasoning): when a poll
// attempt's GET fails twice in a row (the one blip retry also fails), this
// module does NOT fail the whole request. It treats that attempt as
// yielding no verdict and lets the existing backoff/TTL loop try again,
// resolving to the honest `boot_timeout` if the console never recovers
// before the deadline. Fabricating a stronger claim (e.g. "the boot is
// lost") from a poll failure that says nothing about the boot's actual
// state would be exactly the kind of invented content
// fetch_issue.core.mjs's own DEGRADED_NOTES comment warns against ("They
// describe the RETRIEVAL gap, never the issue's contents").

export const PREVIEW_BOOTS_PATH = "/api/v1/runner/preview-boots";

// Poll backoff: 2s -> 5s -> 10s, then capped at 10s for every subsequent
// attempt, jittered by up to +250ms so many concurrent pollers don't beat in
// lockstep against the console. Identical schedule to
// console_gated_approval's own POLL_BACKOFF_SEQUENCE_MS/POLL_JITTER_MS,
// re-declared here (not imported) — this module stays dependency-free of the
// others by design, same as every sibling *.core.mjs.
export const POLL_BACKOFF_MS = [2000, 5000, 10000];
export const POLL_JITTER_MS = 250;

// Overall poll budget: past this, an unresolved boot is reported as an
// honest timeout, never a silent success or a fabricated failure. A real
// `npm ci` + dev-server boot can take minutes, hence 8 rather than
// console_gated_approval's 30 (that number bounds a wait for a HUMAN, a
// wholly different kind of budget — see this module's own header comment).
export const POLL_TTL_MS = 8 * 60 * 1000;

// Hard backstop on the poll loop, independent of the TTL/clock math above —
// exists purely so a broken `now`/clock (a bad injected fake in a test, or
// an unforeseen bug in the TTL comparison itself) can never turn this loop
// into an unbounded one. Mirrors console_gated_approval's own
// MAX_POLL_ATTEMPTS and its own regression test for exactly this failure
// mode (a zero-step fake clock paired with an always-pending transport spun
// until the test process ran out of heap).
export const MAX_POLL_ATTEMPTS = 1000;

// A single transient GET failure (a dropped connection, a momentary 502)
// shouldn't be treated as stronger evidence about the boot's state than it
// actually is — see pollPreviewBoot's own comment for why this module lets
// the outer backoff loop absorb a failure that survives even this retry,
// rather than failing the whole request closed the way
// console_gated_approval does for its own, differently-shaped domain. This
// is a SHORT, FIXED (unjittered, unrelated to the backoff schedule above)
// delay before the one immediate retry.
export const BLIP_RETRY_DELAY_MS = 500;

// Stable, cause-free notes for each degraded outcome. They describe the
// REQUEST/POLL gap, never invented detail about the boot's actual state —
// same posture as fetch_issue.core.mjs's own DEGRADED_NOTES. Never
// interpolates transport error text or secrets; `boot_failed`'s console-
// supplied `reason` rides as a separate, explicit extra field on the
// degraded() result instead (see requestPreviewBoot's own doc comment).
const NOTES = {
  config_missing:
    "The console preview-boot endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no preview boot could be requested.",
  bad_request:
    "The preview-boot request was malformed (missing/blank eveSessionId, repo, or headSha, or a non-positive prNumber); no preview boot could be requested.",
  boots_disabled:
    "Preview boots are not enabled on this console deployment right now; no preview boot could be requested.",
  not_enrolled:
    "This workspace is not enrolled for preview boots; no preview boot could be requested.",
  session_or_repo:
    "The console could not resolve this session, or this repo is not connected to the workspace; no preview boot could be requested.",
  no_workspace:
    "This session is not yet fully bound to a workspace; no preview boot could be requested.",
  request_failed:
    "The console rejected the preview-boot request with an unexpected status; no preview boot could be requested.",
  bad_body:
    "The console responded, but the body was not valid JSON or was missing the expected fields; the preview boot's state could not be confirmed.",
  unreachable:
    "The console's preview-boot endpoint could not be reached (network error); no preview boot could be requested. Do not retry from here.",
  boot_failed: "The preview boot failed to come up.",
  boot_gone: "The preview boot was torn down before it could be used.",
  boot_timeout:
    "The preview boot did not become ready within the time Jace waits for one; it may still be starting up on the console side.",
  boot_lost:
    "The console no longer recognizes this preview boot for this session; its state could not be confirmed.",
};

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
 * Build the POST .../preview-boots URL. Every field rides in the body, never
 * here.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildPreviewBootUrl(baseUrl) {
  return `${baseUrl}${PREVIEW_BOOTS_PATH}`;
}

/**
 * Build the GET .../preview-boots/{id} poll URL. `eveSessionId` rides as a
 * query param — the console route cross-checks it against the row's own
 * stored workspace before returning status, same cross-tenant-scoping
 * posture buildApprovalStatusUrl documents in console_gated_approval.core.mjs.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} id
 * @param {string} eveSessionId
 * @returns {string}
 */
export function buildPreviewBootStatusUrl(baseUrl, id, eveSessionId) {
  const query = new URLSearchParams({ eveSessionId }).toString();
  return `${baseUrl}${PREVIEW_BOOTS_PATH}/${encodeURIComponent(id)}?${query}`;
}

/**
 * Map the POST's HTTP status to an outcome. 2xx -> ok; everything else -> a
 * specific degraded reason, per the route's own documented response shapes
 * (apps/console/app/api/v1/runner/preview-boots/route.ts): 503 boots
 * disabled, 403 workspace not enrolled, 404 session/repo unresolved, 409 no
 * workspace bound yet, 400 malformed body. Anything else (including a 401
 * from a misconfigured bearer) falls into the generic `request_failed`
 * catch-all, which alone carries the raw status as an extra field — see
 * requestPreviewBoot's own doc comment.
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 403) return { ok: false, reason: "not_enrolled" };
  if (status === 404) return { ok: false, reason: "session_or_repo" };
  if (status === 409) return { ok: false, reason: "no_workspace" };
  if (status === 503) return { ok: false, reason: "boots_disabled" };
  return { ok: false, reason: "request_failed" };
}

/**
 * The poll backoff schedule: 2s, 5s, 10s, then capped at 10s for every
 * attempt after that — each with up to +250ms of jitter so concurrent
 * pollers don't all retry in lockstep. Identical shape to
 * console_gated_approval's own nextBackoffDelay.
 * @param {number} attempt — 0-based
 * @returns {number} delay in milliseconds
 */
export function nextBackoffDelay(attempt) {
  const base = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
  return base + Math.floor(Math.random() * POLL_JITTER_MS);
}

/**
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a
 * stable `reason` + a cause-free `note`; extra fields (e.g. `missing`,
 * `status`, `reason` for a failed boot) ride along. Deliberately carries no
 * free-form error text from the transport, so nothing untrusted or
 * secret-shaped can ever ride out.
 * @param {string} reason
 * @param {Record<string, unknown>} [extra]
 */
export function degraded(reason, extra = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    note: NOTES[reason] ?? NOTES.request_failed,
    ...extra,
  };
}

/**
 * POST the preview-boot request. Single attempt, no retry — a failed POST is
 * reported, not re-attempted (the poll loop below is the only retrying
 * behavior this module has, and it is retrying a WAIT, not a failed write).
 * @returns {Promise<{ ok: true, id: string } | { ok: false, result: object }>}
 */
async function postPreviewBoot({ baseUrl, token, eveSessionId, repo, prNumber, headSha, transport }) {
  const url = buildPreviewBootUrl(baseUrl);
  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId, repo, prNumber, headSha }),
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return { ok: false, result: degraded("unreachable") };
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);
  if (!cls.ok) {
    // Only the generic catch-all carries the raw status — every other named
    // reason already maps 1:1 to a specific code, so the code would be
    // redundant there (brief's own "else -> request_failed + status").
    const extra = cls.reason === "request_failed" ? { status } : {};
    return { ok: false, result: degraded(cls.reason, extra) };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, result: degraded("bad_body") };
  }

  const id = body && typeof body === "object" ? body.id : undefined;
  if (typeof id !== "string" || !id) {
    return { ok: false, result: degraded("bad_body") };
  }

  return { ok: true, id };
}

/**
 * GET one status poll. Single attempt, no retry of its own — it's the
 * CALLER, pollPreviewBoot below, that retries a failed call here exactly
 * once (BLIP_RETRY_DELAY_MS) before treating it as inconclusive. A 404 is
 * reported back as `notFound: true` distinctly: unlike a throw/5xx/bad body,
 * it is not a blip candidate (the same session id is used on every attempt,
 * so a 404 reflects a stable fact — this row is not visible to this session
 * — not a transient hiccup that a retry could resolve differently).
 */
async function getPreviewBootStatus({ baseUrl, token, id, eveSessionId, transport }) {
  const url = buildPreviewBootStatusUrl(baseUrl, id, eveSessionId);
  let res;
  try {
    res = await transport(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    return { ok: false, notFound: false };
  }

  // Number(undefined/null/garbage) is NaN, and NaN < 200 / NaN >= 300 are
  // BOTH false — the explicit finiteness check below avoids silently
  // treating a missing/malformed status as "in range" (same guard
  // console_gated_approval's own getApprovalStatus uses).
  const httpStatus = Number(res && res.status);
  if (httpStatus === 404) return { ok: false, notFound: true };
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, notFound: false };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, notFound: false };
  }

  const bootStatus = body && typeof body === "object" ? body.status : undefined;
  if (typeof bootStatus !== "string" || !bootStatus) return { ok: false, notFound: false };

  return {
    ok: true,
    status: bootStatus,
    url: typeof body.url === "string" ? body.url : null,
    reason: typeof body.reason === "string" ? body.reason : null,
  };
}

/**
 * Poll GET .../preview-boots/{id} with backoff until a terminal status or
 * the overall TTL. Backoff happens BEFORE each GET (so the first poll
 * doesn't fire immediately after the POST, when the boot has had no time to
 * even start); the TTL is checked once per iteration, before sleeping again
 * — identical control flow to console_gated_approval's pollApprovalStatus.
 *
 * DOUBLE-BLIP HANDLING DIFFERS FROM console_gated_approval ON PURPOSE: there,
 * a GET that still fails after its one blip retry fails the WHOLE poll
 * closed immediately (denied) — the right call for an approval, where
 * "denied" is inherently the safe default and there is no partial credit for
 * "still don't know". Here, a poll failure says nothing about whether the
 * BOOT is healthy — it only says Jace's own GET attempt didn't come back
 * clean — so this function does not treat it as a terminal outcome at all:
 * the attempt yields no verdict, and control falls through to the top of the
 * SAME while loop, which re-checks the TTL and tries again on the normal
 * backoff schedule. If the console never recovers before POLL_TTL_MS, this
 * still resolves honestly via the `boot_timeout` branch below — never a
 * fabricated `boot_failed`/`boot_gone` this module has no evidence for. A
 * 404, by contrast, IS treated as terminal on the spot (see
 * getPreviewBootStatus's own comment on why it is not a blip candidate).
 */
async function pollPreviewBoot({ baseUrl, token, id, eveSessionId, transport, sleep, now }) {
  const deadline = now() + POLL_TTL_MS;
  let attempt = 0;

  while (attempt < MAX_POLL_ATTEMPTS) {
    if (now() >= deadline) return degraded("boot_timeout");

    await sleep(nextBackoffDelay(attempt));
    attempt += 1;

    let polled = await getPreviewBootStatus({ baseUrl, token, id, eveSessionId, transport });
    if (!polled.ok) {
      if (polled.notFound) return degraded("boot_lost");
      // One transient GET failure gets exactly one immediate retry (see
      // BLIP_RETRY_DELAY_MS' own comment) — mirrors console_gated_approval's
      // own blip tolerance, just with a different terminal outcome on a
      // second consecutive failure (see this function's own header comment).
      await sleep(BLIP_RETRY_DELAY_MS);
      polled = await getPreviewBootStatus({ baseUrl, token, id, eveSessionId, transport });
      if (!polled.ok && polled.notFound) return degraded("boot_lost");
      // else (still !polled.ok): falls through with no verdict this
      // attempt — the outer while loop's own backoff/TTL governs from here.
    }

    if (polled.ok) {
      if (polled.status === "ready") {
        if (typeof polled.url !== "string" || !polled.url.trim()) {
          return degraded("bad_body");
        }
        return { ok: true, id, url: polled.url };
      }
      if (polled.status === "failed") return degraded("boot_failed", { reason: polled.reason });
      if (polled.status === "torn_down") return degraded("boot_gone");
      // pending / claimed / booting / any other value this module doesn't
      // recognize as terminal -> still in flight -> loop back and re-check
      // the TTL.
    }
  }
  // MAX_POLL_ATTEMPTS reached without a real TTL trip — only reachable if
  // `now`/the clock is broken (see MAX_POLL_ATTEMPTS' own comment). Resolves
  // exactly like an honest timeout, never a throw.
  return degraded("boot_timeout");
}

/**
 * Request a sandboxed preview boot of `repo`'s `headSha` for PR `prNumber`,
 * then wait for it to become ready. Never throws:
 *
 *   1. unset console config                    -> degraded("config_missing", {missing})
 *   2. blank eveSessionId/repo/headSha, or a
 *      non-positive-integer prNumber            -> degraded("bad_request")
 *   3. POST transport throws                    -> degraded("unreachable")
 *   4. POST non-2xx                              -> degraded(<mapped reason>[, {status}])
 *   5. POST non-JSON / missing `id` in the body  -> degraded("bad_body")
 *   6. poll reaches `ready`                      -> { ok: true, id, url }
 *   7. poll reaches `failed`                     -> degraded("boot_failed", {reason})
 *   8. poll reaches `torn_down`                  -> degraded("boot_gone")
 *   9. poll TTL (or the MAX_POLL_ATTEMPTS
 *      backstop) elapses first                   -> degraded("boot_timeout")
 *  10. poll GET 404s                              -> degraded("boot_lost")
 *
 * `reason` on `boot_failed` (step 7) relays the console's OWN `reason`
 * column verbatim (coerced to a string, or null) — this is trusted,
 * operational text from Jace's own boot worker (e.g. "npm ci exited 1"),
 * not untrusted PR-diff content, so unlike post_pr_review's `summary`/
 * `comments` it needs no hardenUntrusted() pass before riding out.
 *
 * @param {{ eveSessionId: string, repo: string, prNumber: number, headSha: string,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}>,
 *           sleep: (ms: number) => Promise<void>,
 *           now?: () => number }} args
 * @returns {Promise<{ok:true,id:string,url:string|null} | {ok:false,degraded:true,reason:string,note:string,[k:string]:unknown}>}
 */
export async function requestPreviewBoot({
  eveSessionId,
  repo,
  prNumber,
  headSha,
  env = {},
  transport,
  sleep,
  now = Date.now,
}) {
  try {
    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

    const sessionId = String(eveSessionId ?? "").trim();
    const repoTrimmed = String(repo ?? "").trim();
    const prNum = Number(prNumber);
    const headShaTrimmed = String(headSha ?? "").trim();
    if (!sessionId || !repoTrimmed || !Number.isInteger(prNum) || prNum <= 0 || !headShaTrimmed) {
      return degraded("bad_request");
    }

    const posted = await postPreviewBoot({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      eveSessionId: sessionId,
      repo: repoTrimmed,
      prNumber: prNum,
      headSha: headShaTrimmed,
      transport,
    });
    if (!posted.ok) return posted.result;

    return await pollPreviewBoot({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      id: posted.id,
      eveSessionId: sessionId,
      transport,
      sleep,
      now,
    });
  } catch {
    // Belt-and-suspenders, mirrors consoleGatedApproval's own outermost
    // catch: this function must NEVER throw (a headless review-job worker
    // has no human to surface an uncaught rejection to). Every branch above
    // already handles its own failures explicitly; this only guards a
    // wholly unforeseen internal error (e.g. a broken injected fake in a
    // test) and still resolves to an honest degrade rather than propagating.
    return degraded("request_failed");
  }
}
