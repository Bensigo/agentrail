import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("./client", () => ({
  client: {
    query: queryMock,
  },
}));

import { listFailureClusters } from "./queries";

describe("listFailureClusters", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("groups failures by fingerprint, phase, and failure_type with contributing run IDs", async () => {
    queryMock.mockResolvedValue({
      json: async () => [
        {
          fingerprint: "sha256:abc",
          phase: "execute",
          failure_type: "test_error",
          count: "3",
          first_seen: "2026-06-13 08:00:00.000",
          last_seen: "2026-06-13 08:02:00.000",
          run_ids: ["run-a", "run-b", "run-c"],
        },
      ],
    });

    const clusters = await listFailureClusters("ws-1");

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("GROUP BY fingerprint, phase, failure_type"),
        query_params: { workspaceId: "ws-1" },
        format: "JSONEachRow",
      })
    );
    expect(queryMock.mock.calls[0][0].query).toContain("arraySlice");
    expect(queryMock.mock.calls[0][0].query).toContain("20");
    expect(clusters).toEqual([
      {
        fingerprint: "sha256:abc",
        phase: "execute",
        failure_type: "test_error",
        count: 3,
        first_seen: "2026-06-13 08:00:00.000",
        last_seen: "2026-06-13 08:02:00.000",
        run_ids: ["run-a", "run-b", "run-c"],
      },
    ]);
  });
});
