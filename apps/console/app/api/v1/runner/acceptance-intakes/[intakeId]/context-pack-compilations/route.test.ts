import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceIntake: vi.fn(), readAcceptanceContracts: vi.fn(), readChangeRecordTimeline: vi.fn(), getRepositoryByName: vi.fn(), enqueueAcceptanceContextPackCompilation: vi.fn() }));
import { enqueueAcceptanceContextPackCompilation, getRepositoryByName, readAcceptanceContracts, readAcceptanceIntake, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { POST } from "./route";
const secret = "secret", WS = "ws", ID = "intake";
const req = (body = { workspaceId: WS }, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
const params = Promise.resolve({ intakeId: ID });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(readAcceptanceIntake).mockResolvedValue({ intake: { recordId: "record" } } as never); vi.mocked(readAcceptanceContracts).mockResolvedValue([{ id: "contract", version: 2, status: "confirmed" }] as never); vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { repo: "acme/widgets" } } as never); vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repository" } as never); vi.mocked(enqueueAcceptanceContextPackCompilation).mockResolvedValue({ inserted: true, compilation: { id: "compilation", status: "queued", phase: "execute", acceptanceContractId: "contract", acceptanceContractVersion: 2 } } as never); });
describe("Acceptance Intake Context Pack admission", () => {
  it("admits only the confirmed intake contract at the record repository", async () => { expect((await POST(req(), { params })).status).toBe(201); expect(enqueueAcceptanceContextPackCompilation).toHaveBeenCalledWith({ workspaceId: WS, recordId: "record", repositoryId: "repository", contractId: "contract", contractVersion: 2, phase: "execute", createdBy: "jace:acceptance-intake-context-pack" }); });
  it("refuses an unconfirmed contract without resolving a repository", async () => { vi.mocked(readAcceptanceContracts).mockResolvedValue([{ id: "contract", version: 2, status: "draft" }] as never); expect((await POST(req(), { params })).status).toBe(409); expect(getRepositoryByName).not.toHaveBeenCalled(); });
  it("requires Jace authentication", async () => { expect((await POST(req({ workspaceId: WS }, false), { params })).status).toBe(401); expect(readAcceptanceIntake).not.toHaveBeenCalled(); });
});
