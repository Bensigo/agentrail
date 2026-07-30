import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getSlackInstallation: vi.fn(),
}));
vi.mock("../../../../../lib/slack-bot", () => ({
  sendSlackChannelMessage: vi.fn(),
}));

import { POST } from "./route";
import { getSlackInstallation } from "@agentrail/db-postgres";
import { sendSlackChannelMessage } from "../../../../../lib/slack-bot";

const mockGetInstallation = vi.mocked(getSlackInstallation);
const mockSend = vi.mocked(sendSlackChannelMessage);

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const TEAM_A = "TEAM_A";
const TEAM_B = "TEAM_B";
const TOKEN_A = "xoxb-team-a-secret-token";
const TOKEN_B = "xoxb-team-b-secret-token";

function installation(teamId: string, botToken: string) {
  return {
    teamId,
    teamName: "Some Team",
    botToken,
    botUserId: "UBOT1",
    enterpriseId: null,
  } as never;
}

function req(opts: { body?: unknown; token?: string } = {}): NextRequest {
  const { body, token } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/slack-reply", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockSend.mockResolvedValue({ ok: true });
  mockGetInstallation.mockImplementation(async (teamId: string) => {
    if (teamId === TEAM_A) return installation(TEAM_A, TOKEN_A);
    if (teamId === TEAM_B) return installation(TEAM_B, TOKEN_B);
    return null;
  });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/slack-reply", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never resolves an installation or sends", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(
        req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C1", text: "hi" } })
      );
      expect(res.status).toBe(401);
      expect(mockGetInstallation).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await POST(req({ body: { teamId: TEAM_A, channelId: "C1", text: "hi" } }));
      expect(res.status).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        req({ token: "wrong", body: { teamId: TEAM_A, channelId: "C1", text: "hi" } })
      );
      expect(res.status).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("validation", () => {
    it("400 and nothing posted when teamId is missing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const res = await POST(req({ token: SECRET, body: { channelId: "C1", text: "hi" } }));
      expect(res.status).toBe(400);
      expect(mockGetInstallation).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("400 and nothing posted when teamId is blank", async () => {
      const res = await POST(
        req({ token: SECRET, body: { teamId: "   ", channelId: "C1", text: "hi" } })
      );
      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("400 when channelId is missing", async () => {
      const res = await POST(req({ token: SECRET, body: { teamId: TEAM_A, text: "hi" } }));
      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("400 when text is missing/blank", async () => {
      const res = await POST(
        req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C1", text: "   " } })
      );
      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("400 when text exceeds the max length", async () => {
      const res = await POST(
        req({
          token: SECRET,
          body: { teamId: TEAM_A, channelId: "C1", text: "x".repeat(8001) },
        })
      );
      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("unknown / revoked team — fail closed, no fallback", () => {
    it("404 and nothing posted for a team with no installation at all, with a logged reason", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mockGetInstallation.mockResolvedValue(null);

      const res = await POST(
        req({ token: SECRET, body: { teamId: "TUNKNOWN", channelId: "C1", text: "hi" } })
      );

      expect(res.status).toBe(404);
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TUNKNOWN"));
      warnSpy.mockRestore();
    });

    it("404 and nothing posted for a revoked installation (getSlackInstallation already collapses this to null)", async () => {
      mockGetInstallation.mockImplementation(async (teamId: string) =>
        teamId === "TREVOKED" ? null : installation(teamId, "irrelevant")
      );

      const res = await POST(
        req({ token: SECRET, body: { teamId: "TREVOKED", channelId: "C1", text: "hi" } })
      );

      expect(res.status).toBe(404);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // --- THE CROSS-TENANT TEST — the reason this whole task exists ----------
  describe("cross-tenant token isolation", () => {
    it("a reply for team A posts with A's token, and sendSlackChannelMessage is never called with B's token", async () => {
      const res = await POST(
        req({
          token: SECRET,
          body: { teamId: TEAM_A, channelId: "C-A", threadTs: "111.222", text: "hello from A" },
        })
      );

      expect(res.status).toBe(200);
      expect(mockGetInstallation).toHaveBeenCalledWith(TEAM_A);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(TOKEN_A, "C-A", "hello from A", "111.222");
      expect(mockSend).not.toHaveBeenCalledWith(TOKEN_B, expect.anything(), expect.anything(), expect.anything());
    });

    it("the reverse: a reply for team B posts with B's token, and sendSlackChannelMessage is never called with A's token", async () => {
      const res = await POST(
        req({
          token: SECRET,
          body: { teamId: TEAM_B, channelId: "C-B", text: "hello from B" },
        })
      );

      expect(res.status).toBe(200);
      expect(mockGetInstallation).toHaveBeenCalledWith(TEAM_B);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(TOKEN_B, "C-B", "hello from B", undefined);
      expect(mockSend).not.toHaveBeenCalledWith(TOKEN_A, expect.anything(), expect.anything(), expect.anything());
    });

    it("two sequential replies for A then B each resolve their OWN installation independently — no cross-contamination across calls", async () => {
      await POST(req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C-A", text: "msg A" } }));
      await POST(req({ token: SECRET, body: { teamId: TEAM_B, channelId: "C-B", text: "msg B" } }));

      expect(mockSend).toHaveBeenNthCalledWith(1, TOKEN_A, "C-A", "msg A", undefined);
      expect(mockSend).toHaveBeenNthCalledWith(2, TOKEN_B, "C-B", "msg B", undefined);
    });
  });

  it("omits threadTs (as undefined, not empty string) when the reply has none — a DM-style send", async () => {
    await POST(req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C-A", text: "hi" } }));
    expect(mockSend).toHaveBeenCalledWith(TOKEN_A, "C-A", "hi", undefined);
  });

  it("502 and a token-free error body when Slack itself rejects the send", async () => {
    mockSend.mockResolvedValue({ ok: false, error: "Slack rejected the message (not_in_channel)." });

    const res = await POST(
      req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C-A", text: "hi" } })
    );

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toEqual({ error: "Slack rejected the message (not_in_channel)." });
    expect(JSON.stringify(json)).not.toContain(TOKEN_A);
  });

  it("never logs or returns the bot token, even on a failed send", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockSend.mockResolvedValue({ ok: false, error: "Couldn't reach Slack to send the message — try again." });

    const res = await POST(
      req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C-A", text: "hi" } })
    );

    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain(TOKEN_A);
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN_A);
    }
    errorSpy.mockRestore();
  });

  it("200 { ok: true } on a happy path", async () => {
    const res = await POST(
      req({ token: SECRET, body: { teamId: TEAM_A, channelId: "C-A", text: "hi" } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
