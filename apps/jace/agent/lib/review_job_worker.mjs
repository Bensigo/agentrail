// Arc B (Reviewer of Record) Task 6 — the ASSEMBLER. Builds the real
// `claim`/`complete`/`openSession`/`promptFor`/`resultSchema` seams
// `createReviewJobWorker` (Task 5, review_job_worker.core.mjs) needs and
// starts the loop. This file is deliberately thin: every DECISION about how
// the loop behaves already lives in the core; this file only wires real
// transports (review_job_console.mjs's `claimReviewJob`/`completeReviewJob`)
// and a real eve session (`eve/client`) into that core's injected shape.
//
// WORKER IDENTITY — `buildWorkerId`: `review-worker-<hostname>-<pid>`. Per
// Task 5's own header comment, the core has no configured identity for
// itself; Task 6 (this file) is where a stable one is resolved. Hostname
// alone collides across two processes on the same host (unlikely in this
// deployment, but free to avoid); pid alone collides across container
// restarts and gives an operator nothing to go on when reading console-side
// `claimed_by` in a log. The pair is stable for exactly one process's
// lifetime — all `claimed_by` bookkeeping needs — and self-describing in a
// log line without a lookup.
//
// EVE CLIENT HOST — `EVE_HOST`, default `http://127.0.0.1:2000`. Copied
// verbatim from apps/jace/scripts/needs-approval-roundtrip.mjs (the
// documented `eve/client` precedent this task's brief points at): eve's dev
// server binds 127.0.0.1:2000 in this container (that script's own header
// comment: "In one shell, start the sidecar: npm run dev (runs `eve dev` on
// 127.0.0.1:2000)"), and the review-job worker talks to the SAME in-process
// eve server the rest of Jace is already running behind, not a remote one —
// `Client({host: self})` per the design spec
// (docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md §4).
//
// *** THE SESSION-MINTING PROBLEM (verified against the installed eve@0.19.0
// SDK source, not assumed from the design spec's prose) ***
//
// The core's contract (review_job_worker.core.mjs's header comment) requires
// `openSession()` to resolve an `{id, send, close}` object whose `.id` is
// ALREADY a real, concrete string — `claim({eveSessionId: session.id})`
// reads it as a plain property, synchronously, before any `send()` has
// happened. The design spec's own §4 prose glosses over this as "create a
// fresh eve session... claim already bound it", as if `client.session()`
// alone produces an addressable id. It does not:
// node_modules/eve/dist/src/client/session-utils.js's
// `createInitialSessionState()` (what `client.session()` with no arguments
// constructs) returns bare `{streamIndex: 0}` — no sessionId at all. Per
// node_modules/eve/dist/src/client/session.js's `send()`, a session's real
// id is assigned SERVER-SIDE and only becomes known to the client after the
// first `send()`'s POST resolves — confirmed against the docs too
// (node_modules/eve/docs/concepts/sessions-runs-and-streaming.md, "Start a
// session": "eve responds right away. The JSON body carries a sessionId...").
// There is no lower-level "create a bare session" route either — that same
// session.js throws "Session.send requires a non-empty message..." for an
// empty first call, and the raw HTTP contract's own "Start a session"
// example always POSTs a `message`.
//
// So `openSession()` has to send something before a session id exists to
// hand `claim()` — and it has to do that before the review job (and
// therefore the real prompt) is even known, since `claim()` is what reveals
// the job. This file resolves that with a tiny, harmless BOOTSTRAP turn:
// open a session, send a one-line internal message under a dedicated
// single-field output schema (`SESSION_BOOTSTRAP_SCHEMA`) that forces eve's
// task mode and gets a fast, minimal, structured reply needing no tool
// calls, then use ITS `sessionId` as `.id`. This matches Task 5's own header
// comment, which already accepted the cost of this shape ("every idle 30s
// poll opens and immediately closes a real eve session... deliberate") —
// that acceptance is what makes a real (if minimal) LLM turn on every idle
// poll a documented tradeoff, not a surprise this file introduces.
//
// CONTINUING the SAME session for the real review turn afterward needs
// `preserveCompletedSessions: true` on the Client (ClientOptions' own doc
// comment: "By default, completed turns reset the client-side session so
// the next send() starts a fresh server-side conversation... [this option
// lets clients] preserve durable session state... across follow-up prompts
// until they explicitly create a new session"). The bootstrap turn's
// expected boundary is `session.completed` (a plain structured ack, no tool
// calls, so no HITL pause) — WITHOUT this flag the client's own convenience
// state resets on exactly that boundary, so the SECOND `send()` (the real
// review) would silently open a DIFFERENT session than the one `claim()`
// already told the console about. Because of that same risk, the bootstrap
// is only trusted when it reaches `status: "completed"` — NOT "waiting"
// either, even though a "waiting" boundary is also normally continuable
// (per eve's docs, "Other follow-up text is held until [a pending] approval
// is answered" — an unrelated review prompt landing on a session still
// waiting on some unexpected approval is a state this worker has no
// business trying to recover from; safer to fail the tick and retry next
// poll). `send()` below also re-checks `result.sessionId` against the id
// `openSession()` minted, on every call, as a defense-in-depth tripwire: if
// eve's session ever changed out from under this object for any reason,
// this throws instead of silently reporting a review as posted under the
// wrong session's binding.
//
// TIMEOUT — `openSession()`'s bootstrap round-trip is bounded by
// `SESSION_CREATE_TIMEOUT_MS`, both via an AbortController signal threaded
// into the real `session.send()` call (the SDK's own supported cancellation
// path — node_modules/eve/dist/src/client/types.d.ts's
// `SendTurnPayload.signal`) AND via the same synchronously-constructed
// `Promise.race` pattern review_job_worker.core.mjs's own header comment
// proves safe against the unhandled-rejection hazard (raced against a
// timeout promise built and entered into the race in the same tick, so a
// late rejection from the abandoned bootstrap call is never "unhandled").
// Belt-and-suspenders deliberately: the AbortSignal is the semantically
// correct cancellation for the real SDK; the Promise.race is what makes
// THIS file's own behavior (never hangs a tick) independently provable
// without depending on every layer between here and the network actually
// honoring that signal — and it's what makes the timeout unit-testable with
// a plain never-resolving fake, with no real fetch/AbortController plumbing
// involved. This is a LARGER timeout than the house 8000ms HTTP convention
// (review_job_console.mjs's REQUEST_TIMEOUT_MS) on purpose: this bounds a
// real (if minimal) model turn, not a plain REST call.
//
// `send()` (the REAL review turn) deliberately carries NO timeout of its own
// — review_job_worker.core.mjs already races it against `jobTimeoutMs` (Task
// 6 brief, obligation 1: "the core only races send against jobTimeoutMs"),
// and racing it AGAIN here with a much shorter window would wrongly kill a
// legitimately long-running review before the core's own (correct,
// 15-minute) ceiling ever gets a chance to.
//
// `close()` is a documented no-op: `eve/client`'s `ClientSession`
// (node_modules/eve/dist/src/client/session.d.ts) has no server-side "close"
// call at all — sessions are durable and server-managed, so there is
// nothing for a client to tear down. It exists purely so the core's
// best-effort `safeClose()` always has something safe to await.
//
// THE HONESTY COUPLING (Task 6 brief, explicit ask): review_job_worker.core.mjs
// resolves EVERY non-throwing `send()` as `outcome:"posted"` — it never
// reads `result.posted` at all (see that module's own inline comment:
// "blockers is deliberately dropped here"; `posted` is dropped the same
// way, just never called out there by name). That makes `posted:false`
// indistinguishable from `posted:true` to this loop. review_job_prompt.mjs's
// schema descriptions carry the honesty instruction instead (the prompt's
// own TEXT is a locked, verbatim contract per the brief — see that module's
// header): a claimed job's turn must genuinely fail (reject/error) when
// posting fails, never complete with a dishonest `posted:false`. Nothing in
// THIS file enforces that — it is root's own standing tool-failure
// behavior, outside every file this task touches — but the coupling is real
// and is exactly why `posted` still exists in the schema at all despite
// this loop never reading it: it is the one field a human reading a stored
// `review_jobs` row (or a later analytics pass) can use to sanity-check
// that an `outcome:"posted"` row's own structured result agreed.
//
// FLAG — this file does NOT check `JACE_REVIEW_WORKER` itself.
// agent/instrumentation.ts (Task 6 brief's literal code) gates the call to
// `startReviewJobWorker` on that env var, mirroring how it already gates
// nothing for `startDiscordGateway` inside THIS file's scope (that listener
// instead gates on `DISCORD_BOT_TOKEN` presence INSIDE itself) — two
// different, equally established gating shapes already coexist in this
// codebase; this file follows the brief's explicit choice of the former for
// this worker.

import { hostname } from "node:os";
import { Client } from "eve/client";
import { createReviewJobWorker } from "./review_job_worker.core.mjs";
import { reviewJobPrompt, REVIEW_JOB_RESULT_SCHEMA } from "./review_job_prompt.mjs";
import { claimReviewJob, completeReviewJob } from "./review_job_console.mjs";

export const DEFAULT_EVE_HOST = "http://127.0.0.1:2000";

// A real (if minimal) model turn, not a REST call — see this module's header
// comment ("TIMEOUT") for why this is deliberately larger than
// review_job_console.mjs's 8000ms house HTTP convention.
export const SESSION_CREATE_TIMEOUT_MS = 30_000;

// The bootstrap turn's own dedicated output schema — forces eve's task mode
// so the reply is fast, minimal, and needs no tool calls. Its CONTENT is
// never read by anything (see this module's header comment); only the
// turn's own `sessionId` and terminal `status` matter to `createOpenSessionFn`.
export const SESSION_BOOTSTRAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ready"],
  properties: {
    ready: {
      type: "boolean",
      description:
        "Always true. This bootstrap turn carries no real request — it exists only to mint a session id before a review job is claimed.",
    },
  },
};

const SESSION_BOOTSTRAP_MESSAGE =
  "Internal worker bootstrap: this session is opening ahead of any review job assignment, purely to obtain a session id. No job is attached yet — take no action and reply with only the required structured field.";

/**
 * `review-worker-<hostname>-<pid>` — see this module's header comment
 * ("WORKER IDENTITY") for why this pair and not either alone.
 *
 * @param {{ hostnameFn?: () => string, pid?: number }} [deps] — test-only overrides.
 * @returns {string}
 */
export function buildWorkerId({ hostnameFn = hostname, pid = process.pid } = {}) {
  return `review-worker-${hostnameFn()}-${pid}`;
}

/**
 * Curry `workerId` into the core's `claim({eveSessionId})` call (Task 6
 * brief, obligation 2) — the core itself has no configured identity to
 * source one from (Task 5's header comment: "This core has no configured
 * identity for itself").
 *
 * @param {{ workerId: string, env: Record<string, string|undefined>,
 *   claimReviewJobFn?: typeof claimReviewJob }} args — `claimReviewJobFn` is
 *   a test-only override; production callers rely on the default.
 * @returns {(args: { eveSessionId: string }) => Promise<unknown>}
 */
export function createClaimFn({ workerId, env, claimReviewJobFn = claimReviewJob }) {
  return ({ eveSessionId }) => claimReviewJobFn({ workerId, eveSessionId, env });
}

/**
 * Wire the core's `complete(fields)` call straight through to the real
 * transport, fixing `env`. Never adds an `eveSessionId` — the core never
 * sends one to `complete` in the first place (review_job_console.mjs's own
 * header comment), so there is nothing here to strip.
 *
 * @param {{ env: Record<string, string|undefined>,
 *   completeReviewJobFn?: typeof completeReviewJob }} args — `completeReviewJobFn`
 *   is a test-only override; production callers rely on the default.
 * @returns {(fields: object) => Promise<void>}
 */
export function createCompleteFn({ env, completeReviewJobFn = completeReviewJob }) {
  return (fields) => completeReviewJobFn({ ...fields, env });
}

/**
 * Build the core's `openSession()` seam against a real (or, in tests, fake)
 * `eve/client` `Client` instance. See this module's header comment
 * ("THE SESSION-MINTING PROBLEM") for the full mechanics this implements.
 *
 * @param {{ client: { session: () => any }, timeoutMs?: number }} args
 * @returns {() => Promise<{ id: string, send: (args: {message: string, outputSchema: unknown}) => Promise<unknown>, close: () => Promise<void> }>}
 */
export function createOpenSessionFn({ client, timeoutMs = SESSION_CREATE_TIMEOUT_MS }) {
  return async function openSession() {
    const session = client.session();
    const controller = new AbortController();
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`review-job-worker: session bootstrap timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let bootstrapResult;
    try {
      // Constructed and raced in the same synchronous step — see this
      // module's header comment ("TIMEOUT") for why that is what makes the
      // losing side of this race safe to abandon.
      const bootstrapPromise = session
        .send({
          message: SESSION_BOOTSTRAP_MESSAGE,
          outputSchema: SESSION_BOOTSTRAP_SCHEMA,
          signal: controller.signal,
        })
        .then((response) => response.result());
      bootstrapResult = await Promise.race([bootstrapPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (
      bootstrapResult.status !== "completed" ||
      typeof bootstrapResult.sessionId !== "string" ||
      !bootstrapResult.sessionId
    ) {
      throw new Error(
        `review-job-worker: session bootstrap ended in status "${bootstrapResult.status}" without a usable completed session`,
      );
    }

    const sessionId = bootstrapResult.sessionId;

    return {
      id: sessionId,
      async send({ message, outputSchema }) {
        // Deliberately no `signal`/timeout here — see this module's header
        // comment ("`send()` (the REAL review turn) deliberately carries NO
        // timeout of its own").
        const response = await session.send({ message, outputSchema });
        const result = await response.result();
        if (result.sessionId !== sessionId) {
          throw new Error(
            `review-job-worker: review turn ran under session "${result.sessionId}", expected "${sessionId}" — refusing to report a review posted under an unbound session`,
          );
        }
        if (result.data === undefined) {
          throw new Error(
            `review-job-worker: review turn ended with status "${result.status}" and no structured result`,
          );
        }
        return result.data;
      },
      async close() {
        // eve/client's ClientSession has no server-side "close" — see this
        // module's header comment.
      },
    };
  };
}

let started = false;

/**
 * Start the Arc B headless review-job worker once for this process. Safe to
 * call from a fire-and-forget context (see agent/instrumentation.ts): never
 * throws synchronously, and the returned promise never rejects — every
 * failure that can happen at start time is caught and logged, matching
 * startDiscordGateway's own discipline (agent/lib/discord-gateway.mjs).
 *
 * @param {Record<string, string|undefined>} [env]
 */
export async function startReviewJobWorker(env = process.env) {
  if (started) {
    console.warn(
      "[review-job-worker] startReviewJobWorker called again in the same process — ignoring (already started).",
    );
    return;
  }
  started = true;

  try {
    const host = String(env.EVE_HOST || DEFAULT_EVE_HOST).trim();
    const client = new Client({ host, preserveCompletedSessions: true });
    const workerId = buildWorkerId();

    const worker = createReviewJobWorker({
      claim: createClaimFn({ workerId, env }),
      complete: createCompleteFn({ env }),
      openSession: createOpenSessionFn({ client }),
      promptFor: reviewJobPrompt,
      resultSchema: REVIEW_JOB_RESULT_SCHEMA,
      log: (message, err) => {
        if (err) console.error("[review-job-worker]", message, err);
        else console.log("[review-job-worker]", message);
      },
    });

    console.log(`[review-job-worker] starting (workerId=${workerId}, eveHost=${host}).`);
    worker.start();
  } catch (err) {
    console.error(
      "[review-job-worker] failed to start:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
