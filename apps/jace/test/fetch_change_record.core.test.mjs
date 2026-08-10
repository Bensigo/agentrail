import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_RECORD_PR_PATH,
  buildChangeRecordUrl,
  classifyStatus,
  degraded,
  fetchChangeRecord,
} from "../agent/lib/fetch_change_record.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "secret",
};

function fakeTransport(responder) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  transport.calls = calls;
  return transport;
}

test("Change Record URL uses the runner endpoint and encodes lookup keys", () => {
  assert.equal(CHANGE_RECORD_PR_PATH, "/api/v1/runner/change-record/pr");
  assert.equal(
    buildChangeRecordUrl("https://console.example.com", "eve-1", "ada/widgets", 98),
    "https://console.example.com/api/v1/runner/change-record/pr?eveSessionId=eve-1&repo=ada%2Fwidgets&prNumber=98",
  );
});

test("classifyStatus maps the route status contract", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.equal(classifyStatus(400).reason, "bad_request");
  assert.equal(classifyStatus(401).reason, "unauthorized");
  assert.equal(classifyStatus(404).reason, "not_found");
  assert.equal(classifyStatus(409).reason, "conflict");
  assert.equal(classifyStatus(429).reason, "rate_limited");
  assert.equal(classifyStatus(500).reason, "upstream_error");
});

test("missing config and malformed input degrade without transport", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => ({}) }));
  const missing = await fetchChangeRecord({ env: {}, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(missing.reason, "config_missing");
  const malformed = await fetchChangeRecord({ env: ENV, eveSessionId: "", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(malformed.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("a missing record is a successful, explicit no-record result", async () => {
  const result = await fetchChangeRecord({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    prNumber: 98,
    transport: fakeTransport(async () => ({ status: 200, json: async () => ({ found: false }) })),
  });
  assert.deepEqual(result, {
    ok: true,
    found: false,
    repo: "ada/widgets",
    prNumber: 98,
    note: "No Change Record was found for this PR in the connected workspace.",
  });
});

test("projects the record and stage evidence while preserving the untrusted-data marker", async () => {
  const transport = fakeTransport(async () => ({
    status: 200,
    json: async () => ({
      found: true,
      record: {
        id: "record-1",
        workspaceId: "ws-1",
        repo: "ada/widgets",
        issueNumber: 42,
        prNumber: 98,
        state: "open",
      },
      stageEvidence: [
        { stage: "review", label: "review posted", url: "https://github.com/ada/widgets/pull/98" },
        { stage: "verification", label: "acceptance evidence", url: null },
      ],
      acceptanceContract: {
        version: 2,
        criteria: [
          { id: "AC-1", text: "The saved value is visible.", userVisible: true },
        ],
      },
    }),
  }));
  const result = await fetchChangeRecord({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.record.id, "record-1");
  assert.equal(result.stageEvidence.length, 2);
  assert.deepEqual(result.acceptanceContract, {
    version: 2,
    criteria: [
      { id: "AC-1", text: "The saved value is visible.", userVisible: true },
    ],
  });
  assert.equal(result.contentIsUntrusted, true);
  assert.equal(transport.calls[0].init.method, "POST");
  assert.equal(JSON.parse(transport.calls[0].init.body).eveSessionId, "eve-1");
});

test("projects only a complete confirmed Contract and marks malformed contract data unavailable", async () => {
  const result = await fetchChangeRecord({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    prNumber: 98,
    transport: fakeTransport(async () => ({
      status: 200,
      json: async () => ({
        found: true,
        record: { id: "record-1", workspaceId: "ws-1", repo: "ada/widgets", issueNumber: null, prNumber: 98, state: "open" },
        acceptanceContract: {
          version: 2,
          criteria: [
            { id: "AC-1", text: "ok", userVisible: false },
            { id: "", text: "unsafe", userVisible: true },
          ],
        },
      }),
    })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.acceptanceContract, null);
});

test("legacy confirmed criteria without userVisible fail closed", async () => {
  const result = await fetchChangeRecord({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    prNumber: 98,
    transport: fakeTransport(async () => ({
      status: 200,
      json: async () => ({
        found: true,
        record: {
          id: "record-1",
          workspaceId: "ws-1",
          repo: "ada/widgets",
          issueNumber: null,
          prNumber: 98,
          state: "open",
        },
        acceptanceContract: {
          version: 1,
          criteria: [{ id: "AC-1", text: "Legacy criterion" }],
        },
      }),
    })),
  });

  assert.equal(result.ok, true);
  assert.equal(result.acceptanceContract, null);
});

test("transport and malformed success bodies degrade honestly", async () => {
  const unreachable = await fetchChangeRecord({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98,
    transport: fakeTransport(async () => { throw new Error("network"); }),
  });
  assert.equal(unreachable.reason, "unreachable");
  const malformed = await fetchChangeRecord({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98,
    transport: fakeTransport(async () => ({ status: 200, json: async () => ({ found: true, record: {} }) })),
  });
  assert.equal(malformed.reason, "bad_body");
  assert.equal(degraded("not_found").degraded, true);
});
