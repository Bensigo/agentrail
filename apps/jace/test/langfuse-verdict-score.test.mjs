// Unit tests for Jace's Langfuse verdict → score hook (Task 10).
//
// `agent/hooks/langfuse-verdict-score.ts` is a thin `defineHook` wrapper. All
// decision logic this test exercises lives in its exported pure functions
// (`handleActionResult`, `verdictValueFor`, `pushScore`), which take an
// injected `env` and `fetchImpl` — exactly the same "injected dependency, no
// module mocking" convention `fetch_run_evidence.core.mjs` uses for its
// `transport` seam. This repo's `node --test test/*.test.mjs` script runs
// without `--experimental-test-module-mocks`, so there is no way to
// intercept the real global `fetch`; the injected seam is the only way to
// test the network call deterministically.
//
// PIN (fact a, verified 2026-07-13 against
// https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk and
// the POST /api/public/scores reference at https://api.reference.langfuse.com):
// the Scores API accepts a `sessionId` field (session-scoped scores) as an
// alternative to `traceId` — this hook uses ONLY `sessionId`, never
// `traceId` (the OTel trace id is not visible to hooks).
//
// PIN (facts b/c): a completed declared-subagent result lands on ROOT's own
// `action.result` stream event (not `message.completed`) as
// `event.data.result` with `kind: "subagent-result"`, carrying `.output`
// (the parsed structured verdict) and `.subagentName` ("triage" | "qa" — a
// subagent's name is its directory name). Verified against
// node_modules/eve/dist/src/protocol/message.d.ts and
// node_modules/eve/dist/src/runtime/actions/types.d.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleActionResult,
  verdictValueFor,
  pushScore,
  __resetScoredForTests,
} from "../agent/hooks/langfuse-verdict-score.ts";
import { beforeEach } from "node:test";

beforeEach(() => __resetScoredForTests());

const FAKE_ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-fake",
  LANGFUSE_SECRET_KEY: "sk-fake",
  LANGFUSE_BASE_URL: "https://fake.langfuse.example.com",
};

const FAKE_CTX = { session: { id: "sess_root_123" } };

// A fake fetch that records every call and resolves with a canned response.
function fakeFetch(responder = () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function triageActionResultEvent(output, overrides = {}) {
  return {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: {
        kind: "subagent-result",
        callId: "call_triage_1",
        subagentName: "triage",
        output,
      },
      ...overrides,
    },
  };
}

function qaActionResultEvent(output, overrides = {}) {
  return {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: {
        kind: "subagent-result",
        callId: "call_qa_1",
        subagentName: "qa",
        output,
      },
      ...overrides,
    },
  };
}

const TRIAGE_OUTPUT_BLOCKED = {
  diagnosis: "The verify gate rejected the diff.",
  what_was_tried: ["ran tests", "ran verify"],
  blocking_reason: "verify-gate: prose reject",
  suggested_next_action: "Fix the flagged prose and re-run verify.",
  evidence_refs: ["review_gates"],
};

const TRIAGE_OUTPUT_UNBLOCKED = {
  diagnosis: "Transient network error during clone.",
  what_was_tried: ["clone", "retry"],
  blocking_reason: "",
  suggested_next_action: "Retry the run.",
  evidence_refs: ["timeline"],
};

const QA_OUTPUT_ISSUES = {
  verdict: "issues_found",
  summary: "Settings save is broken.",
  tested: [{ surface: "ui", target: "/settings", result: "500 on save" }],
  findings: [],
  not_verifiable_reason: null,
  evidence_refs: ["network: POST /api/settings -> 500"],
};

// ---------------------------------------------------------------------------
// verdictValueFor — pure mapping
// ---------------------------------------------------------------------------

test("verdictValueFor: qa uses the literal verdict enum value", () => {
  assert.deepEqual(verdictValueFor("qa", QA_OUTPUT_ISSUES), {
    value: "issues_found",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: triage maps a non-empty blocking_reason to 'blocked'", () => {
  assert.deepEqual(verdictValueFor("triage", TRIAGE_OUTPUT_BLOCKED), {
    value: "blocked",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: triage maps an empty blocking_reason to 'unblocked'", () => {
  assert.deepEqual(verdictValueFor("triage", TRIAGE_OUTPUT_UNBLOCKED), {
    value: "unblocked",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: unknown subagent name returns undefined", () => {
  assert.equal(verdictValueFor("researcher", {}), undefined);
});

// ---------------------------------------------------------------------------
// handleActionResult — the hook's real decision surface
// ---------------------------------------------------------------------------

test("triage result event -> exactly one fetch to /api/public/scores with the session id and verdict", async () => {
  const fetchImpl = fakeFetch();
  await handleActionResult(triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED), FAKE_CTX, {
    env: FAKE_ENV,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://fake.langfuse.example.com/api/public/scores");
  assert.equal(init.method, "POST");
  assert.match(init.headers.Authorization, /^Basic /);
  const body = JSON.parse(init.body);
  assert.equal(body.sessionId, "sess_root_123");
  assert.equal(body.name, "triage_verdict");
  assert.equal(body.value, "blocked");
  assert.equal(body.dataType, "CATEGORICAL");
  assert.equal(body.metadata.subagentName, "triage");
  // NOT traceId — session-scoped only (PIN fact a).
  assert.equal("traceId" in body, false);
});

test("qa result event -> exactly one fetch carrying qa_verdict + the literal verdict value", async () => {
  const fetchImpl = fakeFetch();
  await handleActionResult(qaActionResultEvent(QA_OUTPUT_ISSUES), FAKE_CTX, {
    env: FAKE_ENV,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.name, "qa_verdict");
  assert.equal(body.value, "issues_found");
  assert.equal(body.metadata.subagentName, "qa");
});

test("non-subagent action.result events (authored tool-result) -> zero calls", async () => {
  const fetchImpl = fakeFetch();
  const event = {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: { kind: "tool-result", callId: "call_1", toolName: "fetch_run_evidence", output: {} },
    },
  };
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("a non-triage/qa subagent (e.g. researcher) -> zero calls", async () => {
  const fetchImpl = fakeFetch();
  const event = {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: { kind: "subagent-result", callId: "call_1", subagentName: "researcher", output: {} },
    },
  };
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("an errored subagent result (isError: true) -> zero calls", async () => {
  const fetchImpl = fakeFetch();
  const event = triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED);
  event.data.result.isError = true;
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("a failed/rejected subagent call (status !== completed) -> zero calls", async () => {
  const fetchImpl = fakeFetch();
  const event = triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED, { status: "failed" });
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("no LANGFUSE env vars set -> zero calls (flag-off inertness)", async () => {
  const fetchImpl = fakeFetch();
  await handleActionResult(triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED), FAKE_CTX, {
    env: {},
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test("other stream events (e.g. message.completed) -> zero calls", async () => {
  const fetchImpl = fakeFetch();
  const event = { type: "message.completed", data: { message: "hi", finishReason: "stop" } };
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("fetch rejection -> handler resolves without throwing", async () => {
  const fetchImpl = async () => {
    throw new Error("connection refused");
  };
  await assert.doesNotReject(
    handleActionResult(triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED), FAKE_CTX, {
      env: FAKE_ENV,
      fetchImpl,
    }),
  );
});

test("a non-2xx response -> handler resolves without throwing", async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 500 }));
  await assert.doesNotReject(
    handleActionResult(triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED), FAKE_CTX, {
      env: FAKE_ENV,
      fetchImpl,
    }),
  );
  assert.equal(fetchImpl.calls.length, 1); // the attempt still happened
});

// ---------------------------------------------------------------------------
// pushScore — network seam in isolation
// ---------------------------------------------------------------------------

test("pushScore builds Basic auth from public+secret key and never rejects on transport failure", async () => {
  const fetchImpl = async () => {
    throw new Error("boom");
  };
  await assert.doesNotReject(
    pushScore({
      baseUrl: "https://fake.langfuse.example.com/",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl,
      body: { sessionId: "s", name: "triage_verdict", value: "blocked", dataType: "CATEGORICAL" },
    }),
  );
});

test("pushScore de-slashes a trailing slash on baseUrl", async () => {
  const fetchImpl = fakeFetch();
  await pushScore({
    baseUrl: "https://fake.langfuse.example.com/",
    publicKey: "pk",
    secretKey: "sk",
    fetchImpl,
    body: { sessionId: "s", name: "triage_verdict", value: "blocked", dataType: "CATEGORICAL" },
  });
  assert.equal(fetchImpl.calls[0].url, "https://fake.langfuse.example.com/api/public/scores");
});

// ---------------------------------------------------------------------------
// issue #1197 — the live stream delivers `output` as a JSON STRING, so
// verdictValueFor must parse it (else triage always scores "unblocked").

test("verdictValueFor: parses a JSON-string triage output to 'blocked'", () => {
  assert.deepEqual(verdictValueFor("triage", JSON.stringify(TRIAGE_OUTPUT_BLOCKED)), {
    value: "blocked",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: parses a JSON-string qa output to its verdict", () => {
  assert.deepEqual(verdictValueFor("qa", JSON.stringify(QA_OUTPUT_ISSUES)), {
    value: "issues_found",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: an unparseable string falls back safely (unblocked)", () => {
  assert.deepEqual(verdictValueFor("triage", "not json at all"), {
    value: "unblocked",
    dataType: "CATEGORICAL",
  });
});

// ---------------------------------------------------------------------------
// issue #1196 — the same completed result reaches the hook more than once per
// turn; dedup by callId so one completion scores exactly once.

test("handleActionResult: the same callId scores exactly once", async () => {
  const fetchImpl = fakeFetch();
  const seen = new Set();
  const ev = triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED); // callId call_triage_1
  await handleActionResult(ev, FAKE_CTX, { env: FAKE_ENV, fetchImpl, seen });
  await handleActionResult(ev, FAKE_CTX, { env: FAKE_ENV, fetchImpl, seen });
  assert.equal(fetchImpl.calls.length, 1, "one score despite two identical events");
});

test("handleActionResult: different callIds each score once", async () => {
  const fetchImpl = fakeFetch();
  const seen = new Set();
  const a = triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED, {
    result: { kind: "subagent-result", callId: "call_A", subagentName: "triage", output: TRIAGE_OUTPUT_BLOCKED },
  });
  const b = triageActionResultEvent(TRIAGE_OUTPUT_BLOCKED, {
    result: { kind: "subagent-result", callId: "call_B", subagentName: "triage", output: TRIAGE_OUTPUT_BLOCKED },
  });
  await handleActionResult(a, FAKE_CTX, { env: FAKE_ENV, fetchImpl, seen });
  await handleActionResult(b, FAKE_CTX, { env: FAKE_ENV, fetchImpl, seen });
  assert.equal(fetchImpl.calls.length, 2);
});
