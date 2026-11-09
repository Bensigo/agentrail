import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowRequest } from "./workflow-client.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("workflow transport", () => {
  it("refuses plaintext remote origins before sending a bearer", async () => {
    vi.stubEnv("AGENTRAIL_WORKFLOW_BASE_URL", "http://public.example"); vi.stubEnv("AGENTRAIL_WORKFLOW_API_KEY", "secret");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(workflowRequest("tasks")).rejects.toThrow("HTTPS"); expect(fetch).not.toHaveBeenCalled();
  });
  it("never follows redirects or leaks transport error secrets", async () => {
    vi.stubEnv("AGENTRAIL_WORKFLOW_BASE_URL", "https://console.example"); vi.stubEnv("AGENTRAIL_WORKFLOW_API_KEY", "secret");
    const fetch = vi.fn().mockRejectedValue(new Error("secret")); vi.stubGlobal("fetch", fetch);
    await expect(workflowRequest("tasks")).rejects.toThrow("unreachable");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
});
