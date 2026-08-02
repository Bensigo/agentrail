// Unit tests for the qa subagent's upload_evidence_image core (B2a §2,
// design: docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md).
// No SDK, no live network: the single HTTP call is an injected `transport`
// seam (real fetch with a timeout in the thin tool wrapper, a fake here), so
// every branch — success and every failure — is unit-testable without a live
// console. Mirrors post_pr_review.core.mjs's structure (duplicated
// resolveConsoleConfig, classifyStatus, single-attempt fetch, relay the
// console's own {error} text when present, generic per-reason fallback
// otherwise) for the console's POST /api/v1/runner/review-evidence route
// (apps/console/app/api/v1/runner/review-evidence/route.ts, Task 2).
//
// Contract (deliberately flatter than the GET context tools' {ok, degraded,
// reason, note} shape): success -> exactly { url, key }; anything else ->
// exactly { error: string } — never throws. The QA model relays `error`
// verbatim in its own prose (an ac_result's `evidence`, or a finding), so
// each message must read as a complete, honest sentence on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_EVIDENCE_PATH,
  resolveConsoleConfig,
  buildReviewEvidenceUrl,
  classifyStatus,
  failure,
  runUploadEvidenceImage,
} from "../agent/subagents/qa/lib/upload_evidence_image.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

const VALID_ARGS = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "abc123def456",
  acId: "AC1",
  index: 1,
  imageBase64: "aGVsbG8gd29ybGQ=",
  contentType: "image/png",
};

// A fake transport that records how many times it was called and with what,
// so we can assert single-attempt (no-retry) behaviour and request shape.
function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function okTransport(body = { key: "review-evidence/ws-1/ada/widgets/98/abc123def456/AC1/1.png", url: "https://signed.example.com/1.png" }) {
  return fakeTransport(() => ({ status: 200, json: async () => body }));
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildReviewEvidenceUrl / classifyStatus / failure
// ---------------------------------------------------------------------------

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
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://c" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("buildReviewEvidenceUrl joins the base url and the review-evidence path; PATH is the console's own route", () => {
  assert.equal(REVIEW_EVIDENCE_PATH, "/api/v1/runner/review-evidence");
  assert.equal(
    buildReviewEvidenceUrl("https://c.example.com"),
    `https://c.example.com${REVIEW_EVIDENCE_PATH}`,
  );
});

test("classifyStatus maps the review-evidence route's full status table", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(201), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(409), { ok: false, reason: "conflict" });
  assert.deepEqual(classifyStatus(413), { ok: false, reason: "too_large" });
  assert.deepEqual(classifyStatus(415), { ok: false, reason: "unsupported_content_type" });
  assert.deepEqual(classifyStatus(422), { ok: false, reason: "out_of_range" });
  assert.deepEqual(classifyStatus(429), { ok: false, reason: "rate_limited" });
  assert.deepEqual(classifyStatus(503), { ok: false, reason: "disabled" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("failure() returns exactly { error }, falling back to a generic per-reason message for an unknown reason", () => {
  const f = failure("not_found");
  assert.deepEqual(Object.keys(f), ["error"]);
  assert.equal(typeof f.error, "string");
  assert.ok(f.error.length > 0);

  const withOverride = failure("not_found", "custom console message");
  assert.deepEqual(withOverride, { error: "custom console message" });

  const unknown = failure("who_knows");
  assert.equal(typeof unknown.error, "string");
  assert.ok(unknown.error.length > 0);
});

test("failure() ignores a blank/whitespace console message and falls back to the generic one", () => {
  const blank = failure("bad_request", "   ");
  const generic = failure("bad_request");
  assert.deepEqual(blank, generic);
});

// ---------------------------------------------------------------------------
// runUploadEvidenceImage — config_missing, before any transport call.
// ---------------------------------------------------------------------------

test("config_missing when the console isn't configured — before any transport call, never throws", async () => {
  const transport = okTransport();
  const res = await runUploadEvidenceImage({ env: {}, ...VALID_ARGS, transport });
  assert.equal(typeof res.error, "string");
  assert.match(res.error, /isn't configured/i);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// bad_request guards — blank/invalid required fields, before any transport call.
// ---------------------------------------------------------------------------

test("bad_request when a required string field is blank — before any transport call", async () => {
  for (const field of ["eveSessionId", "repo", "headSha", "acId", "contentType", "imageBase64"]) {
    for (const blank of ["", "   "]) {
      const transport = okTransport();
      const args = { ...VALID_ARGS, [field]: blank };
      const res = await runUploadEvidenceImage({ env: ENV, ...args, transport });
      assert.equal(typeof res.error, "string", `blank ${field}=${JSON.stringify(blank)}`);
      assert.equal(transport.calls.length, 0, `blank ${field}=${JSON.stringify(blank)} must not call transport`);
    }
  }
});

test("bad_request when prNumber is not a positive integer — before any transport call", async () => {
  for (const prNumber of [0, -1, 1.5, NaN, undefined, null]) {
    const transport = okTransport();
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, prNumber, transport });
    assert.equal(typeof res.error, "string", `prNumber=${JSON.stringify(prNumber)}`);
    assert.equal(transport.calls.length, 0, `prNumber=${JSON.stringify(prNumber)} must not call transport`);
  }
});

test("prNumber tolerates numeric-string coercion, same leniency as post_pr_review.core.mjs's own Number(prNumber) precedent", async () => {
  const transport = okTransport();
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, prNumber: "98", transport });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(res, {
    url: "https://signed.example.com/1.png",
    key: "review-evidence/ws-1/ada/widgets/98/abc123def456/AC1/1.png",
  });
  assert.equal(JSON.parse(transport.calls[0].init.body).prNumber, 98);
});

test("bad_request when index is missing, null, or not a finite number — before any transport call", async () => {
  for (const index of [undefined, null, NaN, {}]) {
    const transport = okTransport();
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, index, transport });
    assert.equal(typeof res.error, "string", `index=${JSON.stringify(index)}`);
    assert.equal(transport.calls.length, 0, `index=${JSON.stringify(index)} must not call transport`);
  }
});

test("index is NOT range-checked client-side — 1..4 stays the console's own business rule (relayed, not duplicated)", async () => {
  // 0, 5, and 2.5 are all "finite numbers" so they pass this core's own
  // presence/type guard and reach the transport; the console's 422 (relayed
  // via the non-2xx path, tested below) is what actually enforces 1..4.
  for (const index of [0, 5, 2.5]) {
    const transport = okTransport();
    await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, index, transport });
    assert.equal(transport.calls.length, 1, `index=${index} should reach the transport`);
  }
});

// ---------------------------------------------------------------------------
// Request shape — URL, method, headers, exact JSON body.
// ---------------------------------------------------------------------------

test("POSTs to the review-evidence endpoint with the Bearer token and the exact body shape", async () => {
  const transport = okTransport();
  await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, `${ENV.JACE_CONSOLE_BASE_URL}${REVIEW_EVIDENCE_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${ENV.JACE_CONSOLE_TOKEN}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers.Accept, "application/json");

  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    eveSessionId: VALID_ARGS.eveSessionId,
    repo: VALID_ARGS.repo,
    prNumber: VALID_ARGS.prNumber,
    headSha: VALID_ARGS.headSha,
    acId: VALID_ARGS.acId,
    index: VALID_ARGS.index,
    imageBase64: VALID_ARGS.imageBase64,
    contentType: VALID_ARGS.contentType,
  });
});

test("trims string fields before sending", async () => {
  const transport = okTransport();
  await runUploadEvidenceImage({
    env: ENV,
    ...VALID_ARGS,
    eveSessionId: "  eve-session-1  ",
    repo: "  ada/widgets  ",
    headSha: "  abc123def456  ",
    acId: "  AC1  ",
    contentType: "  image/png  ",
    transport,
  });
  const body = JSON.parse(transport.calls[0].init.body);
  assert.equal(body.eveSessionId, "eve-session-1");
  assert.equal(body.repo, "ada/widgets");
  assert.equal(body.headSha, "abc123def456");
  assert.equal(body.acId, "AC1");
  assert.equal(body.contentType, "image/png");
});

// ---------------------------------------------------------------------------
// transport throws -> unreachable, single attempt, no leaked error text.
// ---------------------------------------------------------------------------

test("unreachable when the transport throws — one attempt, no retry, no leaked text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
  assert.equal(typeof res.error, "string");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

// ---------------------------------------------------------------------------
// non-2xx — relays the console's own {error} text when present.
// ---------------------------------------------------------------------------

test("relays the console's own error message verbatim on a non-2xx response", async () => {
  const transport = fakeTransport(() => ({
    status: 413,
    json: async () => ({ error: "image exceeds the 2MB size cap" }),
  }));
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
  assert.deepEqual(res, { error: "image exceeds the 2MB size cap" });
});

test("falls back to a generic per-reason message when the non-2xx body carries no usable error text", async () => {
  for (const body of [{}, { error: "" }, { error: "   " }, { error: 42 }, null]) {
    const transport = fakeTransport(() => ({ status: 404, json: async () => body }));
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
    assert.equal(typeof res.error, "string", `body=${JSON.stringify(body)}`);
    assert.ok(res.error.length > 0, `body=${JSON.stringify(body)}`);
    assert.notEqual(res.error, "", `body=${JSON.stringify(body)}`);
  }
});

test("falls back to the classified reason's generic message when the non-2xx body fails to parse as JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 500,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
  assert.deepEqual(res, failure("upstream_error"));
});

test("every spot-checked non-2xx status degrades to a structured {error}, never leaking the bearer token", async () => {
  const spotChecks = [400, 401, 403, 404, 409, 413, 415, 422, 429, 503, 500, 418];
  for (const status of spotChecks) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
    assert.deepEqual(Object.keys(res), ["error"], `status ${status}`);
    assert.equal(typeof res.error, "string", `status ${status}`);
    assert.equal(transport.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
  }
});

// ---------------------------------------------------------------------------
// success — exactly { url, key }; malformed/absent 2xx body -> bad_body.
// ---------------------------------------------------------------------------

test("200 with a well-formed body returns exactly { url, key } — nothing else rides along", async () => {
  const transport = okTransport({
    key: "review-evidence/ws-1/ada/widgets/98/abc123def456/AC1/1.png",
    url: "https://signed.example.com/1.png",
    extra: "must not leak through",
  });
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
  assert.deepEqual(res, {
    url: "https://signed.example.com/1.png",
    key: "review-evidence/ws-1/ada/widgets/98/abc123def456/AC1/1.png",
  });
});

test("bad_body when the 2xx response body fails to parse as JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  }));
  const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
  assert.deepEqual(res, failure("bad_body"));
});

test("bad_body when the 2xx response body is null or not an object", async () => {
  for (const body of [null, "a string", 42, []]) {
    const transport = fakeTransport(() => ({ status: 200, json: async () => body }));
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
    assert.deepEqual(res, failure("bad_body"), `body=${JSON.stringify(body)}`);
  }
});

test("bad_body when the 2xx response body is missing or blank url/key", async () => {
  for (const body of [
    {},
    { key: "k" },
    { url: "u" },
    { key: "", url: "u" },
    { key: "k", url: "" },
    { key: 1, url: "u" },
    { key: "k", url: 1 },
  ]) {
    const transport = fakeTransport(() => ({ status: 200, json: async () => body }));
    const res = await runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, transport });
    assert.deepEqual(res, failure("bad_body"), `body=${JSON.stringify(body)}`);
  }
});

// ---------------------------------------------------------------------------
// Never throws — the turn must survive every failure mode.
// ---------------------------------------------------------------------------

test("never throws across every failure mode exercised above", async () => {
  const scenarios = [
    () => runUploadEvidenceImage({ env: {}, ...VALID_ARGS, transport: okTransport() }),
    () => runUploadEvidenceImage({ env: ENV, ...VALID_ARGS, eveSessionId: "", transport: okTransport() }),
    () =>
      runUploadEvidenceImage({
        env: ENV,
        ...VALID_ARGS,
        transport: fakeTransport(() => {
          throw new Error("boom");
        }),
      }),
    () =>
      runUploadEvidenceImage({
        env: ENV,
        ...VALID_ARGS,
        transport: fakeTransport(() => ({
          status: 500,
          json: async () => {
            throw new Error("boom");
          },
        })),
      }),
  ];
  for (const run of scenarios) {
    await assert.doesNotReject(run);
  }
});
