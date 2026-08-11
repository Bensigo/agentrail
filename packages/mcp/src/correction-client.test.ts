import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  ACCEPTANCE_CORRECTION_PACKETS_PATH,
  fetchAcceptanceCorrectionPackets,
} from "./correction-client.js";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const ENV = {
  AGENTRAIL_SERVER_BASE_URL: "https://console.example.com/",
  AGENTRAIL_MCP_CORRECTION_API_KEY: "agentrail-secret",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function packet(criterionId = "AC-1") {
  const value = {
    kind: "review_job_correction_packet" as const,
    version: 1 as const,
    packetId: "",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    repo: "ada/widgets",
    prNumber: 98,
    headSha: "a".repeat(40),
    recordId: RECORD_ID,
    jobId: "33333333-3333-4333-8333-333333333333",
    acceptanceContract: { id: "44444444-4444-4444-8444-444444444444", version: 2 },
    criterion: { id: criterionId, snapshot: `Criterion ${criterionId} must pass.` },
    basis: "acceptance_contract" as const,
    state: "failed" as const,
    expected: `Criterion ${criterionId} must pass.`,
    observed: `Criterion ${criterionId} failed.`,
    affectedContext: {
      modality: "ui" as const,
      environmentKind: "isolated_preview" as const,
      flow: "Open the page and inspect the saved state.",
      reproduction: {
        modality: "ui" as const,
        steps: [{ action: "open" as const, path: "/settings" }],
      },
    },
    evidence: {
      evidenceRef: `artifact:${criterionId}`,
      artifactKey: `${criterionId}.png`,
      executionId: `execution-${criterionId}`,
      previewBootId: "preview-1",
    },
    scopeBoundary: `Only ${criterionId} on this exact head.`,
    impact: `The confirmed ${criterionId} failed.`,
    requiredCorrection: `Repair ${criterionId} without widening scope.`,
    reverification: `Rerun ${criterionId} on the next exact head.`,
  };
  value.packetId = `correction-${sha256(JSON.stringify({
    jobId: value.jobId,
    criterionId: value.criterion.id,
    headSha: value.headSha,
    recordId: value.recordId,
    acceptanceContractId: value.acceptanceContract.id,
    acceptanceContractVersion: value.acceptanceContract.version,
  })).slice(0, 48)}`;
  return value;
}

function refreshDigests(value: ReturnType<typeof current>): void {
  value.packetIds = value.packets.map((item) => item.packetId);
  value.packetSetSha256 = sha256(JSON.stringify({
    kind: "acceptance_context_packet_set",
    version: 1,
    packetIds: value.packetIds,
  }));
  value.correctionPacketPayloadSetSha256 = sha256(canonicalJson({
    kind: "acceptance_correction_packet_payload_set",
    version: 1,
    packets: [...value.packets].sort((left, right) => left.packetId.localeCompare(right.packetId)),
  }));
}

function current(inputPackets = [packet()]) {
  const packets = [...inputPackets].sort((left, right) => left.packetId.localeCompare(right.packetId));
  const value = {
    kind: "current",
    binding: {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      recordId: RECORD_ID,
      reviewJobId: "33333333-3333-4333-8333-333333333333",
      repo: "ada/widgets",
      prNumber: 98,
      headSha: "a".repeat(40),
      headCycleId: "33333333-3333-4333-8333-333333333333",
      authorityGeneration: 4,
      acceptanceContract: {
        id: "44444444-4444-4444-8444-444444444444",
        version: 2,
        sha256: "b".repeat(64),
      },
    },
    packetIds: [] as string[],
    packetSetSha256: "",
    correctionPacketPayloadSetSha256: "",
    packets,
  };
  refreshDigests(value);
  return value;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function read(correctionPackets: unknown) {
  return fetchAcceptanceCorrectionPackets({
    recordId: RECORD_ID,
    env: ENV,
    fetchImpl: async () => response({ schemaVersion: 1, correctionPackets }),
  });
}

function packetForModality(modality: "ui" | "api" | "data" | "job") {
  const value = packet(`AC-${modality}`) as unknown as { affectedContext: unknown };
  const assertion = {
    pointer: "/saved",
    equalsType: "boolean",
    equalsHmacSha256: "e".repeat(64),
  };
  const dataRequest = {
    method: "GET",
    path: "/api/saved",
    expectedStatus: 200,
    digestAlgorithm: "hmac-sha256-v1",
    digestKeyId: "key-1",
    digestContext: "f".repeat(64),
    expectedJson: [assertion],
  };
  if (modality === "api") {
    value.affectedContext = {
      modality,
      environmentKind: "isolated_preview",
      flow: "Read the saved API state.",
      reproduction: { modality, request: { method: "GET", path: "/api/saved", expectedStatus: 200 } },
    };
  } else if (modality === "data") {
    value.affectedContext = {
      modality,
      environmentKind: "isolated_preview",
      flow: "Read the saved data state.",
      reproduction: { modality, request: dataRequest },
    };
  } else if (modality === "job") {
    value.affectedContext = {
      modality,
      environmentKind: "isolated_preview",
      flow: "Run the job and read saved data.",
      reproduction: {
        modality,
        request: {
          trigger: { method: "POST", path: "/api/jobs", expectedStatus: 202 },
          readback: dataRequest,
        },
      },
    };
  }
  return value as unknown as ReturnType<typeof packet>;
}

describe("fetchAcceptanceCorrectionPackets", () => {
  it("fails before transport when fixed config or record input is invalid", async () => {
    const fetchImpl = vi.fn();

    await expect(fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: {}, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "config_missing",
    });
    await expect(fetchAcceptanceCorrectionPackets({ recordId: "not-a-record", env: ENV, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "invalid_record",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects remote cleartext and credential/query/fragment-bearing base URLs", async () => {
    const fetchImpl = vi.fn();
    const unsafe = [
      "http://console.example.com",
      "https://user:pass@console.example.com",
      "https://console.example.com?target=elsewhere",
      "https://console.example.com#fragment",
    ];

    for (const baseUrl of unsafe) {
      await expect(fetchAcceptanceCorrectionPackets({
        recordId: RECORD_ID,
        env: { ...ENV, AGENTRAIL_SERVER_BASE_URL: baseUrl },
        fetchImpl,
      })).resolves.toEqual({ ok: false, reason: "config_missing" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:3100/", "http://127.0.0.1:3100/", "http://[::1]:3100/"])(
    "allows local development over loopback at %s",
    async (baseUrl) => {
      const fetchImpl = vi.fn(async () => response({
        schemaVersion: 1,
        correctionPackets: { kind: "not_current" },
      }));

      const result = await fetchAcceptanceCorrectionPackets({
        recordId: RECORD_ID,
        env: { ...ENV, AGENTRAIL_SERVER_BASE_URL: baseUrl },
        fetchImpl,
      });

      expect(result).toEqual({ ok: true, correctionPackets: { kind: "not_current" } });
    },
  );

  it("uses only the fixed endpoint, bearer, and recordId locator", async () => {
    const correctionPackets = current();
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      response({ schemaVersion: 1, correctionPackets }));

    const result = await fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: ENV, fetchImpl });

    expect(result).toEqual({ ok: true, correctionPackets });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://console.example.com${ACCEPTANCE_CORRECTION_PACKETS_PATH}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers).toMatchObject({ Authorization: "Bearer agentrail-secret" });
    expect(JSON.parse(String(init.body))).toEqual({ recordId: RECORD_ID });
  });

  it("preserves closed server currentness truth without adding delivery state", async () => {
    const fetchImpl = vi.fn(async () => response({
      schemaVersion: 1,
      correctionPackets: { kind: "not_current" },
    }));

    await expect(fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: ENV, fetchImpl })).resolves.toEqual({
      ok: true,
      correctionPackets: { kind: "not_current" },
    });
  });

  it("fails closed when the server envelope is malformed or bound to another Record", async () => {
    const mismatch = current();
    mismatch.binding.recordId = "55555555-5555-4555-8555-555555555555";
    const fetchImpl = vi.fn(async () => response({ schemaVersion: 1, correctionPackets: mismatch }));

    await expect(fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: ENV, fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it.each(["ui", "api", "data", "job"] as const)(
    "accepts the complete closed %s reproduction shape",
    async (modality) => {
      const correctionPackets = current([packetForModality(modality)]);

      const result = await read(correctionPackets);

      expect(result).toEqual({ ok: true, correctionPackets });
    },
  );

  it("accepts a packet above 24k when every field remains within the DB schema bound", async () => {
    const item = packet();
    const text = "x".repeat(2_000);
    item.criterion.snapshot = text;
    item.expected = text;
    item.observed = text;
    item.affectedContext.flow = text;
    item.affectedContext.reproduction.steps = Array.from({ length: 12 }, () => ({
      action: "open" as const,
      path: `/${"p".repeat(2_047)}`,
    }));
    item.evidence.evidenceRef = text;
    item.evidence.artifactKey = text;
    item.scopeBoundary = text;
    item.impact = text;
    item.requiredCorrection = text;
    item.reverification = text;
    expect(JSON.stringify(item).length).toBeGreaterThan(24_000);
    const correctionPackets = current([item]);

    await expect(read(correctionPackets)).resolves.toEqual({ ok: true, correctionPackets });
  });

  it("rejects missing fields, nested outcome claims, unsafe repos, identity/order drift, and both digest drifts", async () => {
    const cases: Array<() => ReturnType<typeof current>> = [
      () => {
        const value = current();
        delete (value.packets[0] as Partial<(typeof value.packets)[number]>).observed;
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        (value.packets[0].evidence as Record<string, unknown>).deliveryState = "carrier_accepted";
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        (value.packets[0].affectedContext.reproduction as Record<string, unknown>).acknowledged = true;
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        (value.packets[0] as Record<string, unknown>).repaired = true;
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        value.packets[0].packetId = `correction-${"0".repeat(48)}`;
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        value.packetSetSha256 = "0".repeat(64);
        return value;
      },
      () => {
        const value = current();
        value.correctionPacketPayloadSetSha256 = "0".repeat(64);
        return value;
      },
      () => {
        const value = current([packet("AC-1"), packet("AC-2")]);
        value.packets.reverse();
        refreshDigests(value);
        return value;
      },
      () => {
        const value = current();
        value.binding.repo = "../repo";
        value.packets[0].repo = "../repo";
        refreshDigests(value);
        return value;
      },
    ];

    for (const makeValue of cases) {
      await expect(read(makeValue())).resolves.toEqual({ ok: false, reason: "invalid_response" });
    }
  });

  it("maps a network rejection to unreachable without surfacing raw error text", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("agentrail-secret socket failed");
    });

    const result = await fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: ENV, fetchImpl });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("agentrail-secret");
  });

  it("cancels a non-2xx response stream before returning the closed status mapping", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => ({ status: 401, headers: new Headers(), body }));

    const result = await fetchAcceptanceCorrectionPackets({ recordId: RECORD_ID, env: ENV, fetchImpl });

    expect(result).toEqual({ ok: false, reason: "unauthorized" });
    expect(cancelled).toBe(true);
  });

  it("cancels a streamed response that crosses the configured byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(33)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => ({ status: 200, headers: new Headers(), body }));

    await expect(fetchAcceptanceCorrectionPackets({
      recordId: RECORD_ID,
      env: ENV,
      fetchImpl,
      maxResponseBytes: 32,
    })).resolves.toEqual({ ok: false, reason: "invalid_response" });
    expect(cancelled).toBe(true);
  });

  it("keeps the timeout active through a stalled response body and never leaks the API key", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("agentrail-secret")), { once: true });
        },
      });
      return { status: 200, headers: new Headers(), body };
    });

    const result = await fetchAcceptanceCorrectionPackets({
      recordId: RECORD_ID,
      env: ENV,
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect((fetchImpl.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("agentrail-secret");
  });
});
