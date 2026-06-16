import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("./client", () => ({
  client: {
    query: queryMock,
  },
}));

import { getWorkspaceAuditEvents } from "./queries";

describe("getWorkspaceAuditEvents", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("filters run_events to the audit event types and parses the action payload", async () => {
    queryMock.mockResolvedValue({
      json: async () => [
        {
          run_id: "run-1",
          event_type: "security_block",
          payload: JSON.stringify({
            type: "security_block",
            reason: "protected_target",
            target: "main",
            detail: "push to protected/production target: main",
          }),
          occurred_at: "2026-06-16 00:00:00.000",
        },
      ],
    });

    const rows = await getWorkspaceAuditEvents("ws-1");

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("event_type IN ({types: Array(String)})"),
        query_params: {
          workspaceId: "ws-1",
          types: ["security_block", "approval_granted"],
        },
        format: "JSONEachRow",
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("security_block");
    expect(rows[0].reason).toBe("protected_target");
    expect(rows[0].target).toBe("main");
  });

  it("parses an approval_granted action with approved_by", async () => {
    queryMock.mockResolvedValue({
      json: async () => [
        {
          run_id: "run-2",
          event_type: "approval_granted",
          payload: JSON.stringify({
            type: "approval_granted",
            action_kind: "merge",
            target: "PR #42",
            approved_by: "alice@example.com",
          }),
          occurred_at: "2026-06-16 01:00:00.000",
        },
      ],
    });

    const [row] = await getWorkspaceAuditEvents("ws-1");
    expect(row.type).toBe("approval_granted");
    expect(row.action_kind).toBe("merge");
    expect(row.approved_by).toBe("alice@example.com");
  });

  it("tolerates a malformed payload without throwing", async () => {
    queryMock.mockResolvedValue({
      json: async () => [
        {
          run_id: "run-3",
          event_type: "security_block",
          payload: "{not json",
          occurred_at: "2026-06-16 02:00:00.000",
        },
      ],
    });

    const rows = await getWorkspaceAuditEvents("ws-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe(""); // empty action, projection drops it safely
  });
});
