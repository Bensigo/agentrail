import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceIntake: vi.fn(), readAcceptanceContracts: vi.fn(), confirmAcceptanceContract: vi.fn() }));
import { confirmAcceptanceContract, readAcceptanceContracts, readAcceptanceIntake } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "test-secret";
const WS = "00000000-0000-0000-0000-000000000001";
const ID = "00000000-0000-0000-0000-000000000002";
const draftedAt = new Date("2026-08-06T10:00:00.000Z");
const confirmedAt = new Date("2026-08-06T10:01:00.000Z");
const req = (body: unknown, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
const params = Promise.resolve({ intakeId: ID });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(readAcceptanceIntake).mockResolvedValue({ intake: { id: ID, recordId: "record-1", originChannel: "slack" }, messages: [{ direction: "inbound", sourceKey: "confirm-1", createdAt: confirmedAt }] } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{ id: "contract-1", version: 1, status: "draft", createdAt: draftedAt }] as never);
  vi.mocked(confirmAcceptanceContract).mockResolvedValue({ id: "contract-1", version: 1, status: "confirmed" } as never);
});

describe("Acceptance Intake channel confirmation", () => {
  it("requires Jace auth before reading the intake", async () => {
    expect((await POST(req({ workspaceId: WS, version: 1, confirmationSourceKey: "confirm-1" }, false), { params })).status).toBe(401);
    expect(readAcceptanceIntake).not.toHaveBeenCalled();
  });

  it("confirms only from a distinct inbound source message after the draft", async () => {
    const response = await POST(req({ workspaceId: WS, version: 1, confirmationSourceKey: "confirm-1" }), { params });
    expect(response.status).toBe(200);
    expect(confirmAcceptanceContract).toHaveBeenCalledWith({ workspaceId: WS, recordId: "record-1", version: 1, confirmedBy: "human:channel:slack:confirm-1" });
    await expect(response.json()).resolves.toEqual({ contract: { id: "contract-1", version: 1, status: "confirmed" } });
  });

  it("refuses an outbound or pre-draft source message without confirming", async () => {
    vi.mocked(readAcceptanceIntake).mockResolvedValue({ intake: { id: ID, recordId: "record-1", originChannel: "slack" }, messages: [{ direction: "outbound", sourceKey: "confirm-1", createdAt: confirmedAt }] } as never);
    expect((await POST(req({ workspaceId: WS, version: 1, confirmationSourceKey: "confirm-1" }), { params })).status).toBe(409);
    vi.mocked(readAcceptanceIntake).mockResolvedValue({ intake: { id: ID, recordId: "record-1", originChannel: "slack" }, messages: [{ direction: "inbound", sourceKey: "confirm-1", createdAt: draftedAt }] } as never);
    expect((await POST(req({ workspaceId: WS, version: 1, confirmationSourceKey: "confirm-1" }), { params })).status).toBe(409);
    expect(confirmAcceptanceContract).not.toHaveBeenCalled();
  });
});
