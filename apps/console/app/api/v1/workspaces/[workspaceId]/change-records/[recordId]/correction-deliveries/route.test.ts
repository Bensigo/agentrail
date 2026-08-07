import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  queueEvidenceReviewCorrectionDelivery: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
}));
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, queueEvidenceReviewCorrectionDelivery, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { POST } from "./route";

const params = Promise.resolve({ workspaceId: "ws-1", recordId: "record-1" });
const payload = {
  correctionId: "correction-1", deliveryKey: "mcp:task-9:correction-1",
  channel: "mcp_task_context", target: { builder: "codex", taskContextKey: "task-9" },
};
function request(body: unknown = payload) {
  return new NextRequest("http://localhost/api/v1/workspaces/ws-1/change-records/record-1/correction-deliveries", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: "record-1" }, events: [] } as never);
  vi.mocked(queueEvidenceReviewCorrectionDelivery).mockResolvedValue({ id: "delivery-1", inserted: true, reviewRevisionId: "revision-1" } as never);
});

describe("POST correction delivery queue", () => {
  it("requires authentication and owner/admin authority", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await POST(request(), { params })).status).toBe(401);
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);
    expect((await POST(request(), { params })).status).toBe(403);
    expect(queueEvidenceReviewCorrectionDelivery).not.toHaveBeenCalled();
  });

  it("rejects invalid targets before writing a delivery", async () => {
    const response = await POST(request({ ...payload, target: { builder: "codex" } }), { params });
    expect(response.status).toBe(400);
    expect(queueEvidenceReviewCorrectionDelivery).not.toHaveBeenCalled();
  });

  it("queues only a correction scoped to this exact Acceptance Record", async () => {
    const response = await POST(request(), { params });
    expect(response.status).toBe(201);
    expect(queueEvidenceReviewCorrectionDelivery).toHaveBeenCalledWith({
      workspaceId: "ws-1", recordId: "record-1", ...payload,
    });
    expect(await response.json()).toEqual({
      delivery: { id: "delivery-1", channel: "mcp_task_context", target: payload.target, reviewRevisionId: "revision-1", outcome: "queued" },
    });
  });

  it("accepts only this Record as a durable Jace task inbox target", async () => {
    const inboxPayload = {
      correctionId: "correction-1", deliveryKey: "jace-inbox:record-1:correction-1",
      channel: "jace_task_inbox", target: { recordId: "record-1" },
    };
    const response = await POST(request(inboxPayload), { params });
    expect(response.status).toBe(201);
    expect(queueEvidenceReviewCorrectionDelivery).toHaveBeenCalledWith({
      workspaceId: "ws-1", recordId: "record-1", ...inboxPayload,
    });
    expect((await POST(request({ ...inboxPayload, target: { recordId: "record-2" } }), { params })).status).toBe(400);
  });

  it("does not turn an idempotent replay into a claimed notification", async () => {
    vi.mocked(queueEvidenceReviewCorrectionDelivery).mockResolvedValueOnce({ id: "delivery-1", inserted: false, reviewRevisionId: "revision-1" } as never);
    const response = await POST(request(), { params });
    expect(response.status).toBe(200);
    expect((await response.json()).delivery.outcome).toBe("queued");
  });

  it("surfaces a cross-record correction as a conflict", async () => {
    vi.mocked(queueEvidenceReviewCorrectionDelivery).mockRejectedValueOnce(new Error("Correction packet was not found in workspace"));
    const response = await POST(request(), { params });
    expect(response.status).toBe(404);
  });
});
