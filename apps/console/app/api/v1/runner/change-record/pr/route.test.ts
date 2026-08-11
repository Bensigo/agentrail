import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getChatIdentityById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  getRepositoryByName: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
  readCurrentAcceptanceCorrectionPackets: vi.fn(),
}));

import {
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  findOrCreateChangeRecord,
  getRepositoryByName,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
  readCurrentAcceptanceCorrectionPackets,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-secret";
const ORIGINAL_ENV = process.env[ENV_KEY];
const NOW = new Date("2026-08-03T12:00:00.000Z");
const CORRECTION_PACKETS = {
  kind: "current" as const,
  binding: {
    workspaceId: "ws-1",
    recordId: "record-1",
    reviewJobId: "cycle-1",
    repo: "ada/widgets",
    prNumber: 98,
    headSha: "a".repeat(40),
    headCycleId: "cycle-1",
    authorityGeneration: 2,
    acceptanceContract: { id: "contract-1", version: 3, sha256: "b".repeat(64) },
  },
  packetIds: ["packet-1"],
  packetSetSha256: "c".repeat(64),
  correctionPacketPayloadSetSha256: "d".repeat(64),
  packets: [
    {
      kind: "review_job_correction_packet",
      version: 1,
      packetId: "packet-1",
      workspaceId: "ws-1",
      recordId: "record-1",
      jobId: "cycle-1",
      repo: "ada/widgets",
      prNumber: 98,
      headSha: "a".repeat(40),
      acceptanceContract: { id: "contract-1", version: 3 },
    },
  ],
};

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/change-record/pr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function timeline(eventCount = 2) {
  return {
    record: {
      id: "record-1",
      workspaceId: "ws-1",
      repo: "ada/widgets",
      issueNumber: 42,
      prNumber: 98,
      headShas: ["deadbeef"],
      currentPrHeadSha: "a".repeat(40),
      currentPrHeadCycleId: "cycle-1",
      currentPrHeadAuthoritative: true,
      currentPrHeadAuthorityGeneration: 2,
      mergedSha: null,
      state: "open",
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: Array.from({ length: eventCount }, (_, index) => ({
      id: `event-${index + 1}`,
      recordId: "record-1",
      eventKey: `event:${index + 1}`,
      stage: index === 0 ? "review" : "verification",
      at: NOW,
      actor: "jace",
      payloadRef:
        index === 0
          ? {
              kind: "review_job",
              verdict: "approve",
              postedReviewUrl:
                "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
            }
          : { kind: "ac_evidence", evidenceUrl: `https://console.example.com/e/${index}` },
      createdAt: NOW,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    id: "session-1",
    eveSessionId: "eve-1",
    chatIdentityId: null,
    workspaceId: "ws-1",
  } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1" } as never);
  vi.mocked(findOrCreateChangeRecord).mockResolvedValue(timeline().record as never);
  vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue(timeline() as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([
    {
      status: "confirmed",
      version: 3,
      contract: {
        acceptanceCriteria: [
          { id: "AC-1", text: "The change works.", userVisible: true },
        ],
      },
    },
  ] as never);
  vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue(CORRECTION_PACKETS as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/change-record/pr", () => {
  it("401 without the central Jace secret", async () => {
    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }, false));

    expect(res.status).toBe(401);
    expect(readChangeRecordTimelineByPr).not.toHaveBeenCalled();
  });

  it("400 on malformed body before session lookup", async () => {
    const res = await POST(req({ eveSessionId: "eve-1", repo: "not owner/name", prNumber: 98 }));

    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("404 when the repo is not connected to the resolved workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(404);
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "ada/widgets");
    expect(readChangeRecordTimelineByPr).not.toHaveBeenCalled();
  });

  it("200 found:false when no Change Record exists for the workspace/repo/PR", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
    expect(readChangeRecordTimelineByPr).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "ada/widgets",
      prNumber: 98,
    });
  });

  it("200 with stable record data and available lifecycle evidence, capped at six rows", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue(timeline(8) as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
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
        {
          stage: "review",
          label: "review posted (approve)",
          url: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
        },
        {
          stage: "verification",
          label: "acceptance evidence",
          url: "https://console.example.com/e/1",
        },
        {
          stage: "verification",
          label: "acceptance evidence",
          url: "https://console.example.com/e/2",
        },
        {
          stage: "verification",
          label: "acceptance evidence",
          url: "https://console.example.com/e/3",
        },
        {
          stage: "verification",
          label: "acceptance evidence",
          url: "https://console.example.com/e/4",
        },
        {
          stage: "verification",
          label: "acceptance evidence",
          url: "https://console.example.com/e/5",
        },
      ],
      acceptanceContract: {
        version: 3,
        criteria: [
          { id: "AC-1", text: "The change works.", userVisible: true },
        ],
      },
      correctionPackets: CORRECTION_PACKETS,
    });
    expect(readCurrentAcceptanceCorrectionPackets).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recordId: "record-1",
    });
  });

  it("returns exact server-derived non-current correction truth without delivery claims", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({ kind: "not_current" } as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({ kind: "not_current" });
  });

  it("downgrades a cross-read current envelope when the timeline authority generation differs", async () => {
    const staleTimeline = timeline();
    staleTimeline.record.currentPrHeadAuthorityGeneration = 1;
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue(staleTimeline as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({ kind: "not_current" });
  });

  it("returns a null contract rather than inventing criteria when no confirmed contract exists", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([
      {
        status: "draft",
        version: 4,
        contract: {
          acceptanceCriteria: [
            { id: "AC-2", text: "Draft only.", userVisible: false },
          ],
        },
      },
    ] as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect((await res.json()).acceptanceContract).toBeNull();
  });

  it("returns a null contract for legacy confirmed criteria without userVisible", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([
      {
        status: "confirmed",
        version: 2,
        contract: {
          acceptanceCriteria: [{ id: "AC-1", text: "Legacy criterion" }],
        },
      },
    ] as never);

    const res = await POST(req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98 }));

    expect(res.status).toBe(200);
    expect((await res.json()).acceptanceContract).toBeNull();
  });

  it("ensures the PR record before reading when the review tool requests the preflight", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, ensure: true })
    );

    expect(res.status).toBe(200);
    expect(findOrCreateChangeRecord).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "ada/widgets",
      prNumber: 98,
      state: "open",
    });
  });
});
