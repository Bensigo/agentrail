import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceIntakeReadback: vi.fn() }));
import { readAcceptanceIntakeReadback } from "@agentrail/db-postgres";
import { GET } from "./route";
const secret = "test-secret"; const workspaceId = "ws-1"; const intakeId = "intake-1"; const params = Promise.resolve({ intakeId });
const req = (auth = true) => new NextRequest(`http://localhost?workspaceId=${workspaceId}`, { headers: auth ? { Authorization: `Bearer ${secret}` } : {} });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(readAcceptanceIntakeReadback).mockResolvedValue({ intake: { id: intakeId, originChannel: "slack", status: "collecting_context", recordId: "record-1" }, firstInbound: { direction: "inbound", text: "original", textTruncated: false }, recentMessages: [{ direction: "outbound", text: "Which repo?", textTruncated: false }], messageCounts: { total: 10, included: 2, truncated: true }, contract: { id: "contract-1", version: 1, status: "draft", acceptanceCriteria: { items: [], total: 0, included: 0, truncated: false }, openQuestions: { items: [{ id: "repo", text: "Which repo?", status: "open" }], total: 1, included: 1, truncated: false } } } as never); });
describe("GET compact Acceptance Intake", () => {
  it("requires Jace auth", async () => { expect((await GET(req(false), { params })).status).toBe(401); expect(readAcceptanceIntakeReadback).not.toHaveBeenCalled(); });
  it("returns only the bounded DB projection", async () => { const res = await GET(req(), { params }); expect(res.status).toBe(200); await expect(res.json()).resolves.toMatchObject({ readback: { messageCounts: { total: 10, included: 2, truncated: true }, contract: { openQuestions: { items: [{ id: "repo", status: "open" }] } } } }); expect(readAcceptanceIntakeReadback).toHaveBeenCalledWith({ workspaceId, intakeId }); });
});
