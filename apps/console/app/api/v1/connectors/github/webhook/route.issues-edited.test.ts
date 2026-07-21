import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1345 PR③ / AC2 — the github-webhook route's `issues.edited` branch: a
 * human hand-editing the GitHub issue's title/body directly (no chat, no
 * Jace tool call) re-briefs a DENIED alignment hold. Mocks the
 * `alignment-reconciler` module wholesale (mirrors
 * `route.reconciler-trigger.test.ts`'s own idiom) since this file is about
 * the ROUTE's own gating/wiring, not `reviseAndRepostAlignmentBrief`'s or
 * `reconcileAlignmentBriefs`' internal behavior (covered by
 * `alignment-reconciler.test.ts`).
 */
vi.mock("@agentrail/db-postgres", () => ({
  findWorkspaceByRepo: vi.fn(),
  getConnector: vi.fn(),
  enqueueGithubIssue: vi.fn(),
  findQueueEntryByExternalId: vi.fn(),
}));

vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn(),
  reconcileAlignmentBriefs: vi.fn(),
  reviseAndRepostAlignmentBrief: vi.fn(),
}));

import { POST } from "./route";
import { findWorkspaceByRepo, getConnector, findQueueEntryByExternalId } from "@agentrail/db-postgres";
import {
  reconcileAlignmentBriefs,
  reviseAndRepostAlignmentBrief,
} from "../../../../../../lib/alignment-reconciler";

const mockFindWorkspace = vi.mocked(findWorkspaceByRepo);
const mockGetConnector = vi.mocked(getConnector);
const mockFindEntry = vi.mocked(findQueueEntryByExternalId);
const mockReconcile = vi.mocked(reconcileAlignmentBriefs);
const mockReviseAndRepost = vi.mocked(reviseAndRepostAlignmentBrief);

const ORIGINAL_SECRET_ENV = process.env["GITHUB_WEBHOOK_SECRET"];

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues" },
    body: JSON.stringify(body),
  });
}

function editedPayload(overrides: {
  changes?: Record<string, unknown>;
  number?: number;
  title?: string;
  body?: string;
} = {}) {
  return {
    action: "edited",
    changes: overrides.changes ?? { body: { from: "old body" } },
    issue: {
      number: overrides.number ?? 42,
      title: overrides.title ?? "Cheaper version",
      body: overrides.body ?? "## Acceptance criteria\n- [ ] narrower scope\n",
      labels: [],
    },
    repository: { full_name: "acme/widgets" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["GITHUB_WEBHOOK_SECRET"];
  mockFindWorkspace.mockResolvedValue("ws-1");
  mockGetConnector.mockResolvedValue({ config: { triggerLabel: "ready-for-agent" } } as never);
  mockReconcile.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = ORIGINAL_SECRET_ENV;
  vi.restoreAllMocks();
});

describe("POST /api/v1/connectors/github/webhook — issues.edited (#1345 PR③ / AC2)", () => {
  it("no-op when the edit changed NEITHER title NOR body (e.g. a milestone/assignee-adjacent edit that still lands as 'edited') — never looks up a queue entry", async () => {
    const res = await POST(req(editedPayload({ changes: { milestone: { from: null } } })));
    const body = await res.json();

    expect(body).toEqual({ matched: false, reason: "edited but title/body unchanged" });
    expect(mockFindEntry).not.toHaveBeenCalled();
    expect(mockReviseAndRepost).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("no-op when `changes` is entirely absent from the payload", async () => {
    const payload = editedPayload();
    delete (payload as Record<string, unknown>)["changes"];
    const res = await POST(req(payload));
    const body = await res.json();

    expect(body).toEqual({ matched: false, reason: "edited but title/body unchanged" });
    expect(mockFindEntry).not.toHaveBeenCalled();
  });

  it("title-only change also counts as content-changed", async () => {
    mockFindEntry.mockResolvedValue(null);
    const res = await POST(req(editedPayload({ changes: { title: { from: "Old title" } } })));
    const body = await res.json();

    expect(mockFindEntry).toHaveBeenCalled();
    expect(body).toEqual({ matched: true, revised: false, reason: "not_found" });
  });

  it("no workspace owns the repo: benign no-op, never looks up a queue entry", async () => {
    mockFindWorkspace.mockResolvedValue(null);
    const res = await POST(req(editedPayload()));
    const body = await res.json();

    expect(body).toEqual({ matched: false, reason: "no workspace owns this repo" });
    expect(mockFindEntry).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("no matching queue entry for this (workspace, repo, number): benign no-op", async () => {
    mockFindEntry.mockResolvedValue(null);
    const res = await POST(req(editedPayload({ number: 999 })));
    const body = await res.json();

    expect(mockFindEntry).toHaveBeenCalledWith("ws-1", "acme/widgets", 999);
    expect(body).toEqual({ matched: true, revised: false, reason: "not_found" });
    expect(mockReviseAndRepost).not.toHaveBeenCalled();
  });

  it("entry found but NOT currently denied: the shared helper's own no-op is forwarded, no brief posted", async () => {
    mockFindEntry.mockResolvedValue({
      id: "entry-1",
      state: "parked",
      parkReason: "awaiting alignment",
      title: "t",
      body: "b",
    } as never);
    mockReviseAndRepost.mockResolvedValue({ revised: false, reason: "not_denied" });

    const res = await POST(req(editedPayload()));
    const body = await res.json();

    expect(body).toEqual({ matched: true, revised: false, reason: "not_denied" });
  });

  it("AC2 core: a denied entry hand-edited on GitHub re-briefs with NO chat involved — calls the shared helper with the edited title/body and returns its outcome", async () => {
    mockFindEntry.mockResolvedValue({
      id: "entry-1",
      state: "parked",
      parkReason: "alignment denied — open a new issue to try again",
      title: "Old title",
      body: "old body",
    } as never);
    mockReviseAndRepost.mockResolvedValue({ revised: true, outcome: "posted" });

    const res = await POST(
      req(editedPayload({ title: "Cheaper version", body: "## Acceptance criteria\n- [ ] narrower scope\n" }))
    );
    const body = await res.json();

    expect(body).toEqual({ matched: true, revised: true, outcome: "posted" });
    expect(mockReviseAndRepost).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      queueEntryId: "entry-1",
      title: "Cheaper version",
      body: "## Acceptance criteria\n- [ ] narrower scope\n",
      repoFullName: "acme/widgets",
      number: 42,
    });
  });

  it("sweeps reconcileAlignmentBriefs for the workspace AFTER the direct attempt, non-fatally", async () => {
    mockFindEntry.mockResolvedValue({
      id: "entry-1",
      state: "parked",
      parkReason: "alignment denied — open a new issue to try again",
      title: "t",
      body: "b",
    } as never);
    const order: string[] = [];
    mockReviseAndRepost.mockImplementation(async () => {
      order.push("reviseAndRepostAlignmentBrief");
      return { revised: true, outcome: "posted" };
    });
    mockReconcile.mockImplementation(async () => {
      order.push("reconcileAlignmentBriefs");
      return [];
    });

    await POST(req(editedPayload()));

    expect(order).toEqual(["reviseAndRepostAlignmentBrief", "reconcileAlignmentBriefs"]);
  });

  it("a reconciler sweep failure is caught and does not change the response", async () => {
    mockFindEntry.mockResolvedValue({
      id: "entry-1",
      state: "parked",
      parkReason: "alignment denied — open a new issue to try again",
      title: "t",
      body: "b",
    } as never);
    mockReviseAndRepost.mockResolvedValue({ revised: true, outcome: "posted" });
    mockReconcile.mockRejectedValue(new Error("reconciler exploded"));

    const res = await POST(req(editedPayload()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ matched: true, revised: true, outcome: "posted" });
    expect(console.error).toHaveBeenCalled();
  });

  it("still never fires the reconciler sweep for a content-unchanged or no-workspace no-op (nothing resembling queue activity happened)", async () => {
    await POST(req(editedPayload({ changes: {} })));
    expect(mockReconcile).not.toHaveBeenCalled();

    mockFindWorkspace.mockResolvedValue(null);
    await POST(req(editedPayload()));
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
