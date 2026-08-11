import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  lookupApiKeyByHash: vi.fn(),
  readCurrentAcceptanceCorrectionPackets: vi.fn(),
}));

import {
  lookupApiKeyByHash,
  readCurrentAcceptanceCorrectionPackets,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";

function request(
  body: unknown,
  options: { authorization?: string; contentType?: string; contentLength?: string } = {},
): NextRequest {
  const encoded = JSON.stringify(body);
  return new NextRequest("http://localhost/api/v1/agent/acceptance-correction-packets", {
    method: "POST",
    headers: {
      Authorization: options.authorization ?? "Bearer agentrail-key",
      "Content-Type": options.contentType ?? "application/json",
      ...(options.contentLength ? { "Content-Length": options.contentLength } : {}),
    },
    body: encoded,
  });
}

const current = {
  kind: "current" as const,
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
  packetIds: ["packet-1"],
  packetSetSha256: "c".repeat(64),
  correctionPacketPayloadSetSha256: "d".repeat(64),
  packets: [{ kind: "review_job_correction_packet", version: 1, packetId: "packet-1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookupApiKeyByHash).mockResolvedValue({
    id: "key-1",
    workspaceId: current.binding.workspaceId,
    teamId: null,
    kind: "self_hosted",
  } as never);
  vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue(current as never);
});

describe("POST /api/v1/agent/acceptance-correction-packets", () => {
  it("authenticates before parsing or reading correction custody", async () => {
    const response = await POST(request({ recordId: RECORD_ID }, { authorization: "Basic nope" }));

    expect(response.status).toBe(401);
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("accepts exactly recordId and rejects extra authority fields", async () => {
    const response = await POST(request({ recordId: RECORD_ID, workspaceId: current.binding.workspaceId }));

    expect(response.status).toBe(400);
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("rejects non-JSON and declared oversized bodies", async () => {
    const wrongType = await POST(request({ recordId: RECORD_ID }, { contentType: "text/plain" }));
    const oversized = await POST(request({ recordId: RECORD_ID }, { contentLength: String(4 * 1024 + 1) }));

    expect(wrongType.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("derives workspace authority from the bearer and returns the exact current envelope", async () => {
    const response = await POST(request({ recordId: RECORD_ID }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readCurrentAcceptanceCorrectionPackets).toHaveBeenCalledWith({
      workspaceId: current.binding.workspaceId,
      recordId: RECORD_ID,
    });
    expect(await response.json()).toEqual({ schemaVersion: 1, correctionPackets: current });
  });

  it.each([
    { kind: "not_found" },
    { kind: "not_current" },
    { kind: "not_ready", reason: "invalid_packet_custody" },
  ])("returns server-derived $kind truth without inventing delivery state", async (result) => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue(result as never);

    const response = await POST(request({ recordId: RECORD_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, correctionPackets: result });
  });

  it("sanitizes storage failures", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockRejectedValue(
      new Error("postgres://secret@db/internal"),
    );

    const response = await POST(request({ recordId: RECORD_ID }));

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
