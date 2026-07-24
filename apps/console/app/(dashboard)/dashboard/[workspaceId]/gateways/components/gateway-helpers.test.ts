import { describe, expect, it } from "vitest";
import { telegramDeepLink } from "../../../../../../lib/telegram-bot";
import {
  DISCORD_SEND_MESSAGES_PERMISSION,
  GATEWAY_CATALOG,
  discordInviteUrl,
  isGatewayConfigured,
  projectGateways,
  slackInstallUrl,
  type GatewayEnv,
  type GatewayIdentity,
} from "./gateway-helpers";

const NO_ENV: GatewayEnv = {
  telegramBotUsername: undefined,
  discordClientId: undefined,
  slackClientId: undefined,
};

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
  it("telegram is configured iff NEXT_PUBLIC_TELEGRAM_BOT_USERNAME is non-blank", () => {
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

  it("discord is configured iff NEXT_PUBLIC_DISCORD_CLIENT_ID is non-blank", () => {
    expect(isGatewayConfigured("discord", NO_ENV)).toBe(false);
    expect(
      isGatewayConfigured("discord", { ...NO_ENV, discordClientId: "   " })
    ).toBe(false);
    expect(
      isGatewayConfigured("discord", { ...NO_ENV, discordClientId: "123" })
    ).toBe(true);
  });

  it("slack is configured iff NEXT_PUBLIC_SLACK_CLIENT_ID is non-blank", () => {
    expect(isGatewayConfigured("slack", NO_ENV)).toBe(false);
    expect(
      isGatewayConfigured("slack", { ...NO_ENV, slackClientId: "   " })
    ).toBe(false);
    expect(
      isGatewayConfigured("slack", { ...NO_ENV, slackClientId: "abc.123" })
    ).toBe(true);
  });

  it("imessage and whatsapp are never configured, regardless of env", () => {
    const fullEnv: GatewayEnv = {
      telegramBotUsername: "jace_bot",
      discordClientId: "123",
      slackClientId: "abc",
    };
    expect(isGatewayConfigured("imessage", fullEnv)).toBe(false);
    expect(isGatewayConfigured("whatsapp", fullEnv)).toBe(false);
  });
});

describe("discordInviteUrl", () => {
  it("builds the OAuth2 authorize URL: bot+applications.commands scopes, Send-Messages-only permissions", () => {
    const url = discordInviteUrl("123456789012345678");
    expect(url).toBe(
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=2048"
    );
  });

  it("pins the permissions constant to SEND_MESSAGES only (bit 1<<11 = decimal 2048)", () => {
    expect(DISCORD_SEND_MESSAGES_PERMISSION).toBe(2048);
  });
});

describe("slackInstallUrl", () => {
  it("builds the OAuth v2 authorize URL with the events door's bot scopes, comma-separated", () => {
    // ":" and "," are left unescaped — both are valid unencoded in a URI
    // query component (RFC 3986 pchar / sub-delims) and this is exactly the
    // shape Slack's own docs show (e.g. "scope=incoming-webhook,commands").
    const url = slackInstallUrl("33336676.569200954261");
    expect(url).toBe(
      "https://slack.com/oauth/v2/authorize?client_id=33336676.569200954261&scope=chat:write,im:history,im:read,im:write"
    );
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

  it("actionUrl is the discord invite URL when available+configured", () => {
    const env: GatewayEnv = { ...NO_ENV, discordClientId: "999" };
    const discord = projectGateways([], env).find((r) => r.kind === "discord")!;
    expect(discord.configured).toBe(true);
    expect(discord.actionUrl).toBe(discordInviteUrl("999"));
  });

  it("actionUrl is the slack install URL when available+configured", () => {
    const env: GatewayEnv = { ...NO_ENV, slackClientId: "abc" };
    const slack = projectGateways([], env).find((r) => r.kind === "slack")!;
    expect(slack.configured).toBe(true);
    expect(slack.actionUrl).toBe(slackInstallUrl("abc"));
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
});
