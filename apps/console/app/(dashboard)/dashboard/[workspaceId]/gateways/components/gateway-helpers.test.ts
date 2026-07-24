import { describe, expect, it } from "vitest";
import { telegramDeepLink } from "../../../../../../lib/telegram-bot";
import {
  GATEWAY_CATALOG,
  isGatewayConfigured,
  projectGateways,
  type GatewayEnv,
  type GatewayIdentity,
} from "./gateway-helpers";

const NO_ENV: GatewayEnv = {
  telegramBotUsername: undefined,
  discordInviteUrl: undefined,
  discordChannelLive: undefined,
  slackInstallUrl: undefined,
  slackChannelLive: undefined,
};

const DISCORD_URL = "https://discord.com/oauth2/authorize?client_id=999";
const SLACK_URL =
  "https://slack.com/oauth/v2/authorize?client_id=abc&scope=chat:write";

describe("GATEWAY_CATALOG", () => {
  it("orders telegram, discord, slack (available) then imessage, whatsapp (planned) — render order", () => {
    expect(GATEWAY_CATALOG.map((g) => g.kind)).toEqual([
      "telegram",
      "discord",
      "slack",
      "imessage",
      "whatsapp",
    ]);
  });

  it("marks telegram/discord/slack available and imessage/whatsapp planned", () => {
    const availability = Object.fromEntries(
      GATEWAY_CATALOG.map((g) => [g.kind, g.availability])
    );
    expect(availability).toEqual({
      telegram: "available",
      discord: "available",
      slack: "available",
      imessage: "planned",
      whatsapp: "planned",
    });
  });

  it("carries one honest description line per gateway", () => {
    const byKind = Object.fromEntries(GATEWAY_CATALOG.map((g) => [g.kind, g]));
    expect(byKind["telegram"]!.description).toBe(
      "Chat with Jace in a Telegram DM."
    );
    expect(byKind["discord"]!.description).toBe(
      "Chat with Jace in your Discord server."
    );
    expect(byKind["slack"]!.description).toBe("Chat with Jace in Slack.");
    expect(byKind["imessage"]!.description).toBe(
      "Chat with Jace from Messages."
    );
    expect(byKind["whatsapp"]!.description).toBe("Chat with Jace on WhatsApp.");
  });

  it("carries no credential metadata of any kind on any entry", () => {
    for (const entry of GATEWAY_CATALOG) {
      expect(entry).not.toHaveProperty("connect");
      expect(entry).not.toHaveProperty("credentialLabel");
      expect(entry).not.toHaveProperty("connectMethod");
    }
  });
});

describe("isGatewayConfigured", () => {
  it("telegram is configured iff NEXT_PUBLIC_TELEGRAM_BOT_USERNAME is non-blank — no live-gate (already prod-verified)", () => {
    expect(isGatewayConfigured("telegram", NO_ENV)).toBe(false);
    expect(
      isGatewayConfigured("telegram", { ...NO_ENV, telegramBotUsername: "" })
    ).toBe(false);
    expect(
      isGatewayConfigured("telegram", { ...NO_ENV, telegramBotUsername: "   " })
    ).toBe(false);
    expect(
      isGatewayConfigured("telegram", {
        ...NO_ENV,
        telegramBotUsername: "jace_bot",
      })
    ).toBe(true);
  });

  it("discord: the invite URL alone is not enough — CHANNEL_LIVE must also be set", () => {
    expect(
      isGatewayConfigured("discord", { ...NO_ENV, discordInviteUrl: DISCORD_URL })
    ).toBe(false);
  });

  it("discord: CHANNEL_LIVE alone (no URL) is not enough either", () => {
    expect(
      isGatewayConfigured("discord", { ...NO_ENV, discordChannelLive: "true" })
    ).toBe(false);
  });

  it("discord is configured once BOTH the invite URL is non-blank and CHANNEL_LIVE is exactly \"true\"", () => {
    expect(
      isGatewayConfigured("discord", {
        ...NO_ENV,
        discordInviteUrl: DISCORD_URL,
        discordChannelLive: "true",
      })
    ).toBe(true);
  });

  it("discord's CHANNEL_LIVE compare is trim + lowercase, matching _channel-cards.ts's isTrue", () => {
    expect(
      isGatewayConfigured("discord", {
        ...NO_ENV,
        discordInviteUrl: DISCORD_URL,
        discordChannelLive: "  TRUE  ",
      })
    ).toBe(true);
    expect(
      isGatewayConfigured("discord", {
        ...NO_ENV,
        discordInviteUrl: DISCORD_URL,
        discordChannelLive: "yes",
      })
    ).toBe(false);
  });

  it("discord's invite URL is trimmed; whitespace-only counts as blank", () => {
    expect(
      isGatewayConfigured("discord", {
        ...NO_ENV,
        discordInviteUrl: "   ",
        discordChannelLive: "true",
      })
    ).toBe(false);
  });

  it("slack: the install URL alone is not enough — CHANNEL_LIVE must also be set", () => {
    expect(
      isGatewayConfigured("slack", { ...NO_ENV, slackInstallUrl: SLACK_URL })
    ).toBe(false);
  });

  it("slack: CHANNEL_LIVE alone (no URL) is not enough either", () => {
    expect(
      isGatewayConfigured("slack", { ...NO_ENV, slackChannelLive: "true" })
    ).toBe(false);
  });

  it("slack is configured once BOTH the install URL is non-blank and CHANNEL_LIVE is exactly \"true\"", () => {
    expect(
      isGatewayConfigured("slack", {
        ...NO_ENV,
        slackInstallUrl: SLACK_URL,
        slackChannelLive: "true",
      })
    ).toBe(true);
  });

  it("imessage and whatsapp are never configured, regardless of env", () => {
    const fullEnv: GatewayEnv = {
      telegramBotUsername: "jace_bot",
      discordInviteUrl: DISCORD_URL,
      discordChannelLive: "true",
      slackInstallUrl: SLACK_URL,
      slackChannelLive: "true",
    };
    expect(isGatewayConfigured("imessage", fullEnv)).toBe(false);
    expect(isGatewayConfigured("whatsapp", fullEnv)).toBe(false);
  });
});

describe("projectGateways", () => {
  it("returns one row per catalog entry, in catalog order", () => {
    const rows = projectGateways([], NO_ENV);
    expect(rows.map((r) => r.kind)).toEqual([
      "telegram",
      "discord",
      "slack",
      "imessage",
      "whatsapp",
    ]);
  });

  it("marks an available gateway connected when it has >=1 linked identity for its platform", () => {
    const identities: GatewayIdentity[] = [
      { platform: "telegram", displayName: "Ben" },
    ];
    const telegram = projectGateways(identities, NO_ENV).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.status).toBe("connected");
    expect(telegram.linkedIdentities).toEqual([{ displayName: "Ben" }]);
  });

  it("treats a kind with no linked identity as disconnected, with empty linkedIdentities", () => {
    const telegram = projectGateways([], NO_ENV).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.status).toBe("disconnected");
    expect(telegram.linkedIdentities).toEqual([]);
  });

  it("never connects a planned gateway (imessage/whatsapp) even with a linked identity for its platform", () => {
    const identities: GatewayIdentity[] = [
      { platform: "imessage", displayName: "Ben" },
      { platform: "whatsapp", displayName: "Ben" },
    ];
    const rows = projectGateways(identities, NO_ENV);
    expect(rows.find((r) => r.kind === "imessage")!.status).toBe(
      "disconnected"
    );
    expect(rows.find((r) => r.kind === "whatsapp")!.status).toBe(
      "disconnected"
    );
  });

  it("still carries linkedIdentities for a planned kind even though status stays disconnected (mirrors projectConnectors)", () => {
    const identities: GatewayIdentity[] = [
      { platform: "imessage", displayName: "Ben" },
    ];
    const imessage = projectGateways(identities, NO_ENV).find(
      (r) => r.kind === "imessage"
    )!;
    expect(imessage.status).toBe("disconnected");
    expect(imessage.linkedIdentities).toEqual([{ displayName: "Ben" }]);
  });

  it("preserves a null display name in linkedIdentities", () => {
    const identities: GatewayIdentity[] = [
      { platform: "telegram", displayName: "Ben" },
      { platform: "telegram", displayName: null },
    ];
    const telegram = projectGateways(identities, NO_ENV).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.linkedIdentities).toEqual([
      { displayName: "Ben" },
      { displayName: null },
    ]);
  });

  it("never populates linkedIdentities for a platform string outside the 5-gateway catalog", () => {
    const identities: GatewayIdentity[] = [{ platform: "github", displayName: "x" }];
    const rows = projectGateways(identities, NO_ENV);
    for (const row of rows) {
      expect(row.linkedIdentities).toEqual([]);
    }
  });

  it("actionUrl is null when not configured, even though available", () => {
    const telegram = projectGateways([], NO_ENV).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.configured).toBe(false);
    expect(telegram.actionUrl).toBeNull();
  });

  it("actionUrl is the telegram deep link when available+configured", () => {
    const env: GatewayEnv = { ...NO_ENV, telegramBotUsername: "jace_bot" };
    const telegram = projectGateways([], env).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.configured).toBe(true);
    expect(telegram.actionUrl).toBe(telegramDeepLink("jace_bot"));
  });

  it("actionUrl is the discord invite URL VERBATIM (not built in code) when available+configured", () => {
    const env: GatewayEnv = {
      ...NO_ENV,
      discordInviteUrl: DISCORD_URL,
      discordChannelLive: "true",
    };
    const discord = projectGateways([], env).find((r) => r.kind === "discord")!;
    expect(discord.configured).toBe(true);
    expect(discord.actionUrl).toBe(DISCORD_URL);
  });

  it("actionUrl stays null for discord when the URL is set but not live-verified", () => {
    const env: GatewayEnv = { ...NO_ENV, discordInviteUrl: DISCORD_URL };
    const discord = projectGateways([], env).find((r) => r.kind === "discord")!;
    expect(discord.configured).toBe(false);
    expect(discord.actionUrl).toBeNull();
  });

  it("actionUrl is the slack install URL VERBATIM (not built in code) when available+configured", () => {
    const env: GatewayEnv = {
      ...NO_ENV,
      slackInstallUrl: SLACK_URL,
      slackChannelLive: "true",
    };
    const slack = projectGateways([], env).find((r) => r.kind === "slack")!;
    expect(slack.configured).toBe(true);
    expect(slack.actionUrl).toBe(SLACK_URL);
  });

  it("actionUrl stays null for slack when the URL is set but not live-verified", () => {
    const env: GatewayEnv = { ...NO_ENV, slackInstallUrl: SLACK_URL };
    const slack = projectGateways([], env).find((r) => r.kind === "slack")!;
    expect(slack.configured).toBe(false);
    expect(slack.actionUrl).toBeNull();
  });

  it("actionUrl stays null for a planned gateway no matter what — imessage/whatsapp are never configured", () => {
    const rows = projectGateways([], NO_ENV);
    expect(rows.find((r) => r.kind === "imessage")!.actionUrl).toBeNull();
    expect(rows.find((r) => r.kind === "whatsapp")!.actionUrl).toBeNull();
  });

  it("carries the catalog's label/description/availability through to the view", () => {
    const telegram = projectGateways([], NO_ENV).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.label).toBe("Telegram");
    expect(telegram.description).toBe("Chat with Jace in a Telegram DM.");
    expect(telegram.availability).toBe("available");
  });

  describe("openUrl (whole-branch review fix 1 — distinct from actionUrl)", () => {
    it("is the t.me deep link for telegram when configured, matching actionUrl", () => {
      const env: GatewayEnv = { ...NO_ENV, telegramBotUsername: "jace_bot" };
      const telegram = projectGateways([], env).find(
        (r) => r.kind === "telegram"
      )!;
      expect(telegram.openUrl).toBe(telegramDeepLink("jace_bot"));
      expect(telegram.openUrl).toBe(telegram.actionUrl);
    });

    it("is null for telegram when not configured", () => {
      const telegram = projectGateways([], NO_ENV).find(
        (r) => r.kind === "telegram"
      )!;
      expect(telegram.openUrl).toBeNull();
    });

    it("is null for discord even when fully configured — the env URL is an install link, not a conversation link", () => {
      const env: GatewayEnv = {
        ...NO_ENV,
        discordInviteUrl: DISCORD_URL,
        discordChannelLive: "true",
      };
      const discord = projectGateways([], env).find(
        (r) => r.kind === "discord"
      )!;
      expect(discord.configured).toBe(true);
      expect(discord.actionUrl).not.toBeNull();
      expect(discord.openUrl).toBeNull();
    });

    it("is null for slack even when fully configured — the env URL is an install link, not a conversation link", () => {
      const env: GatewayEnv = {
        ...NO_ENV,
        slackInstallUrl: SLACK_URL,
        slackChannelLive: "true",
      };
      const slack = projectGateways([], env).find((r) => r.kind === "slack")!;
      expect(slack.configured).toBe(true);
      expect(slack.actionUrl).not.toBeNull();
      expect(slack.openUrl).toBeNull();
    });

    it("is null for planned gateways regardless of env", () => {
      const rows = projectGateways([], NO_ENV);
      expect(rows.find((r) => r.kind === "imessage")!.openUrl).toBeNull();
      expect(rows.find((r) => r.kind === "whatsapp")!.openUrl).toBeNull();
    });
  });
});
