import { describe, expect, it, vi } from "vitest";
import { fetchJaceTask, sendJaceTurn } from "./jace-client.js";

const env = {
  AGENTRAIL_SERVER_BASE_URL: "https://console.example.com",
  AGENTRAIL_MCP_JACE_API_KEY: "workspace-secret",
};

describe("Jace MCP client", () => {
  it("keeps workspace and Record locators out of the wire contract", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }));
    await expect(sendJaceTurn({
      taskContextKey: "codex / 7",
      messageKey: "turn-1",
      message: "Plan this safely.",
      env,
      fetchImpl,
    })).resolves.toEqual({ ok: true, payload: { accepted: true } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://console.example.com/api/v1/agent/jace",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          taskContextKey: "codex / 7",
          messageKey: "turn-1",
          message: "Plan this safely.",
        }),
      }),
    );
  });

  it("URL-encodes task context and rejects unsafe remote configuration", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ acceptance: {} })));
    await fetchJaceTask({ taskContextKey: "codex / 7&x", env, fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://console.example.com/api/v1/agent/jace?taskContextKey=codex+%2F+7%26x",
    );
    await expect(fetchJaceTask({
      taskContextKey: "task-1",
      env: { ...env, AGENTRAIL_SERVER_BASE_URL: "http://console.example.com" },
      fetchImpl,
    })).resolves.toEqual({ ok: false, reason: "config_missing" });
  });
});
