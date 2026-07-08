import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { sendDiscordMessage } from "./discord";

/**
 * The Discord webhook sender (#1050) — the console port of the legacy Python
 * Discord notify. Posts `{ content }` to the workspace's incoming webhook and
 * surfaces failures as a typed result (never throws) so the run-outcome notify
 * caller stays best-effort. `fetch` is stubbed so no live network is needed.
 */
describe("sendDiscordMessage", () => {
  const WEBHOOK = "https://discord.com/api/webhooks/123/tok";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("POSTs the message as a Discord `content` payload and returns ok on 2xx", async () => {
    // Discord returns 204 (no content) on a successful webhook post — a 204
    // Response must have a null body.
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const res = await sendDiscordMessage(WEBHOOK, "AgentRail: PR ready — issue #42");

    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ content: "AgentRail: PR ready — issue #42" });
  });

  it("returns a typed error (never throws) when Discord rejects the webhook (4xx)", async () => {
    fetchSpy.mockResolvedValue(new Response("bad", { status: 404 }));

    const res = await sendDiscordMessage(WEBHOOK, "x");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Discord/);
  });

  it("returns a typed error (never throws) on a transport failure", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    await expect(sendDiscordMessage(WEBHOOK, "x")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Couldn't reach Discord"),
    });
  });
});
