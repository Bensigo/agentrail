import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const { auth, membership } = vi.hoisted(() => ({ auth: vi.fn(), membership: vi.fn() }));
vi.mock("@agentrail/auth", () => ({ auth }));
vi.mock("@agentrail/db-postgres", () => ({ getWorkspaceMembership: membership, lookupApiKeyByHash: vi.fn() }));
import { workflowAuthority, workflowBody, workflowStartValid, workflowUpdateValid } from "./workflow-api";
const workspaceId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.unstubAllEnvs(); auth.mockResolvedValue({ user: { id: "owner" } }); membership.mockResolvedValue({ role: "owner" }); });
describe("workflow authority", () => {
  it("accepts the configured public origin behind an internal proxy listener", async () => {
    vi.stubEnv("AGENTRAIL_PUBLIC_URL", "https://agentrail.example");
    const request = new NextRequest(`http://internal:3000/api/v1/workflow/keys?workspaceId=${workspaceId}`, { method: "POST", headers: { origin: "https://agentrail.example" } });
    expect(await workflowAuthority(request, true)).toMatchObject({ workspaceId, human: true, actorId: "owner" });
  });
  it("refuses a foreign origin, unauthenticated session and member writes", async () => {
    vi.stubEnv("AGENTRAIL_PUBLIC_URL", "https://agentrail.example");
    const request = new NextRequest(`http://internal/api?workspaceId=${workspaceId}`, { method: "POST", headers: { origin: "https://foreign.example" } });
    expect((await workflowAuthority(request, true) as NextResponse).status).toBe(403);
    auth.mockResolvedValue(null);
    expect((await workflowAuthority(request) as NextResponse).status).toBe(401);
    auth.mockResolvedValue({ user: { id: "member" } }); membership.mockResolvedValue({ role: "member" });
    expect((await workflowAuthority(request, true) as NextResponse).status).toBe(403);
  });
});
describe("bounded workflow input", () => {
  it("refuses caller-selected authority and fabricated verification", () => {
    const start = { taskKey: "task", title: "Work", agent: "Any agent", repositoryId: workspaceId, branch: "main" };
    expect(workflowStartValid(start)).toBe(true);
    expect(workflowStartValid({ ...start, workspaceId })).toBe(false);
    const update = { eventKey: "event", expectedRevision: 0, phase: "needs_review", summary: "Done" };
    expect(workflowUpdateValid(update, false)).toBe(true);
    expect(workflowUpdateValid({ ...update, phase: "closed" }, false)).toBe(false);
    expect(workflowUpdateValid({ ...update, verified: true }, false)).toBe(false);
    expect(workflowUpdateValid({ eventKey: "decision", expectedRevision: 0, decision: "complete" }, false)).toBe(false);
  });
  it("bounds actual streamed request bytes", async () => {
    const request = new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify({ summary: "x".repeat(20000) }) });
    expect(await workflowBody(request)).toBeNull();
  });
});
