import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECORD_JUDGMENT_PATH,
  buildRecordJudgmentUrl,
  buildJudgmentEventBody,
  classifyStatus,
  degraded,
  recordJudgment,
} from "../agent/lib/record_judgment.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};
const EVE_SESSION_ID = "eve-root-session";

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("buildRecordJudgmentUrl targets the runner judgment-events route", () => {
  assert.equal(
    buildRecordJudgmentUrl("https://console.example.com"),
    `https://console.example.com${RECORD_JUDGMENT_PATH}`,
  );
});

test("classifyStatus maps route responses, including 409 duplicate conflict", () => {
  assert.deepEqual(classifyStatus(201), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(409), { ok: false, reason: "conflict" });
  assert.deepEqual(classifyStatus(503), { ok: false, reason: "upstream_error" });
});

test("degraded clearly renders the non-recorded outcome", () => {
  const result = degraded("unreachable");
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.match(result.rendered, /^Judgment event not recorded:/);
});

test("buildJudgmentEventBody creates a bounded rejected_approach payload", () => {
  const built = buildJudgmentEventBody({
    eveSessionId: EVE_SESSION_ID,
    repo: " Bensigo/agentrail ",
    type: "rejected_approach",
    reason: "User rejected javascript:alert(1) queues",
    blockedTerms: [" Redis queue ", "redis queue", "", "polling loop"],
    briefSlug: "retry-brief",
  });

  assert.equal(built.ok, true);
  assert.equal(built.body.repo, "Bensigo/agentrail");
  assert.equal(built.body.type, "rejected_approach");
  assert.deepEqual(built.body.refs, { briefSlug: "retry-brief" });
  assert.deepEqual(built.body.payload.blockedTerms, ["Redis queue", "polling loop"]);
  assert.match(built.body.payload.reason, /javascript\[:\]alert\(1\)/);
  assert.match(built.body.eventKey, /^rejected_approach:[a-f0-9]{24}$/);
});

test("buildJudgmentEventBody refuses rejected_approach without blocked terms or reason", () => {
  assert.equal(
    buildJudgmentEventBody({
      eveSessionId: EVE_SESSION_ID,
      repo: "Bensigo/agentrail",
      type: "rejected_approach",
      reason: "no terms",
      blockedTerms: [],
    }).reason,
    "bad_request",
  );
  assert.equal(
    buildJudgmentEventBody({
      eveSessionId: EVE_SESSION_ID,
      repo: "Bensigo/agentrail",
      type: "rejected_approach",
      reason: "",
      blockedTerms: ["Redis"],
    }).reason,
    "bad_request",
  );
});

test("buildJudgmentEventBody creates a requirement_correction payload", () => {
  const built = buildJudgmentEventBody({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "The previous assumption was wrong.",
    correction: "Do not create the issue until alignment is confirmed.",
    itemId: "item-1",
  });

  assert.equal(built.ok, true);
  assert.equal(built.body.type, "requirement_correction");
  assert.deepEqual(built.body.refs, { itemId: "item-1" });
  assert.deepEqual(built.body.payload, {
    reason: "The previous assumption was wrong.",
    correction: "Do not create the issue until alignment is confirmed.",
  });
});

test("recordJudgment posts the hardened body to the console route", async () => {
  let seenBody;
  const transport = fakeTransport((_url, init) => {
    seenBody = JSON.parse(init.body);
    return { status: 201, json: async () => ({ ok: true, inserted: true, event: { id: "event-1" } }) };
  });

  const result = await recordJudgment({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "rejected_approach",
    reason: "Rejected during grilling.",
    blockedTerms: ["Redis"],
    env: ENV,
    transport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
  assert.equal(result.rendered, "Judgment event recorded: rejected_approach.");
  assert.equal(transport.calls[0].url, "https://console.example.com/api/v1/runner/judgment-events");
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(seenBody.eveSessionId, EVE_SESSION_ID);
  assert.equal(seenBody.type, "rejected_approach");
  assert.deepEqual(seenBody.payload, { blockedTerms: ["Redis"], reason: "Rejected during grilling." });
  assert.equal(seenBody.actorRef, undefined);
  assert.equal(seenBody.sourceRef, undefined);
});

test("recordJudgment returns degraded results instead of throwing on config, validation, or transport failure", async () => {
  const missingConfig = await recordJudgment({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "Corrected.",
    env: {},
    transport: fakeTransport(() => ({ status: 201, json: async () => ({ ok: true }) })),
  });
  assert.equal(missingConfig.reason, "config_missing");

  const badInput = await recordJudgment({
    eveSessionId: "",
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "Corrected.",
    env: ENV,
    transport: fakeTransport(() => ({ status: 201, json: async () => ({ ok: true }) })),
  });
  assert.equal(badInput.reason, "bad_request");

  const unreachable = await recordJudgment({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "Corrected.",
    env: ENV,
    transport: fakeTransport(() => {
      throw new Error("ECONNREFUSED with bearer tok-secret-123");
    }),
  });
  assert.equal(unreachable.reason, "unreachable");
  assert.doesNotMatch(JSON.stringify(unreachable), /tok-secret-123|ECONNREFUSED/);
});

test("recordJudgment renders duplicate conflicts as already recorded", async () => {
  const transport = fakeTransport(() => ({ status: 409, json: async () => ({ ok: false }) }));
  const result = await recordJudgment({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "Corrected.",
    env: ENV,
    transport,
  });

  assert.deepEqual(result, {
    ok: true,
    inserted: false,
    rendered: "Judgment event already recorded: requirement_correction.",
  });
});

test("recordJudgment treats malformed 2xx bodies as bad_body", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({ nope: true }) }));
  const result = await recordJudgment({
    eveSessionId: EVE_SESSION_ID,
    repo: "Bensigo/agentrail",
    type: "requirement_correction",
    reason: "Corrected.",
    env: ENV,
    transport,
  });

  assert.equal(result.reason, "bad_body");
});
