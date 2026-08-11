import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CHANGE_RECORD_PR_PATH,
  buildChangeRecordUrl,
  classifyStatus,
  createChangeRecordTransport,
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function correctionPackets(overrides = {}) {
  const packet = {
    kind: "review_job_correction_packet",
    version: 1,
    packetId: "",
    workspaceId: "ws-1",
    recordId: "record-1",
    jobId: "job-1",
    repo: "ada/widgets",
    prNumber: 98,
    headSha: "a".repeat(40),
    acceptanceContract: { id: "contract-1", version: 2 },
    criterion: { id: "AC-1", snapshot: "The saved value is visible." },
    basis: "acceptance_contract",
    state: "failed",
    expected: "The saved value is visible.",
    observed: "The saved value was absent.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save then reload.",
      reproduction: { modality: "ui", steps: [{ action: "open", path: "/settings" }] },
    },
    evidence: { evidenceRef: "artifact:ui-1", artifactKey: "ui-1.png", executionId: "exec-1", previewBootId: "boot-1" },
    scopeBoundary: "Only AC-1 at this exact head.",
    impact: "The confirmed criterion failed.",
    requiredCorrection: "Render the saved value.",
    reverification: "Rerun the saved UI plan on the next exact head.",
  };
  packet.packetId = `correction-${sha256(JSON.stringify({
    jobId: packet.jobId,
    criterionId: packet.criterion.id,
    headSha: packet.headSha,
    recordId: packet.recordId,
    acceptanceContractId: packet.acceptanceContract.id,
    acceptanceContractVersion: packet.acceptanceContract.version,
  })).slice(0, 48)}`;
  const packetIds = [packet.packetId];
  const packets = [packet];
  return {
    kind: "current",
    binding: {
      workspaceId: "ws-1",
      recordId: "record-1",
      reviewJobId: "job-1",
      repo: "ada/widgets",
      prNumber: 98,
      headSha: "a".repeat(40),
      headCycleId: "job-1",
      authorityGeneration: 2,
      acceptanceContract: { id: "contract-1", version: 2, sha256: "b".repeat(64) },
    },
    packetIds,
    packetSetSha256: sha256(JSON.stringify({
      kind: "acceptance_context_packet_set", version: 1, packetIds,
    })),
    correctionPacketPayloadSetSha256: sha256(canonicalJson({
      kind: "acceptance_correction_packet_payload_set", version: 1, packets,
    })),
    packets,
    ...overrides,
  };
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
      correctionPackets: correctionPackets(),
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
  assert.deepEqual(result.correctionPackets, correctionPackets());
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
        correctionPackets: correctionPackets(),
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
        correctionPackets: correctionPackets(),
      }),
    })),
  });

  assert.equal(result.ok, true);
  assert.equal(result.acceptanceContract, null);
});

test("projects closed non-current correction truth without delivery or repair claims", async () => {
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
        correctionPackets: { kind: "not_current" },
      }),
    })),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.correctionPackets, { kind: "not_current" });
  assert.equal("delivered" in result.correctionPackets, false);
  assert.equal("acknowledged" in result.correctionPackets, false);
  assert.equal("repaired" in result.correctionPackets, false);
});

test("fails closed when packet identity does not match the returned Record", async () => {
  const mismatched = correctionPackets();
  mismatched.binding.recordId = "record-other";
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
        correctionPackets: mismatched,
      }),
    })),
  });

  assert.equal(result.reason, "bad_body");
});

test("fails closed on incomplete packet fields, extra envelope keys, and a mismatched head cycle", async () => {
  const cases = [
    () => {
      const value = correctionPackets();
      delete value.packets[0].observed;
      return value;
    },
    () => ({ ...correctionPackets(), deliveryState: "carrier_accepted" }),
    () => {
      const value = correctionPackets();
      value.binding.headCycleId = "different-cycle";
      return value;
    },
    () => {
      const value = correctionPackets();
      value.binding.repo = "../repo";
      value.packets[0].repo = "../repo";
      value.correctionPacketPayloadSetSha256 = sha256(canonicalJson({
        kind: "acceptance_correction_packet_payload_set",
        version: 1,
        packets: value.packets,
      }));
      return value;
    },
  ];

  for (const makeCorrectionPackets of cases) {
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
          correctionPackets: makeCorrectionPackets(),
        }),
      })),
    });
    assert.equal(result.reason, "bad_body");
  }
});

test("accepts a packet above 24k when every canonical field remains within its DB bound", async () => {
  const value = correctionPackets();
  const packet = value.packets[0];
  const text = "x".repeat(2_000);
  packet.criterion.snapshot = text;
  packet.expected = text;
  packet.observed = text;
  packet.affectedContext.flow = text;
  packet.affectedContext.reproduction.steps = Array.from({ length: 12 }, () => ({
    action: "open",
    path: `/${"p".repeat(2_047)}`,
  }));
  packet.evidence.evidenceRef = text;
  packet.evidence.artifactKey = text;
  packet.scopeBoundary = text;
  packet.impact = text;
  packet.requiredCorrection = text;
  packet.reverification = text;
  value.correctionPacketPayloadSetSha256 = sha256(canonicalJson({
    kind: "acceptance_correction_packet_payload_set",
    version: 1,
    packets: value.packets,
  }));
  assert.ok(JSON.stringify(packet).length > 24_000);

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
        correctionPackets: value,
      }),
    })),
  });

  assert.equal(result.ok, true);
  assert.equal(result.correctionPackets.kind, "current");
  assert.equal(result.correctionPackets.packets[0].expected.length, 2_000);
});

test("real transport cancels a streamed response that crosses its byte cap", async () => {
  let cancelled = false;
  const transport = createChangeRecordTransport({
    maxResponseBytes: 32,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "error");
      return {
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(33)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    },
  });

  await assert.rejects(() => transport("https://console.example.com", {
    method: "POST", headers: {}, body: "{}",
  }));
  assert.equal(cancelled, true);
});

test("real transport keeps its timeout active through a stalled response body", async () => {
  let observedSignal;
  const transport = createChangeRecordTransport({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return {
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            observedSignal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
          },
        }),
      };
    },
  });

  await assert.rejects(() => transport("https://console.example.com", {
    method: "POST", headers: {}, body: "{}",
  }));
  assert.equal(observedSignal.aborted, true);
});

test("real transport classifies non-JSON error statuses before attempting body parsing", async () => {
  for (const [status, reason] of [[401, "unauthorized"], [429, "rate_limited"], [503, "upstream_error"]]) {
    const transport = createChangeRecordTransport({
      fetchImpl: async () => new Response("not-json", { status }),
    });
    const result = await fetchChangeRecord({
      env: ENV,
      eveSessionId: "eve-1",
      repo: "ada/widgets",
      prNumber: 98,
      transport,
    });
    assert.equal(result.reason, reason);
  }
});

test("real transport cancels a stalled non-2xx stream before returning", async () => {
  let cancelled = false;
  const transport = createChangeRecordTransport({
    fetchImpl: async () => ({
      status: 401,
      headers: new Headers(),
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  });
  const result = await fetchChangeRecord({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    prNumber: 98,
    transport,
  });

  assert.equal(result.reason, "unauthorized");
  assert.equal(cancelled, true);
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
