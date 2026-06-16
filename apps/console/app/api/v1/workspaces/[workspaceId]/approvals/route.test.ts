import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ getWorkspaceMembership: vi.fn() }));
vi.mock("@agentrail/db-clickhouse", () => ({
  getWorkspaceAuditEvents: vi.fn(),
  insertAfkRunEvents: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import {
  getWorkspaceAuditEvents,
  insertAfkRunEvents,
} from "@agentrail/db-clickhouse";
import { GET, POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function params() {
  return Promise.resolve({ workspaceId: WS });
}

function getReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/approvals`, {
    method: "GET",
  });
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/approvals`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(getWorkspaceAuditEvents).mockReset();
  vi.mocked(insertAfkRunEvents).mockReset();
});

describe("GET /approvals", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("projects audit events into pending/approved actions", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    vi.mocked(getWorkspaceAuditEvents).mockResolvedValue([
      {
        run_id: "run-1",
        event_type: "security_block",
        type: "security_block",
        action_kind: "",
        target: "main",
        reason: "protected_target",
        approved_by: "",
        ts: "2026-06-16T00:00:00.000Z",
      },
    ] as never);

    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].status).toBe("pending");
    expect(json.items[0].kind).toBe("protected_push");
  });
});

describe("POST /approvals", () => {
  it("records an approval as an approval_granted Audit Event (AC2)", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: USER, email: "alice@example.com" },
    } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    vi.mocked(insertAfkRunEvents).mockResolvedValue(1 as never);

    const res = await POST(
      postReq({ runId: "run-1", kind: "protected_push", target: "main" }),
      { params: params() }
    );
    expect(res.status).toBe(201);

    // The audit event was recorded through the shared run-events path.
    expect(insertAfkRunEvents).toHaveBeenCalledTimes(1);
    const [events] = vi.mocked(insertAfkRunEvents).mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("audit");
    expect(events[0].session_id).toBe("run-1");
    expect(events[0].action.type).toBe("approval_granted");
    expect(events[0].action.action_kind).toBe("protected_push");
    expect(events[0].action.target).toBe("main");
    expect(events[0].action.approved_by).toBe("alice@example.com");
  });

  it("400 when required fields are missing", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    const res = await POST(postReq({ runId: "run-1" }), { params: params() });
    expect(res.status).toBe(400);
    expect(insertAfkRunEvents).not.toHaveBeenCalled();
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(
      postReq({ runId: "r", kind: "merge", target: "PR #1" }),
      { params: params() }
    );
    expect(res.status).toBe(403);
    expect(insertAfkRunEvents).not.toHaveBeenCalled();
  });
});
