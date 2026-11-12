import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const { auth, membership } = vi.hoisted(() => ({ auth: vi.fn(), membership: vi.fn() }));
vi.mock("@agentrail/auth", () => ({ auth }));
vi.mock("@agentrail/db-postgres", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agentrail/db-postgres")>(),
  getWorkspaceMembership: membership,
  lookupApiKeyByHash: vi.fn(),
}));
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


describe("Office telemetry bounds", () => {
 const base={eventKey:"usage",expectedRevision:1,phase:"implementing",summary:"Working"};
 it("preserves unknown versus measured zero and requires complete snapshots",()=>{
  expect(workflowUpdateValid({...base,usage:{costUsd:0,inputTokens:0,outputTokens:null}},false)).toBe(true);
  expect(workflowUpdateValid({...base,usage:{costUsd:null,inputTokens:null,outputTokens:null}},false)).toBe(true);
  expect(workflowUpdateValid({...base,usage:{costUsd:1}},false)).toBe(false);
  for(const value of [-1,Infinity,NaN,"1"])expect(workflowUpdateValid({...base,usage:{costUsd:value,inputTokens:1,outputTokens:1}},false)).toBe(false);
  expect(workflowUpdateValid({...base,usage:{costUsd:1,inputTokens:1.5,outputTokens:1}},false)).toBe(false);
 });
 it("bounds shared context and rejects invalid denominators or authority fields",()=>{
  const context={summary:"Current files",sources:["src/main.ts"],tokens:100,windowTokens:8192};
  expect(workflowUpdateValid({...base,context},false)).toBe(true);
  expect(workflowUpdateValid({...base,context:{...context,windowTokens:0}},false)).toBe(false);
  expect(workflowUpdateValid({...base,context:{...context,sources:Array(13).fill("x")}},false)).toBe(false);
  expect(workflowUpdateValid({...base,context:{...context,summary:"x".repeat(1601)}},false)).toBe(false);
  expect(workflowUpdateValid({...base,usage:{costUsd:1,inputTokens:1,outputTokens:1,verified:true}},false)).toBe(false);
 });
});

describe("delivery inputs", () => {
  const update = { eventKey: "step", expectedRevision: 1, phase: "reviewing", summary: "Progress" };
  const commitSha = "a".repeat(40);
  it("validates typed steps and refuses an agent-supplied verified stage", () => {
    const plan = { step: "ready", criteria: ["An invite opens the game"], planPath: "docs/prd/invite.md" };
    expect(workflowUpdateValid({ ...update, checkpoint: plan }, false)).toBe(true);
    expect(workflowUpdateValid({ ...update, checkpoint: { ...plan, planPath: "../private.md" } }, false)).toBe(false);
    expect(workflowUpdateValid({ ...update, checkpoint: { step: "verified", commitSha } }, false)).toBe(false);
    expect(workflowUpdateValid({ ...update, checkpoint: { step: "release", commitSha } }, false)).toBe(true);
    expect(workflowUpdateValid({ ...update, checkpoint: { step: "release", commitSha, verifiedAt: "today" } }, false)).toBe(false);
  });

  it("accepts a safe URL only on a passing release receipt", () => {
    const check = { name: "agentrail:release-verification", passed: true, exitCode: 0, commitSha, outputSha256: "a".repeat(64), dirty: false };
    expect(workflowUpdateValid({ ...update, check: { ...check, releaseUrl: "https://example.com/app" } }, false)).toBe(true);
    expect(workflowUpdateValid({ ...update, check }, false)).toBe(false);
    expect(workflowUpdateValid({ ...update, check: { ...check, releaseUrl: "https://user:secret@example.com/" } }, false)).toBe(false);
    expect(workflowUpdateValid({ ...update, check: { ...check, name: "test", releaseUrl: "https://example.com/" } }, false)).toBe(false);
  });
});
