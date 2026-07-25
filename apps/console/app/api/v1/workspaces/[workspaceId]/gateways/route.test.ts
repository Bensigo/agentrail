import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listChatIdentitiesForWorkspace: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listChatIdentitiesForWorkspace,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const DISCORD_URL = "https://discord.com/oauth2/authorize?client_id=999";
const SLACK_URL =
  "https://slack.com/oauth/v2/authorize?client_id=abc&scope=chat:write";

function params() {
  return Promise.resolve({ workspaceId: WS });
}
function getReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/gateways`);
}

interface GatewaysJson {
  gateways: Array<{
    kind: string;
    label: string;
    availability: string;
    status: string;
    configured: boolean;
    actionUrl: string | null;
    openUrl: string | null;
    linkedIdentities: Array<{ displayName: string | null }>;
  }>;
}

function gatewayRow(json: GatewaysJson, kind: string) {
  return json.gateways.find((g) => g.kind === kind)!;
}

describe("GET /api/v1/workspaces/:workspaceId/gateways", () => {
  // House pattern for a route that reads NEXT_PUBLIC_* directly (mirrors
  // repos/route.test.ts's AGENTRAIL_ONBOARD_ON_CONNECT save/restore): save
  // whatever this process already has, clear before each test, restore after
  // the whole suite so this file leaves no env residue for others.
  const savedTelegram = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  const savedDiscordUrl = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
  const savedDiscordLive = process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE;
  const savedSlackUrl = process.env.NEXT_PUBLIC_SLACK_INSTALL_URL;
  const savedSlackLive = process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE;

  beforeEach(() => {
    vi.mocked(auth).mockReset();
    vi.mocked(getWorkspaceMembership).mockReset();
    vi.mocked(listChatIdentitiesForWorkspace).mockReset();
    vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([] as never);
    delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    delete process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
    delete process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE;
    delete process.env.NEXT_PUBLIC_SLACK_INSTALL_URL;
    delete process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE;
  });

  afterEach(() => {
    if (savedTelegram === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    else process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = savedTelegram;
    if (savedDiscordUrl === undefined) delete process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
    else process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = savedDiscordUrl;
    if (savedDiscordLive === undefined) delete process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE;
    else process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE = savedDiscordLive;
    if (savedSlackUrl === undefined) delete process.env.NEXT_PUBLIC_SLACK_INSTALL_URL;
    else process.env.NEXT_PUBLIC_SLACK_INSTALL_URL = savedSlackUrl;
    if (savedSlackLive === undefined) delete process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE;
    else process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE = savedSlackLive;
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  describe("as a workspace member", () => {
    beforeEach(() => {
      vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
      vi.mocked(getWorkspaceMembership).mockResolvedValue({
        role: "member",
      } as never);
    });

    it("returns all five catalog gateways, in catalog order (happy path shape)", async () => {
      const res = await GET(getReq(), { params: params() });
      expect(res.status).toBe(200);
      const json = (await res.json()) as GatewaysJson;
      expect(json.gateways).toHaveLength(5);
      expect(json.gateways.map((g) => g.kind)).toEqual([
        "telegram",
        "discord",
        "slack",
        "imessage",
        "whatsapp",
      ]);
    });

    it("marks telegram connected when a telegram identity exists", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        {
          platform: "telegram",
          platformUserId: "999888777",
          displayName: "Ben",
        },
      ] as never);
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      const telegram = gatewayRow(json, "telegram");
      expect(telegram.status).toBe("connected");
      expect(telegram.linkedIdentities).toEqual([{ displayName: "Ben" }]);
    });

    it("stays disconnected when no chat identity is linked for that platform", async () => {
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "telegram").status).toBe("disconnected");
    });

    it("discord/slack actionUrl is null when the env URL + live pair is entirely absent", async () => {
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "discord").configured).toBe(false);
      expect(gatewayRow(json, "discord").actionUrl).toBeNull();
      expect(gatewayRow(json, "slack").configured).toBe(false);
      expect(gatewayRow(json, "slack").actionUrl).toBeNull();
    });

    it("discord/slack actionUrl stays null when the URL is set but CHANNEL_LIVE isn't — URL alone is not enough evidence", async () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = DISCORD_URL;
      process.env.NEXT_PUBLIC_SLACK_INSTALL_URL = SLACK_URL;
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "discord").configured).toBe(false);
      expect(gatewayRow(json, "discord").actionUrl).toBeNull();
      expect(gatewayRow(json, "slack").configured).toBe(false);
      expect(gatewayRow(json, "slack").actionUrl).toBeNull();
    });

    it("discord/slack actionUrl is the env URL VERBATIM once both the URL and CHANNEL_LIVE=true are set", async () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = DISCORD_URL;
      process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE = "true";
      process.env.NEXT_PUBLIC_SLACK_INSTALL_URL = SLACK_URL;
      process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE = "true";
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "discord").configured).toBe(true);
      expect(gatewayRow(json, "discord").actionUrl).toBe(DISCORD_URL);
      expect(gatewayRow(json, "slack").configured).toBe(true);
      expect(gatewayRow(json, "slack").actionUrl).toBe(SLACK_URL);
    });

    it("discord/slack openUrl stays null even when fully configured — their env URL is an install link, not a conversation link", async () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = DISCORD_URL;
      process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE = "true";
      process.env.NEXT_PUBLIC_SLACK_INSTALL_URL = SLACK_URL;
      process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE = "true";
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "discord").openUrl).toBeNull();
      expect(gatewayRow(json, "slack").openUrl).toBeNull();
    });

    it("telegram openUrl is the deep link when configured, matching actionUrl", async () => {
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = "jace_bot";
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      const telegram = gatewayRow(json, "telegram");
      expect(telegram.openUrl).toBe("https://t.me/jace_bot");
      expect(telegram.openUrl).toBe(telegram.actionUrl);
    });

    it("telegram openUrl is null when not configured", async () => {
      const res = await GET(getReq(), { params: params() });
      const json = (await res.json()) as GatewaysJson;
      expect(gatewayRow(json, "telegram").openUrl).toBeNull();
    });

    it("never leaks platformUserId into the response", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        {
          platform: "telegram",
          platformUserId: "999888777",
          displayName: "Ben",
        },
      ] as never);
      const res = await GET(getReq(), { params: params() });
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain("999888777");
      expect(text).not.toContain("platformUserId");
    });
  });
});
