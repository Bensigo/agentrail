// Unit tests for the Arc B headless review-job worker's PURE loop core. All
// I/O is injected (claim/bind/complete/openSession/promptFor) so every
// branch — idle poll, happy path, a bind failure, a send() failure, a send()
// timeout, and every injected-function throw — is exercised deterministically:
// no live eve session, no console, no real 30s/15min waits (intervalMs/
// jobTimeoutMs are set to a few milliseconds per test that needs them).
//
// ARC B REVIEW FIX WAVE (per-job session restructure): this is the SECOND
// version of this test file. The first version's "no job" case opened (then
// closed) a session before claiming — deliberate at the time, because
// claim-time session binding meant the session had to exist before `claim`
// could supply an `eveSessionId`. That design's own idle-poll cost (a real
// model turn on every 30s poll, even at rest) was reviewed as an Important
// severity issue once the mechanism was concrete — see review_job_worker.mjs's
// own header comment ("THE SESSION-MINTING PROBLEM") for the mechanism this
// refers to. This version claims FIRST: an idle poll now opens no session and
// mints no model turn at all; a session only ever opens for an actual claimed
// job, and a NEW `bind` seam (called after openSession, before the real
// review turn) is what now carries the eveSessionId->job binding that used to
// ride inside `claim` itself. See review_job_worker.core.mjs's own header
// comment for the full rationale, including why a `bind` failure is
// deliberately NOT reported via `complete()` the way an `openSession`/`send`
// failure is.
//
// The rejection-tripwire test mirrors ack-on-work.core.test.mjs's
// (apps/jace/test/ack-on-work.core.test.mjs:266-286) scoped
// process.on("unhandledRejection", ...)/process.off(...) pattern — attached
// and torn down inside the ONE test that actually risks it: a send() that
// loses the Promise.race to jobTimeoutMs and rejects LATE, after the tick has
// already resolved. Every other failure path here (claim throws, bind
// throws, complete throws, send rejects fast) is directly awaited-and-caught,
// never raced, so it carries no such risk by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewJobWorker } from "../agent/lib/review_job_worker.core.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeJob(overrides = {}) {
  return {
    id: "job-1",
    repo: "ada/widgets",
    prNumber: 7,
    headSha: "abc123",
    event: "opened",
    workspaceId: "ws-1",
    ...overrides,
  };
}

// The shape review_job_prompt.mjs's REVIEW_JOB_RESULT_SCHEMA describes:
// {posted, reviewUrl, verdict, blockers, summaryLine, criterionResults}.
function makeResult(overrides = {}) {
  return {
    posted: true,
    reviewUrl: "https://github.com/ada/widgets/pull/7#pullrequestreview-1",
    verdict: "not_proven",
    blockers: [],
    summaryLine: "ada/widgets#7: not_proven",
    criterionResults: [
      {
        criterionId: "AC-1",
        state: "not_proven",
        expected: "The saved value is visible.",
        observed: "The exact-head preview was ready; execution evidence is pending R7.2.",
        evidenceRefs: ["preview-boot:boot-1"],
      },
    ],
    ...overrides,
  };
}

// A fully-wired set of fakes for tests that only care about ONE branch —
// override individual fields per test rather than repeating all five.
function baseDeps(overrides = {}) {
  return {
    claim: async () => null,
    bind: async () => {},
    complete: async () => {},
    openSession: async () => ({ id: "session-1", send: async () => makeResult(), close: async () => {} }),
    promptFor: (job) => `review ${job.id}`,
    resultSchema: { type: "object" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tick() — no job: the restored "no session opened" contract
// ---------------------------------------------------------------------------

test('tick() with no job (claim() resolves null) opens NO session, calls NO bind, calls NO complete, resolves "idle"', async () => {
  let openSessionCalled = false;
  let bindCalled = false;
  let completeCalled = false;
  const claimCalls = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => {
        claimCalls.push(true);
        return null;
      },
      openSession: async () => {
        openSessionCalled = true;
        throw new Error("must not be called — there is no job to open a session for");
      },
      bind: async () => {
        bindCalled = true;
      },
      complete: async () => {
        completeCalled = true;
      },
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "idle");
  assert.equal(claimCalls.length, 1);
  assert.equal(openSessionCalled, false, "an idle poll must open NO session and mint NO model turn");
  assert.equal(bindCalled, false);
  assert.equal(completeCalled, false);
});

// ---------------------------------------------------------------------------
// tick() — happy path
// ---------------------------------------------------------------------------

test('happy path: claims FIRST (no args), opens a session only for the claimed job, binds it, sends promptFor(job)+schema, completes "posted" with the structured result\'s fields, closes the session, resolves "done"', async () => {
  const order = [];
  const job = makeJob();
  const structured = makeResult();
  const bindArgs = [];
  const sendArgs = [];
  const completeArgs = [];

  const worker = createReviewJobWorker({
    claim: async () => {
      order.push("claim");
      return job;
    },
    bind: async (args) => {
      order.push("bind");
      bindArgs.push(args);
    },
    complete: async (args) => {
      order.push("complete");
      completeArgs.push(args);
    },
    openSession: async () => {
      order.push("openSession");
      return {
        id: "session-happy-1",
        send: async (args) => {
          order.push("send");
          sendArgs.push(args);
          return structured;
        },
        close: async () => {
          order.push("close");
        },
      };
    },
    promptFor: (j) => `Review PR #${j.prNumber} in ${j.repo} at ${j.headSha}`,
    resultSchema: { type: "object", required: ["posted"] },
  });

  const outcome = await worker.tick();

  assert.equal(outcome, "done");
  assert.deepEqual(
    order,
    ["claim", "openSession", "bind", "send", "complete", "close"],
    "claim is cheap and first; a session opens only once a job exists; binding happens before the real review turn is ever sent",
  );
  assert.deepEqual(bindArgs, [{ jobId: "job-1", eveSessionId: "session-happy-1" }]);
  assert.deepEqual(sendArgs, [
    {
      message: "Review PR #7 in ada/widgets at abc123",
      outputSchema: { type: "object", required: ["posted"] },
    },
  ]);
  assert.deepEqual(completeArgs, [
    {
      jobId: "job-1",
      outcome: "posted",
      postedReviewUrl: structured.reviewUrl,
      verdict: structured.verdict,
      summaryLine: structured.summaryLine,
      criterionResults: structured.criterionResults,
    },
  ]);
});

// ---------------------------------------------------------------------------
// tick() — B2a §1 Task 3: result.evidenceKeys maps through complete() on the
// posted path, additively (spec
// docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md). The
// happy-path test above (unmodified) is the additive proof: a result with no
// evidenceKeys at all still produces that exact 5-key complete() call, no
// sixth key riding along — Node's `assert.deepEqual` (strict mode) would
// fail that test the instant an `evidenceKeys: undefined` key rode
// unconditionally onto every completion, which is exactly why the mapping
// below is conditional rather than a bare passthrough.
// ---------------------------------------------------------------------------

test('happy path WITH evidenceKeys: a structured result carrying evidenceKeys passes them through to complete() unchanged', async () => {
  const job = makeJob();
  const structured = makeResult({ evidenceKeys: ["review-evidence/ws-1/ada__widgets/7/abc123/ac-1/1.png"] });
  const completeArgs = [];

  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "session-evidence-1",
        send: async () => structured,
        close: async () => {},
      }),
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "done");
  assert.deepEqual(completeArgs, [
    {
      jobId: "job-1",
      outcome: "posted",
      postedReviewUrl: structured.reviewUrl,
      verdict: structured.verdict,
      summaryLine: structured.summaryLine,
      evidenceKeys: structured.evidenceKeys,
      criterionResults: structured.criterionResults,
    },
  ]);
});

test('posted:true without criterionResults is completed as failed rather than claiming a Contract review ran', async () => {
  const completeArgs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => makeJob(),
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "session-no-criteria",
        send: async () => {
          const { criterionResults, ...withoutCriteria } = makeResult();
          return withoutCriteria;
        },
        close: async () => {},
      }),
    }),
  );

  assert.equal(await worker.tick(), "failed");
  assert.equal(completeArgs.length, 1);
  assert.equal(completeArgs[0].jobId, "job-1");
  assert.equal(completeArgs[0].outcome, "failed");
  assert.match(completeArgs[0].error, /omitted criterionResults required for the confirmed Acceptance Contract/);
});

// ---------------------------------------------------------------------------
// tick() — bind() fails: NOT reported via complete()
// ---------------------------------------------------------------------------

test('bind() throwing is logged, closes the session, does NOT call complete() (the job\'s server-side state is no longer this worker\'s to resolve), resolves "failed", loop alive', async () => {
  const job = makeJob();
  let closed = 0;
  let completeCalled = false;
  const bindArgs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      bind: async (args) => {
        bindArgs.push(args);
        throw new Error("console returned 503 — job released back to queued");
      },
      complete: async () => {
        completeCalled = true;
      },
      openSession: async () => ({
        id: "session-bind-fail-1",
        send: async () => makeResult(),
        close: async () => {
          closed += 1;
        },
      }),
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "failed");
  assert.deepEqual(bindArgs, [{ jobId: "job-1", eveSessionId: "session-bind-fail-1" }]);
  assert.equal(
    completeCalled,
    false,
    "a bind failure must never call complete() — completing here could resolve a DIFFERENT worker's now-active claim",
  );
  assert.equal(closed, 1, "the session opened before the failed bind must still be closed");

  // Loop alive: a subsequent tick still runs the full flow.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "failed");
  assert.equal(closed, 2);
});

// ---------------------------------------------------------------------------
// tick() — openSession() fails AFTER a successful claim: IS reported via complete()
// ---------------------------------------------------------------------------

test('openSession() throwing AFTER a successful claim IS reported via complete(outcome:"failed") — the job is still genuinely running under this claim, unlike a bind failure', async () => {
  const job = makeJob();
  const completeArgs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => {
        throw new Error("eve host unreachable");
      },
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "failed");
  assert.deepEqual(completeArgs, [{ jobId: "job-1", outcome: "failed", error: "eve host unreachable" }]);

  // Loop alive.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "failed");
  assert.equal(completeArgs.length, 2);
});

// ---------------------------------------------------------------------------
// tick() — send() rejects (fast, well before jobTimeoutMs)
// ---------------------------------------------------------------------------

test('send() rejecting completes outcome:"failed" with the rejection\'s message, closes the session, resolves "failed", and the loop keeps running', async () => {
  const job = makeJob();
  const completeArgs = [];
  let closed = 0;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: async () => {
          throw new Error("model blew up mid-review");
        },
        close: async () => {
          closed += 1;
        },
      }),
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "failed");
  assert.deepEqual(completeArgs, [{ jobId: "job-1", outcome: "failed", error: "model blew up mid-review" }]);
  assert.equal(closed, 1);

  // The loop survives: the very next tick still runs the full flow again,
  // rather than being stuck or dead after a failure.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "failed");
  assert.equal(completeArgs.length, 2);
  assert.equal(closed, 2);
});

// ---------------------------------------------------------------------------
// tick() — send() exceeds jobTimeoutMs
// ---------------------------------------------------------------------------

test('send() exceeding jobTimeoutMs times out: completes outcome:"failed" with the exact timeout message, closes the session, resolves "failed"', async () => {
  const job = makeJob();
  const completeArgs = [];
  let closed = 0;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: () => new Promise(() => {}), // never settles
        close: async () => {
          closed += 1;
        },
      }),
      jobTimeoutMs: 15,
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "failed");
  assert.deepEqual(completeArgs, [{ jobId: "job-1", outcome: "failed", error: "review job timed out after 15ms" }]);
  assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// The rejection tripwire: a send() that LOSES the race and rejects late.
// ---------------------------------------------------------------------------

test("a send() that loses the race to jobTimeoutMs and rejects LATE never surfaces as an unhandled promise rejection", async () => {
  const job = makeJob();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    let rejectLate;
    const worker = createReviewJobWorker(
      baseDeps({
        claim: async () => job,
        openSession: async () => ({
          id: "s1",
          send: () =>
            new Promise((_resolve, reject) => {
              rejectLate = reject;
            }),
          close: async () => {},
        }),
        jobTimeoutMs: 10,
      }),
    );

    const outcome = await worker.tick();
    assert.equal(outcome, "failed");

    // The real send() "arrives late", well after the tick already resolved
    // via the timeout branch — the classic Promise.race loser-promise
    // hazard: if nothing were still subscribed to it, Node would report this
    // as unhandled.
    rejectLate(new Error("late model failure, arrives after the timeout already won"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "the losing send() promise must never go unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// tick() — claim() throws
// ---------------------------------------------------------------------------

test('claim() throwing is logged, resolves "idle" without ever opening a session, and never calls bind()/complete() — loop alive', async () => {
  const logs = [];
  let openSessionCalled = false;
  let bindCalled = false;
  let completeCalled = false;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => {
        throw new Error("db down");
      },
      openSession: async () => {
        openSessionCalled = true;
      },
      bind: async () => {
        bindCalled = true;
      },
      complete: async () => {
        completeCalled = true;
      },
      log: (msg, err) => logs.push({ msg, err }),
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "idle");
  assert.equal(openSessionCalled, false, "claim() failing must never reach openSession() — there is no job");
  assert.equal(bindCalled, false);
  assert.equal(completeCalled, false, "there is no job, so complete() must never be called");
  assert.ok(logs.length >= 1, "the failure must be logged");

  // Loop alive: a subsequent tick still runs normally rather than being stuck.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "idle");
});

// ---------------------------------------------------------------------------
// tick() — complete() throws
// ---------------------------------------------------------------------------

test('complete() throwing after a "posted" result is logged and swallowed; the session still closes; resolves "done"; loop alive (console\'s stale-requeue is the safety net)', async () => {
  const job = makeJob();
  const structured = makeResult();
  let closed = 0;
  const logs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async () => {
        throw new Error("console down");
      },
      openSession: async () => ({
        id: "s1",
        send: async () => structured,
        close: async () => {
          closed += 1;
        },
      }),
      log: (msg, err) => logs.push({ msg, err }),
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "done");
  assert.equal(closed, 1);
  assert.ok(logs.length >= 1);

  // Loop alive: calling tick() again still runs the full flow.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "done");
  assert.equal(closed, 2);
});

test('complete() throwing after a "failed" result (from send() throwing) is ALSO logged and swallowed; the session still closes; resolves "failed"', async () => {
  const job = makeJob();
  let closed = 0;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async () => {
        throw new Error("console down");
      },
      openSession: async () => ({
        id: "s1",
        send: async () => {
          throw new Error("model blew up");
        },
        close: async () => {
          closed += 1;
        },
      }),
    }),
  );

  const outcome = await worker.tick();
  assert.equal(outcome, "failed");
  assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// tick() — send() resolves with posted:false or posted absent (Arc B live
// smoke, 2026-08-02): root's post_pr_review fetch 404'd, the turn honestly
// resolved {posted: false, verdict: "degraded", ...}, and the job STILL
// completed outcome:"posted" with a null URL and nothing on GitHub. The core
// now reads result.posted and refuses to report success for anything but a
// literal `true`.
// ---------------------------------------------------------------------------

test('send() resolving with posted:false completes outcome:"failed" (never "posted"), with the verdict and summaryLine folded into the error, closes the session, resolves "failed", loop alive', async () => {
  const job = makeJob();
  const completeArgs = [];
  let closed = 0;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: async () =>
          makeResult({
            posted: false,
            verdict: "degraded",
            summaryLine: "ada/widgets#7: degraded — post_pr_review 404'd",
          }),
        close: async () => {
          closed += 1;
        },
      }),
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "failed");
  assert.equal(completeArgs.length, 1);
  assert.equal(completeArgs[0].jobId, "job-1");
  assert.equal(completeArgs[0].outcome, "failed");
  assert.match(completeArgs[0].error, /posted:false/);
  assert.match(completeArgs[0].error, /degraded/);
  assert.match(completeArgs[0].error, /post_pr_review 404'd/);
  assert.equal(closed, 1);

  // Loop alive: a subsequent tick still runs the full flow.
  const outcome2 = await worker.tick();
  assert.equal(outcome2, "failed");
  assert.equal(closed, 2);
});

test('send() resolving with the posted field absent entirely ALSO completes outcome:"failed" — the schema requires it, so a missing field is never charitably treated as success (no back-compat "absent means posted")', async () => {
  const job = makeJob();
  const completeArgs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: async () => {
          const { posted, ...withoutPosted } = makeResult();
          return withoutPosted;
        },
        close: async () => {},
      }),
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "failed");
  assert.equal(completeArgs.length, 1);
  assert.equal(completeArgs[0].outcome, "failed");
  assert.match(completeArgs[0].error, /posted:false/);
});

test("posted:false error still builds a sensible message when verdict/summaryLine are missing or empty — never throws while building the failure report", async () => {
  const job = makeJob();
  const completeArgs = [];
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: async () => ({ posted: false, reviewUrl: null, blockers: [] }),
        close: async () => {},
      }),
    }),
  );

  const outcome = await worker.tick();

  assert.equal(outcome, "failed");
  assert.equal(completeArgs[0].outcome, "failed");
  assert.match(completeArgs[0].error, /posted:false/);
});

test("posted:false error omits an overlong summaryLine (it is meant to be ONE line for the owner — a long one is not folded in verbatim)", async () => {
  const job = makeJob();
  const completeArgs = [];
  const longSummary = "x".repeat(500);
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => job,
      complete: async (args) => completeArgs.push(args),
      openSession: async () => ({
        id: "s1",
        send: async () => makeResult({ posted: false, verdict: "degraded", summaryLine: longSummary }),
        close: async () => {},
      }),
    }),
  );

  await worker.tick();

  assert.doesNotMatch(completeArgs[0].error, /x{500}/);
});

// ---------------------------------------------------------------------------
// start() / stop()
// ---------------------------------------------------------------------------

test("start() called twice does not leak a second interval; stop() halts ticking for good", async () => {
  let ticks = 0;
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => {
        ticks += 1;
        return null;
      },
      intervalMs: 5,
    }),
  );

  worker.start();
  worker.start(); // second call must be a no-op — if it weren't, this would double the tick rate below
  await sleep(40);
  worker.stop();
  const countAtStop = ticks;
  assert.ok(countAtStop >= 1, "the interval actually fired at least once");

  await sleep(40); // a leaked second interval (from a broken double-start guard) would keep incrementing here
  assert.equal(ticks, countAtStop, "no ticking continues after stop() — proves start() twice created only one interval");
});

test("stop() before start(), and repeated stop() calls, are safe no-ops", () => {
  const worker = createReviewJobWorker(baseDeps());
  assert.doesNotThrow(() => worker.stop());
  worker.start();
  assert.doesNotThrow(() => worker.stop());
  assert.doesNotThrow(() => worker.stop());
});

// ---------------------------------------------------------------------------
// In-flight guard — ticks never overlap
// ---------------------------------------------------------------------------

test('ticks never overlap: a tick() called while one is already in flight resolves "idle" immediately without a second claim', async () => {
  let claimCount = 0;
  const gate = deferred();
  const worker = createReviewJobWorker(
    baseDeps({
      claim: async () => {
        claimCount += 1;
        await gate.promise;
        return null;
      },
    }),
  );

  const firstTick = worker.tick(); // begins, blocks inside claim()
  const secondOutcome = await worker.tick(); // must short-circuit, not claim a second time
  assert.equal(secondOutcome, "idle");
  assert.equal(claimCount, 1, "the overlapping tick must not claim a second time");

  gate.resolve();
  const firstOutcome = await firstTick;
  assert.equal(firstOutcome, "idle"); // claim() resolves null once unblocked
});
