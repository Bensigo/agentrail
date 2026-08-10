// Unit tests for the Arc B headless review-job worker's console transports:
// claimReviewJob / bindReviewJobSession / completeReviewJob, hitting the
// routes Task 4 built and the fix-wave's NEW bind route
// (apps/console/app/api/v1/runner/review-jobs/{claim,bind,complete}/route.ts).
// No live network: `transport` is an injected seam (real fetch-with-timeout
// in production, a fake here), matching every sibling *.core.mjs module in
// this directory (console_gated_approval.core.mjs, create_issue.core.mjs,
// fetch_pr_diff.core.mjs).
//
// ARC B REVIEW FIX WAVE (per-job session restructure): claim no longer binds
// a session — it only claims a job (`POST .../claim` body is now `{workerId}`
// alone). Binding moved to its OWN route, `POST .../bind`, called by the
// assembler AFTER a session is opened for an actual claimed job. See
// review_job_worker.core.mjs's own header comment for why the loop is
// reordered this way (idle polls now cost zero session/model turns).
//
// The claim route's 200 body is `{ job: {...} }` (a wrapper key) and its
// "nothing eligible" reply is a bare 204 — both verified against Task 4's
// own report (.superpowers/sdd/task-4-report.md), not assumed from this
// task's brief text alone. The bind route's success reply is `{ok:true}`
// (200); a job that isn't `running` is a 409; a genuine bind failure
// (already compensated server-side via release) is a 503 — both are
// non-2xx and this module's transport throws on either, uniformly, letting
// the worker core's `bind()` try/catch (never `complete()`-worthy — see the
// core's own header comment) handle the distinction by NOT re-deriving it
// here: this transport's job is only "did the call succeed", not "why not".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_PATH,
  BIND_PATH,
  COMPLETE_PATH,
  resolveConsoleConfig,
  buildClaimUrl,
  buildBindUrl,
  buildCompleteUrl,
  claimReviewJob,
  bindReviewJobSession,
  completeReviewJob,
} from "../agent/lib/review_job_console.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

/** Records every call; replies with whatever `respond` returns for that call. */
function fakeTransport(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildClaimUrl / buildBindUrl / buildCompleteUrl
// ---------------------------------------------------------------------------

test("resolveConsoleConfig: both vars present -> ok, trimmed, trailing slash stripped", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://console.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok-1  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://console.example.com", token: "tok-1" });
});

test("resolveConsoleConfig: both missing -> reports both", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

test("resolveConsoleConfig: only token missing -> reports just that one", () => {
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://x" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("buildClaimUrl / buildBindUrl / buildCompleteUrl join the trimmed base with the fixed runner paths", () => {
  assert.equal(CLAIM_PATH, "/api/v1/runner/review-jobs/claim");
  assert.equal(BIND_PATH, "/api/v1/runner/review-jobs/bind");
  assert.equal(COMPLETE_PATH, "/api/v1/runner/review-jobs/complete");
  assert.equal(buildClaimUrl("https://console.example.com"), "https://console.example.com/api/v1/runner/review-jobs/claim");
  assert.equal(buildBindUrl("https://console.example.com"), "https://console.example.com/api/v1/runner/review-jobs/bind");
  assert.equal(
    buildCompleteUrl("https://console.example.com"),
    "https://console.example.com/api/v1/runner/review-jobs/complete",
  );
});

// ---------------------------------------------------------------------------
// claimReviewJob — body is now {workerId} ONLY (no eveSessionId at claim time)
// ---------------------------------------------------------------------------

test("PIN: claimReviewJob POSTs {workerId} ONLY (no eveSessionId — claim no longer binds a session)", async () => {
  const transport = fakeTransport(() => jsonResponse(204, null));
  await claimReviewJob({ workerId: "review-worker-host-1", env: ENV, transport });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, "https://console.example.com/api/v1/runner/review-jobs/claim");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.deepEqual(JSON.parse(init.body), { workerId: "review-worker-host-1" });
});

test("PIN: claimReviewJob never sends eveSessionId, even if a caller mistakenly passes one", async () => {
  const transport = fakeTransport(() => jsonResponse(204, null));
  await claimReviewJob({ workerId: "w1", eveSessionId: "leak-me", env: ENV, transport });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.ok(!("eveSessionId" in body), "claimReviewJob must never forward eveSessionId onto the wire");
});

test("claimReviewJob: 204 -> null (nothing eligible)", async () => {
  const transport = fakeTransport(() => jsonResponse(204, null));
  const result = await claimReviewJob({ workerId: "w1", env: ENV, transport });
  assert.equal(result, null);
});

test("claimReviewJob: 200 with {job:{...}} -> returns the job UNWRAPPED (not the {job} envelope)", async () => {
  const job = { id: "job-1", repo: "ada/widgets", prNumber: 7, headSha: "abc123", event: "opened", workspaceId: "ws-1" };
  const transport = fakeTransport(() => jsonResponse(200, { job }));
  const result = await claimReviewJob({ workerId: "w1", env: ENV, transport });
  assert.deepEqual(result, job);
});

test("claimReviewJob: non-2xx (401) throws, mentioning the status", async () => {
  const transport = fakeTransport(() => jsonResponse(401, { error: "Unauthorized" }));
  await assert.rejects(
    () => claimReviewJob({ workerId: "w1", env: ENV, transport }),
    (err) => {
      assert.match(err.message, /401/);
      return true;
    },
  );
});

test("claimReviewJob: non-2xx (500) throws", async () => {
  const transport = fakeTransport(() => jsonResponse(500, { error: "boom" }));
  await assert.rejects(() => claimReviewJob({ workerId: "w1", env: ENV, transport }));
});

test("claimReviewJob: transport throwing (network error) propagates, never swallowed to null", async () => {
  const transport = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(() => claimReviewJob({ workerId: "w1", env: ENV, transport }), /ECONNREFUSED/);
});

test("claimReviewJob: missing console config throws WITHOUT ever calling transport", async () => {
  const transport = fakeTransport(() => jsonResponse(204, null));
  await assert.rejects(
    () => claimReviewJob({ workerId: "w1", env: {}, transport }),
    /JACE_CONSOLE_BASE_URL/,
  );
  assert.equal(transport.calls.length, 0, "must fail fast on missing config, before any network call");
});

// ---------------------------------------------------------------------------
// bindReviewJobSession — NEW (fix wave): binds a job to the session AFTER
// it's opened for an actual claimed job, separately from claim.
// ---------------------------------------------------------------------------

test("bindReviewJobSession: POSTs {jobId, eveSessionId} with a bearer header to the bind URL", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  const result = await bindReviewJobSession({ jobId: "job-1", eveSessionId: "sess-1", env: ENV, transport });

  assert.equal(result, undefined);
  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, "https://console.example.com/api/v1/runner/review-jobs/bind");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.deepEqual(JSON.parse(init.body), { jobId: "job-1", eveSessionId: "sess-1" });
});

test("bindReviewJobSession: non-2xx (409, job not in running) throws, mentioning the status", async () => {
  const transport = fakeTransport(() => jsonResponse(409, { error: "review job not running" }));
  await assert.rejects(
    () => bindReviewJobSession({ jobId: "job-1", eveSessionId: "sess-1", env: ENV, transport }),
    (err) => {
      assert.match(err.message, /409/);
      return true;
    },
  );
});

test("bindReviewJobSession: non-2xx (503, bind failed and was released server-side) throws, mentioning the status", async () => {
  const transport = fakeTransport(() => jsonResponse(503, { error: "failed to bind" }));
  await assert.rejects(
    () => bindReviewJobSession({ jobId: "job-1", eveSessionId: "sess-1", env: ENV, transport }),
    (err) => {
      assert.match(err.message, /503/);
      return true;
    },
  );
});

test("bindReviewJobSession: transport throwing (network error) propagates", async () => {
  const transport = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(
    () => bindReviewJobSession({ jobId: "job-1", eveSessionId: "sess-1", env: ENV, transport }),
    /ECONNRESET/,
  );
});

test("bindReviewJobSession: missing console config throws WITHOUT ever calling transport", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await assert.rejects(
    () => bindReviewJobSession({ jobId: "job-1", eveSessionId: "sess-1", env: {}, transport }),
    /JACE_CONSOLE_BASE_URL/,
  );
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// completeReviewJob — unchanged by the fix wave
// ---------------------------------------------------------------------------

test("completeReviewJob: POSTs to the complete URL with a bearer header and resolves on 200", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  const result = await completeReviewJob({
    jobId: "job-1",
    outcome: "posted",
    postedReviewUrl: "https://github.com/ada/widgets/pull/7#pullrequestreview-1",
    verdict: "approve",
    summaryLine: "ada/widgets#7: approve, no blockers",
    env: ENV,
    transport,
  });
  assert.equal(result, undefined);
  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, "https://console.example.com/api/v1/runner/review-jobs/complete");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.deepEqual(JSON.parse(init.body), {
    jobId: "job-1",
    outcome: "posted",
    postedReviewUrl: "https://github.com/ada/widgets/pull/7#pullrequestreview-1",
    verdict: "approve",
    summaryLine: "ada/widgets#7: approve, no blockers",
  });
});

test("completeReviewJob: forwards criterion results without adding any other caller fields", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  const criterionResults = [{
    criterionId: "AC-1",
    state: "not_proven",
    expected: "The saved value is visible.",
    observed: "No safe preview was available.",
    evidenceRefs: ["artifact://review/ac-1"],
  }];

  await completeReviewJob({
    jobId: "job-1",
    outcome: "posted",
    criterionResults,
    env: ENV,
    transport,
  });

  assert.deepEqual(JSON.parse(transport.calls[0].init.body), {
    jobId: "job-1",
    outcome: "posted",
    criterionResults,
  });
});

test("completeReviewJob: a minimal failed report omits every undefined optional field (only jobId+outcome+error sent)", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await completeReviewJob({ jobId: "job-2", outcome: "failed", error: "model blew up", env: ENV, transport });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(body, { jobId: "job-2", outcome: "failed", error: "model blew up" });
  assert.ok(!("postedReviewUrl" in body));
  assert.ok(!("verdict" in body));
  assert.ok(!("summaryLine" in body));
});

test("completeReviewJob: an explicit null postedReviewUrl is preserved, not omitted (distinct from undefined)", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await completeReviewJob({
    jobId: "job-3",
    outcome: "posted",
    postedReviewUrl: null,
    verdict: "approve",
    summaryLine: "line",
    env: ENV,
    transport,
  });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.equal(body.postedReviewUrl, null);
  assert.ok("postedReviewUrl" in body);
});

// B2a §1 Task 3 — evidenceKeys passthrough (spec
// docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md). Same
// undefined-omission convention as postedReviewUrl/verdict/summaryLine/
// error above: present -> forwarded onto the wire; absent -> the key is
// never added to the body at all (proven by the existing "omits every
// undefined optional field" test above, left untouched).
test("completeReviewJob: forwards evidenceKeys onto the wire when present", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await completeReviewJob({
    jobId: "job-8",
    outcome: "posted",
    verdict: "approve",
    summaryLine: "line",
    evidenceKeys: ["review-evidence/ws-1/ada__widgets/7/abc123/ac-1/1.png"],
    env: ENV,
    transport,
  });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(body, {
    jobId: "job-8",
    outcome: "posted",
    verdict: "approve",
    summaryLine: "line",
    evidenceKeys: ["review-evidence/ws-1/ada__widgets/7/abc123/ac-1/1.png"],
  });
});

test("completeReviewJob: a minimal failed report STILL omits evidenceKeys when absent (undefined, not even sent)", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await completeReviewJob({ jobId: "job-9", outcome: "failed", error: "model blew up", env: ENV, transport });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.ok(!("evidenceKeys" in body));
});

test("PIN: completeReviewJob NEVER sends eveSessionId, even if a caller mistakenly passes one", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await completeReviewJob({
    jobId: "job-4",
    outcome: "posted",
    verdict: "approve",
    summaryLine: "line",
    eveSessionId: "leak-me",
    env: ENV,
    transport,
  });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.ok(!("eveSessionId" in body), "completeReviewJob must never forward eveSessionId onto the wire");
});

test("completeReviewJob: non-2xx (409, guarded update matched nothing) throws, mentioning the status", async () => {
  const transport = fakeTransport(() => jsonResponse(409, { error: "not running" }));
  await assert.rejects(
    () => completeReviewJob({ jobId: "job-5", outcome: "posted", env: ENV, transport }),
    (err) => {
      assert.match(err.message, /409/);
      return true;
    },
  );
});

test("completeReviewJob: transport throwing (network error) propagates", async () => {
  const transport = async () => {
    throw new Error("ETIMEDOUT");
  };
  await assert.rejects(
    () => completeReviewJob({ jobId: "job-6", outcome: "failed", error: "x", env: ENV, transport }),
    /ETIMEDOUT/,
  );
});

test("completeReviewJob: missing console config throws WITHOUT ever calling transport", async () => {
  const transport = fakeTransport(() => jsonResponse(200, { ok: true }));
  await assert.rejects(
    () => completeReviewJob({ jobId: "job-7", outcome: "failed", error: "x", env: {}, transport }),
    /JACE_CONSOLE_BASE_URL/,
  );
  assert.equal(transport.calls.length, 0);
});
