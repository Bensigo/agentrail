import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  recordIssueFiled: vi.fn(),
}));
import { POST } from "./route";
import { recordIssueFiled } from "@agentrail/db-postgres";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/goals/file-recorded", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(recordIssueFiled).mockResolvedValue(undefined);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/goals/file-recorded", () => {
  it("401 when no Authorization header is sent, and never calls recordIssueFiled", async () => {
    const res = await POST(req({ goalId: "goal-1", issueExternalId: "42" }, false));
    expect(res.status).toBe(401);
    expect(recordIssueFiled).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    const res = await POST(req({ goalId: "goal-1" }));
    expect(res.status).toBe(400);
    expect(recordIssueFiled).not.toHaveBeenCalled();
  });

  it("calls recordIssueFiled(goalId, issueExternalId) and returns {ok:true} — THE call that was missing from production entirely before this fix", async () => {
    const res = await POST(req({ goalId: "goal-1", issueExternalId: "42" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(recordIssueFiled).toHaveBeenCalledWith("goal-1", "42");
  });
});
