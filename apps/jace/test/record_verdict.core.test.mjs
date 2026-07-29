// Unit tests for the verdict-recording core (Jace's UNGATED-but-server-
// validated write path to POST /api/v1/runner/investigations/verdict). No
// SDK, no live network: BOTH the verdict POST and the fire-and-forget
// Langfuse score push are injected seams (`transport` / `fetchImpl`), so
// every branch is exercised deterministically.
//
// The three things this suite guards hardest:
//   1. 409 (the server's fail-closed refusal) renders
//      `Verdict refused — <blocking joined "; ">` and NEVER pushes a score.
//   2. 200 pushes EXACTLY ONE score, gated on isLangfuseConfigured, with a
//      STRING `metadata.investigation_id` (falling back to slug when the
//      response carries no id — the real wire contract today).
//   3. 422 (mechanismSummary looked credential-shaped) degrades as
//      `content_rejected`, same as save_investigation's own secret-scan path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECORD_VERDICT_PATH,
  INVESTIGATION_VERDICTS,
  VERDICT_CONFIDENCES,
  resolveConsoleConfig,
  buildRecordVerdictUrl,
  classifyStatus,
  degraded,
  refused,
  renderVerdictSuccess,
  pushVerdictScore,
  recordVerdict,
} from "../agent/lib/record_verdict.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};
const LANGFUSE_ENV = {
  ...ENV,
  LANGFUSE_BASE_URL: "https://langfuse.example.com",
  LANGFUSE_PUBLIC_KEY: "pk-123",
  LANGFUSE_SECRET_KEY: "sk-456",
};
const EVE_SESSION_ID = "eve-session-abc";

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

// A fake fetchImpl for the Langfuse score push — mirrors the shape a real
// `fetch` returns (a Response-like object with `.ok`/`.status`), matching
// agent/hooks/langfuse-verdict-score.ts's own `pushScore` transport, NOT the
// { status, json() } shape the main verdict `transport` uses.
function fakeFetchImpl(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function okVerdictResponse(body = { ok: true }) {
  return { status: 200, json: async () => body };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("INVESTIGATION_VERDICTS / VERDICT_CONFIDENCES match the console route's contract", () => {
  assert.deepEqual(INVESTIGATION_VERDICTS, ["root_caused", "undetermined"]);
  assert.deepEqual(VERDICT_CONFIDENCES, ["confirmed", "probable", "circumstantial"]);
});

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("resolveConsoleConfig reports exactly which vars are missing", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

test("buildRecordVerdictUrl carries nothing in the URL — everything rides in the POST body", () => {
  assert.equal(buildRecordVerdictUrl("https://c.example.com"), `https://c.example.com${RECORD_VERDICT_PATH}`);
});

// ---------------------------------------------------------------------------
// classifyStatus / degraded / refused
// ---------------------------------------------------------------------------

test("classifyStatus maps HTTP status to outcome, including 409 -> refused and 422 -> content_rejected", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(409), { ok: false, reason: "refused" });
  assert.deepEqual(classifyStatus(422), { ok: false, reason: "content_rejected" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note", () => {
  const d = degraded("unreachable");
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.ok(d.note.length > 0);
});

test("refused renders the pinned 'Verdict refused — <blocking joined>' line and carries ok:false, refused:true", () => {
  const r = refused(["no supported hypothesis with mechanism and evidence", "confidence required for root_caused verdict"]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.deepEqual(r.blocking, [
    "no supported hypothesis with mechanism and evidence",
    "confidence required for root_caused verdict",
  ]);
  assert.equal(
    r.rendered,
    "Verdict refused — no supported hypothesis with mechanism and evidence; confidence required for root_caused verdict",
  );
});

test("refused hardens each blocking reason defensively", () => {
  const r = refused(["see javascript:alert(1) ​here"]);
  assert.match(r.rendered, /javascript\[:\]alert\(1\)/);
  assert.doesNotMatch(r.rendered, /​/);
});

test("refused tolerates a non-array/missing blocking value", () => {
  assert.deepEqual(refused(undefined).blocking, []);
  assert.equal(refused(undefined).rendered, "Verdict refused — ");
});

test("renderVerdictSuccess names the verdict and the slug", () => {
  assert.match(renderVerdictSuccess({ verdict: "root_caused", slug: "checkout-500s" }), /root_caused/);
  assert.match(renderVerdictSuccess({ verdict: "root_caused", slug: "checkout-500s" }), /checkout-500s/);
});

// ---------------------------------------------------------------------------
// pushVerdictScore — copied transport + single-console.warn failure funnel
// (mirrors agent/hooks/langfuse-verdict-score.ts's own pushScore)
// ---------------------------------------------------------------------------

test("pushVerdictScore POSTs to {baseUrl}/api/public/scores with Basic auth of publicKey:secretKey", async () => {
  let seenUrl, seenInit;
  const fetchImpl = fakeFetchImpl((url, init) => {
    seenUrl = url;
    seenInit = init;
    return { ok: true, status: 200 };
  });
  await pushVerdictScore({
    baseUrl: "https://langfuse.example.com/",
    publicKey: "pk-123",
    secretKey: "sk-456",
    fetchImpl,
    body: { sessionId: "s1", name: "investigation_verdict" },
  });
  assert.equal(seenUrl, "https://langfuse.example.com/api/public/scores");
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.Authorization, `Basic ${Buffer.from("pk-123:sk-456").toString("base64")}`);
  assert.deepEqual(JSON.parse(seenInit.body), { sessionId: "s1", name: "investigation_verdict" });
});

test("pushVerdictScore attaches a bounded AbortSignal timeout — an unbounded background request must never accumulate", async () => {
  let seenInit;
  const fetchImpl = fakeFetchImpl((_url, init) => {
    seenInit = init;
    return { ok: true, status: 200 };
  });
  await pushVerdictScore({ baseUrl: "https://langfuse.example.com", publicKey: "pk", secretKey: "sk", fetchImpl, body: {} });
  assert.ok(seenInit.signal instanceof AbortSignal, "the request must carry an AbortSignal");
});

test("pushVerdictScore never rejects and funnels a non-ok response into a single console.warn", async () => {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);
  try {
    const fetchImpl = fakeFetchImpl(() => ({ ok: false, status: 500 }));
    await pushVerdictScore({ baseUrl: "https://langfuse.example.com", publicKey: "pk", secretKey: "sk", fetchImpl, body: {} });
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /\[record_verdict\]|failed to push score/i);
  } finally {
    console.warn = originalWarn;
  }
});

test("pushVerdictScore never rejects and funnels a thrown transport error into a single console.warn", async () => {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);
  try {
    const fetchImpl = fakeFetchImpl(() => {
      throw new Error("ECONNREFUSED");
    });
    await assert.doesNotReject(
      pushVerdictScore({ baseUrl: "https://langfuse.example.com", publicKey: "pk", secretKey: "sk", fetchImpl, body: {} }),
    );
    assert.equal(warnCalls.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// recordVerdict — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("recordVerdict: unset console config -> degraded('config_missing'), transport never called", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const res = await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "undetermined",
    missingEvidence: ["metrics"],
    env: {},
    transport,
  });
  assert.equal(res.reason, "config_missing");
  assert.equal(transport.calls.length, 0);
});

test("recordVerdict: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  for (const badId of [undefined, "", "   "]) {
    const res = await recordVerdict({ eveSessionId: badId, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("recordVerdict: blank slug -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  for (const badSlug of [undefined, "", "   "]) {
    const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: badSlug, verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("recordVerdict: invalid verdict enum -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "definitely_the_db", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// recordVerdict — request shape
// ---------------------------------------------------------------------------

test("recordVerdict: POST body carries eveSessionId/slug/verdict, and only supplied optionals", async () => {
  let seenInit = null;
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return okVerdictResponse();
  });
  await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["metrics"], env: ENV, transport });
  const sentBody = JSON.parse(seenInit.body);
  assert.deepEqual(sentBody, {
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "undetermined",
    missingEvidence: ["metrics"],
  });
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
});

test("recordVerdict: mechanismSummary is hardened before it ever leaves this module", async () => {
  let seenInit = null;
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return okVerdictResponse();
  });
  await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "root_caused",
    confidence: "probable",
    mechanismSummary: "see javascript:alert(1) ​here",
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(seenInit.body);
  assert.match(sentBody.mechanismSummary, /javascript\[:\]alert\(1\)/);
});

// ---------------------------------------------------------------------------
// recordVerdict — transport outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("recordVerdict: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("recordVerdict: 400 relays the console's own error message", async () => {
  const transport = fakeTransport(() => ({ status: 400, json: async () => ({ error: "confidence must be one of confirmed, probable, circumstantial" }) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "root_caused", confidence: "bad-value", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(res.message, "confidence must be one of confirmed, probable, circumstantial");
});

test("recordVerdict: 401/403 -> degraded('unauthorized')", async () => {
  const transport = fakeTransport(() => ({ status: 401, json: async () => ({}) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.reason, "unauthorized");
});

test("recordVerdict: 404 -> degraded('not_found') (no investigation at that slug)", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Investigation checkout-500s not found" }) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("recordVerdict: 500 -> degraded('upstream_error')", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
});

test("recordVerdict: non-JSON body on 200 -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => { throw new SyntaxError("nope"); } }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("recordVerdict: a 200 body without ok:true is treated as bad_body, never assumed successful", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ nope: true }) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("recordVerdict: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

// ---------------------------------------------------------------------------
// recordVerdict — 409: refused, blocking rendered, NO score pushed
// ---------------------------------------------------------------------------

test("recordVerdict: 409 renders 'Verdict refused — <blocking>' and returns ok:false/refused:true", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ ok: false, blocking: ["no supported hypothesis with mechanism and evidence"] }),
  }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "root_caused", confidence: "probable", env: ENV, transport });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.deepEqual(res.blocking, ["no supported hypothesis with mechanism and evidence"]);
  assert.equal(res.rendered, "Verdict refused — no supported hypothesis with mechanism and evidence");
});

test("recordVerdict: 409 does NOT push a Langfuse score, even when Langfuse is configured", async () => {
  const transport = fakeTransport(() => ({ status: 409, json: async () => ({ ok: false, blocking: ["x"] }) }));
  const fetchImpl = fakeFetchImpl(() => ({ ok: true, status: 200 }));
  await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "root_caused",
    confidence: "probable",
    env: LANGFUSE_ENV,
    transport,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 0, "no score push on a 409 refusal");
});

test("recordVerdict: 409 with a non-JSON/malformed body still refuses cleanly with an empty blocking array", async () => {
  const transport = fakeTransport(() => ({ status: 409, json: async () => { throw new SyntaxError("nope"); } }));
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "root_caused", confidence: "probable", env: ENV, transport });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.deepEqual(res.blocking, []);
});

// ---------------------------------------------------------------------------
// recordVerdict — 422: content_rejected, same as save_investigation's secret scan
// ---------------------------------------------------------------------------

test("recordVerdict: 422 (mechanismSummary secret scan) -> degraded('content_rejected')", async () => {
  const transport = fakeTransport(() => ({
    status: 422,
    json: async () => ({
      error: "Investigation content rejected: credential-shaped value detected",
      reason: "blocked 1 secret-shaped value(s): aws_access_key_id",
    }),
  }));
  const res = await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "root_caused",
    confidence: "confirmed",
    mechanismSummary: "the key is AKIA...",
    env: ENV,
    transport,
  });
  assert.equal(res.reason, "content_rejected");
  assert.equal(res.message, "Investigation content rejected: credential-shaped value detected");
  assert.equal(res.detail, "blocked 1 secret-shaped value(s): aws_access_key_id");
});

test("recordVerdict: 422 does NOT push a score", async () => {
  const transport = fakeTransport(() => ({ status: 422, json: async () => ({ error: "rejected" }) }));
  const fetchImpl = fakeFetchImpl(() => ({ ok: true, status: 200 }));
  await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "root_caused",
    confidence: "confirmed",
    mechanismSummary: "x",
    env: LANGFUSE_ENV,
    transport,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// recordVerdict — 200: success, score pushed exactly once with a STRING id
// ---------------------------------------------------------------------------

test("recordVerdict: 200 returns ok:true with a rendered success summary", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const res = await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["metrics"], env: ENV, transport });
  assert.equal(res.ok, true);
  assert.match(res.rendered, /undetermined/);
  assert.match(res.rendered, /checkout-500s/);
});

test("recordVerdict: 200 pushes NO score when Langfuse is not configured", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const fetchImpl = fakeFetchImpl(() => ({ ok: true, status: 200 }));
  await recordVerdict({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", verdict: "undetermined", missingEvidence: ["x"], env: ENV, transport, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("recordVerdict: 200 pushes EXACTLY ONE score when Langfuse is configured, with STRING investigation_id falling back to slug", async () => {
  const transport = fakeTransport(() => okVerdictResponse({ ok: true }));
  const fetchImpl = fakeFetchImpl(() => ({ ok: true, status: 200 }));
  await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "root_caused",
    confidence: "confirmed",
    env: LANGFUSE_ENV,
    transport,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1, "score pushed exactly once");
  const sentBody = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sentBody.name, "investigation_verdict");
  assert.equal(sentBody.value, "root_caused");
  assert.equal(sentBody.dataType, "CATEGORICAL");
  assert.equal(sentBody.sessionId, EVE_SESSION_ID, "sessionId is the root session id — the same eveSessionId this tool resolved");
  assert.equal(typeof sentBody.metadata.investigation_id, "string");
  assert.equal(sentBody.metadata.investigation_id, "checkout-500s", "falls back to slug — the real verdict route's 200 body is just { ok: true }, no id");
  assert.equal(sentBody.metadata.slug, "checkout-500s");
});

test("recordVerdict: 200 prefers a response-carried id over the slug, still coerced to a STRING", async () => {
  const transport = fakeTransport(() => okVerdictResponse({ ok: true, investigationId: 4077 }));
  const fetchImpl = fakeFetchImpl(() => ({ ok: true, status: 200 }));
  await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "undetermined",
    missingEvidence: ["x"],
    env: LANGFUSE_ENV,
    transport,
    fetchImpl,
  });
  const sentBody = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sentBody.metadata.investigation_id, "4077");
  assert.equal(typeof sentBody.metadata.investigation_id, "string");
});

test("recordVerdict: a score-push failure never surfaces — the tool result is still ok:true", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const fetchImpl = fakeFetchImpl(() => {
    throw new Error("Langfuse is down");
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const res = await recordVerdict({
      eveSessionId: EVE_SESSION_ID,
      slug: "checkout-500s",
      verdict: "undetermined",
      missingEvidence: ["x"],
      env: LANGFUSE_ENV,
      transport,
      fetchImpl,
    });
    assert.equal(res.ok, true);
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// recordVerdict — the score push is genuinely fire-and-forget: the tool
// result must never wait on it (review round 1, FIX 1)
// ---------------------------------------------------------------------------

test("recordVerdict: on 200, resolves WITHOUT waiting for a slow score push — but the push is still issued", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  const PUSH_DELAY_MS = 400;
  let resolvePush;
  const pushGate = new Promise((resolve) => {
    resolvePush = resolve;
  });
  const fetchImpl = fakeFetchImpl(async () => {
    await new Promise((r) => setTimeout(r, PUSH_DELAY_MS));
    resolvePush();
    return { ok: true, status: 200 };
  });

  const start = Date.now();
  const res = await recordVerdict({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    verdict: "undetermined",
    missingEvidence: ["x"],
    env: LANGFUSE_ENV,
    transport,
    fetchImpl,
  });
  const elapsed = Date.now() - start;

  assert.equal(res.ok, true);
  assert.ok(
    elapsed < PUSH_DELAY_MS / 2,
    `recordVerdict must resolve immediately, not wait on the ${PUSH_DELAY_MS}ms score push; took ${elapsed}ms`,
  );
  assert.equal(fetchImpl.calls.length, 1, "the score request must still be issued synchronously, not skipped");

  // Let the background push actually settle before the test ends, so it
  // can't leak a dangling timer/assertion into a later test.
  await pushGate;
});

test("recordVerdict: a score push that later REJECTS never affects the already-returned result (no unhandled rejection)", async () => {
  const transport = fakeTransport(() => okVerdictResponse());
  let rejectPush;
  const pushSettled = new Promise((resolve) => {
    rejectPush = resolve;
  });
  const fetchImpl = fakeFetchImpl(async () => {
    await new Promise((r) => setTimeout(r, 30));
    rejectPush();
    throw new Error("Langfuse is down");
  });
  const originalWarn = console.warn;
  let warnCalls = 0;
  console.warn = () => {
    warnCalls++;
  };
  try {
    const res = await recordVerdict({
      eveSessionId: EVE_SESSION_ID,
      slug: "checkout-500s",
      verdict: "undetermined",
      missingEvidence: ["x"],
      env: LANGFUSE_ENV,
      transport,
      fetchImpl,
    });
    assert.equal(res.ok, true, "the result is already returned before the push even rejects");
    assert.equal(res.rendered, "Verdict recorded: undetermined for investigation \"checkout-500s\".");

    // Wait for the background push to actually settle, proving the
    // rejection was swallowed into console.warn (not an unhandled
    // rejection) rather than merely "not yet observed".
    await pushSettled;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(warnCalls, 1, "the swallowed failure still funnels into exactly one console.warn eventually");
  } finally {
    console.warn = originalWarn;
  }
});
