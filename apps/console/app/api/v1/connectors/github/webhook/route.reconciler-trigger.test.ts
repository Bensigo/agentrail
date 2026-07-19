import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1274 PR③ — the github-webhook route's reconciler trigger, in isolation
 * from `route.test.ts` (which regression-pins `postAlignmentBrief`'s own
 * behavior and deliberately does NOT mock `lib/alignment-reconciler` at
 * all — see that file's own header comment). This file mocks the
 * reconciler module directly so it can assert the TWO things that matter
 * about the trigger itself: it IS called (bounded), and its failure is
 * NON-FATAL — the webhook's response is byte-identical whether the
 * reconciler succeeds or throws.
 */
vi.mock("@agentrail/db-postgres", () => ({
  findWorkspaceByRepo: vi.fn(),
  getConnector: vi.fn(),
  enqueueGithubIssue: vi.fn(),
}));

vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn(),
  reconcileAlignmentBriefs: vi.fn(),
}));

import { POST } from "./route";
import { findWorkspaceByRepo, getConnector, enqueueGithubIssue } from "@agentrail/db-postgres";
import { postAlignmentBrief, reconcileAlignmentBriefs } from "../../../../../../lib/alignment-reconciler";

const mockFindWorkspace = vi.mocked(findWorkspaceByRepo);
const mockGetConnector = vi.mocked(getConnector);
const mockEnqueue = vi.mocked(enqueueGithubIssue);
const mockPostBrief = vi.mocked(postAlignmentBrief);
const mockReconcile = vi.mocked(reconcileAlignmentBriefs);

const ORIGINAL_SECRET_ENV = process.env["GITHUB_WEBHOOK_SECRET"];

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues" },
    body: JSON.stringify(body),
  });
}

const ISSUE_PAYLOAD = {
  action: "opened",
  issue: { number: 42, title: "t", body: "## Acceptance criteria\n- [ ] x\n", labels: [{ name: "ready-for-agent" }] },
  repository: { full_name: "acme/widgets" },
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["GITHUB_WEBHOOK_SECRET"];
  mockFindWorkspace.mockResolvedValue("ws-1");
  mockGetConnector.mockResolvedValue({ config: { triggerLabel: "ready-for-agent" } } as never);
  mockEnqueue.mockResolvedValue({ enqueued: true, id: "entry-1", state: "queued", blockedBy: [] } as never);
  mockReconcile.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = ORIGINAL_SECRET_ENV;
  vi.restoreAllMocks();
});

describe("POST /api/v1/connectors/github/webhook — alignment-reconciler trigger (#1274 PR③)", () => {
  it("calls reconcileAlignmentBriefs with a bounded limit after a real admission attempt", async () => {
    await POST(req(ISSUE_PAYLOAD));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(5);
  });

  it("fires for a not-enqueued (deduped) result too — any real admission attempt is 'queue activity'", async () => {
    mockEnqueue.mockResolvedValue({ enqueued: false, reason: "already queued (deduped)" } as never);
    await POST(req(ISSUE_PAYLOAD));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for a no-op delivery (no workspace owns the repo) — nothing resembling queue activity happened", async () => {
    mockFindWorkspace.mockResolvedValue(null);
    await POST(req(ISSUE_PAYLOAD));
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("NON-FATAL: a reconciler rejection does not change the webhook's response or status", async () => {
    mockReconcile.mockRejectedValue(new Error("reconciler exploded"));

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ matched: true, enqueued: 1, id: "entry-1" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("alignment-reconciler"),
      expect.any(Error)
    );
  });

  it("NON-FATAL: a reconciler failure does not prevent the alignment-brief branch of the SAME request from running", async () => {
    mockEnqueue.mockResolvedValue({
      enqueued: true,
      id: "entry-1",
      state: "parked",
      blockedBy: [],
      parkedFor: "awaiting_alignment",
    } as never);
    mockReconcile.mockRejectedValue(new Error("reconciler exploded"));
    mockPostBrief.mockResolvedValue("posted");

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    // postAlignmentBrief is mocked in this file too (module-level mock) —
    // its own behavior is proven in route.test.ts; here we only need the
    // response shape to prove the route reached that branch at all, even
    // though the (unrelated) reconciler call earlier in the SAME request
    // just threw.
    expect(body).toEqual({ matched: true, enqueued: 1, id: "entry-1", alignmentBrief: "posted" });
  });
});
