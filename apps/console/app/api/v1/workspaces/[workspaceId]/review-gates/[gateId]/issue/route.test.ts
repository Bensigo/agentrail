import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

describe("POST review gate finding issue", () => {
  it("refuses before authentication, connector lookup, or any external write", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(new NextRequest(
      "http://localhost/api/v1/workspaces/ws-1/review-gates/gate-1/issue",
      { method: "POST", body: JSON.stringify({ title: "caller draft", target: "github" }) },
    ), {
      params: Promise.resolve({ workspaceId: "ws-1", gateId: "gate-1" }),
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "Legacy Review Gates issue publication is disabled",
      code: "LEGACY_REVIEW_GATE_ISSUE_PUBLICATION_DISABLED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
