import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ createDraftAcceptanceRecord: vi.fn(), linkAcceptanceIntakeToRecord: vi.fn(), readAcceptanceIntake: vi.fn() }));
import { createDraftAcceptanceRecord, linkAcceptanceIntakeToRecord, readAcceptanceIntake } from "@agentrail/db-postgres";
import { POST } from "./route";
const secret = "test-secret";
const WS = "00000000-0000-0000-0000-000000000001";
const ID = "00000000-0000-0000-0000-000000000002";
const contract = { originalUserWording: "Add save", goal: "Save", acceptanceCriteria: [{ id: "AC-1", text: "Saves", required: true, userVisible: false }] };
const req = (body: unknown, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
const params = Promise.resolve({ intakeId: ID });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(readAcceptanceIntake).mockResolvedValue({ intake: { id: ID, originChannel: "slack", sourceReferences: [], recordId: null }, messages: [] } as never); vi.mocked(createDraftAcceptanceRecord).mockResolvedValue({ record: { id: "record-1", repo: "acme/widgets" }, contract: { id: "contract-1", version: 1, status: "draft" } } as never); vi.mocked(linkAcceptanceIntakeToRecord).mockResolvedValue({ id: ID, status: "drafted", recordId: "record-1" } as never); });
describe("Acceptance Intake draft", () => {
  it("requires Jace auth before reading or drafting", async () => { expect((await POST(req({ workspaceId: WS, repo: "acme/widgets", contract }, false), { params })).status).toBe(401); expect(readAcceptanceIntake).not.toHaveBeenCalled(); });
  it("creates a draft and links it without confirmation", async () => { const response = await POST(req({ workspaceId: WS, repo: "acme/widgets", contract }), { params }); expect(response.status).toBe(201); expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({ workKey: `acceptance-intake:${ID}`, createdBy: "jace:acceptance-intake" })); expect(linkAcceptanceIntakeToRecord).toHaveBeenCalledWith({ workspaceId: WS, intakeId: ID, recordId: "record-1" }); await expect(response.json()).resolves.toMatchObject({ contract: { status: "draft" } }); });
});
