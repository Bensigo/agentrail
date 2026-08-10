import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  createDraftAcceptanceRecordFromIntake: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  validateAcceptanceContract: vi.fn(),
}));

import {
  createDraftAcceptanceRecordFromIntake,
  getJaceSessionByEveSessionId,
  validateAcceptanceContract,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "test-secret";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const eveSessionId = "eve-session-1";
const completeContract = {
  originalRequest: "Add saved filters",
  normalizedRequirements: ["Persist filters"],
  acceptanceCriteria: [
    { id: "AC-1", text: "A saved filter can be reopened", userVisible: true },
  ],
  nonGoals: [],
  risks: [],
  stops: [],
  unresolvedQuestions: [],
  environment: {},
};

function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-intakes/intake-1/draft", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ intakeId: "intake-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(validateAcceptanceContract).mockReturnValue({ ok: true });
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    id: "session-1",
    workspaceId,
  } as never);
  vi.mocked(createDraftAcceptanceRecordFromIntake).mockResolvedValue({
    intake: { id: "intake-1", status: "drafted" },
    record: { id: "record-1", repo: "acme/widgets" },
    contract: { id: "contract-1", version: 1, status: "draft" },
    created: true,
  } as never);
});

describe("POST /api/v1/runner/acceptance-intakes/[intakeId]/draft", () => {
  it("requires Jace auth before reading or drafting", async () => {
    expect((await POST(request({}, false), params)).status).toBe(401);
    expect(createDraftAcceptanceRecordFromIntake).not.toHaveBeenCalled();
  });

  it("rejects incomplete Contracts before durable drafting", async () => {
    vi.mocked(validateAcceptanceContract).mockReturnValue({
      ok: false,
      errors: ["acceptanceCriteria"],
    });
    const response = await POST(
      request({ eveSessionId, repo: "acme/widgets", contract: completeContract }),
      params
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      fields: ["acceptanceCriteria"],
    });
    expect(createDraftAcceptanceRecordFromIntake).not.toHaveBeenCalled();
  });

  it("binds the server-selected Intake to a draft Record without authorizing work", async () => {
    const response = await POST(
      request({
        eveSessionId,
        workspaceId: "foreign-workspace-must-be-ignored",
        repo: " acme/widgets ",
        contract: completeContract,
      }),
      params
    );
    expect(response.status).toBe(201);
    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith(eveSessionId);
    expect(createDraftAcceptanceRecordFromIntake).toHaveBeenCalledWith({
      workspaceId,
      intakeId: "intake-1",
      repo: "acme/widgets",
      contract: completeContract,
      createdBy: "jace:acceptance-intake",
    });
    await expect(response.json()).resolves.toEqual({
      intake: { id: "intake-1", status: "drafted" },
      record: { id: "record-1", repo: "acme/widgets" },
      contract: { id: "contract-1", version: 1, status: "draft" },
    });
  });

  it("returns a conflict instead of replacing a bound Intake's draft", async () => {
    vi.mocked(createDraftAcceptanceRecordFromIntake).mockRejectedValue({ code: "conflict" });
    const response = await POST(
      request({ eveSessionId, repo: "acme/widgets", contract: completeContract }),
      params
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/different draft/);
  });

  it("derives the tenant from the server-side Jace session", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null);
    const response = await POST(
      request({ eveSessionId, repo: "acme/widgets", contract: completeContract }),
      params
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    expect(createDraftAcceptanceRecordFromIntake).not.toHaveBeenCalled();
  });
});
