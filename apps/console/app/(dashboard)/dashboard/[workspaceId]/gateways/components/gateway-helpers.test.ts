import { describe, expect, it } from "vitest";
import { telegramDeepLink } from "../../../../../../lib/telegram-bot";
import {
  GATEWAY_CATALOG,
  connectedSummaryLine,
  isGatewayConfigured,
  projectGateways,
  withInstallWorkspace,
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

  // Slack's twins of the two discord edge cases above. Both channels share
  // one `isTrue`/`resolvedGatewayEnvValue` path, so these are symmetry pins:
  // they'd catch a future per-channel special-case that skipped the gate.
  it("slack's CHANNEL_LIVE compare is trim + lowercase, matching _channel-cards.ts's isTrue", () => {
    expect(
      isGatewayConfigured("slack", {
        ...NO_ENV,
        slackInstallUrl: SLACK_URL,
        slackChannelLive: "  TRUE  ",
      })
    ).toBe(true);
    expect(
      isGatewayConfigured("slack", {
        ...NO_ENV,
        slackInstallUrl: SLACK_URL,
        slackChannelLive: "yes",
      })
    ).toBe(false);
  });

  it("slack's install URL is trimmed; whitespace-only counts as blank", () => {
    expect(
      isGatewayConfigured("slack", {
        ...NO_ENV,
        slackInstallUrl: "   ",
        slackChannelLive: "true",
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

// The install CTA has to tell the install route WHICH workspace is asking,
// or the completed install lands unattributed and the page that rendered the
// button can never learn it happened — the bug this whole change fixes.
describe("withInstallWorkspace", () => {
  const WS = "00000000-0000-0000-0000-000000000001";

  it("adds workspaceId to the slack install URL", () => {
    const url = new URL(
      withInstallWorkspace("https://app.example/api/v1/connectors/slack/install", "slack", WS)!
    );
    expect(url.searchParams.get("workspaceId")).toBe(WS);
  });

  it("preserves query params the owner already pasted into the env URL", () => {
    const url = new URL(
      withInstallWorkspace("https://app.example/install?foo=bar", "slack", WS)!
    );
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("workspaceId")).toBe(WS);
  });

  it("leaves every other kind's URL untouched — only slack's CTA hits our own install route", () => {
    expect(withInstallWorkspace(DISCORD_URL, "discord", WS)).toBe(DISCORD_URL);
    expect(withInstallWorkspace("https://t.me/jace_bot", "telegram", WS)).toBe(
      "https://t.me/jace_bot"
    );
  });

  it("passes a null actionUrl straight through", () => {
    expect(withInstallWorkspace(null, "slack", WS)).toBeNull();
  });

  it("returns the URL unchanged rather than throwing on a malformed env value", () => {
    expect(withInstallWorkspace("not a url", "slack", WS)).toBe("not a url");
  });
});

// What a CONNECTED slack card says when the workspace has installed the app
// but nobody has messaged Jace yet — the state that previously could not even
// be reached, and where `linkedIdentitiesLine([])` would have said "0 linked".
describe("connectedSummaryLine", () => {
  it("summarizes linked identities when there are any", () => {
    expect(
      connectedSummaryLine({
        linkedIdentities: [{ displayName: "Ben" }],
        installedTeamNames: [],
      })
    ).toBe("Linked: Ben");
  });

  it("names the installed Slack team when the app is installed but nobody has messaged yet", () => {
    expect(
      connectedSummaryLine({
        linkedIdentities: [],
        installedTeamNames: ["HeyJace"],
      })
    ).toBe("Installed in HeyJace");
  });

  it("falls back to a nameless phrasing when Slack sent no team name", () => {
    expect(
      connectedSummaryLine({
        linkedIdentities: [],
        installedTeamNames: [null],
      })
    ).toBe("Installed in your Slack workspace");
  });

  it("lists multiple installed teams", () => {
    expect(
      connectedSummaryLine({
        linkedIdentities: [],
        installedTeamNames: ["HeyJace", "Acme"],
      })
    ).toBe("Installed in HeyJace, Acme");
  });

  it("prefers the identities line once someone has actually messaged — that is the stronger signal", () => {
    expect(
      connectedSummaryLine({
        linkedIdentities: [{ displayName: "Ben" }],
        installedTeamNames: ["HeyJace"],
      })
    ).toBe("Linked: Ben");
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

  // ------------------------------------------------------------------- //
  // Slack installs (bugfix: "Add to Slack" never went away). Slack's connect
  // act is the OAuth install, which writes a `slack_installations` row — NOT
  // a chat identity. Before this, the projection only ever looked at chat
  // identities, so a workspace that had completed the install and been shown
  // Slack's own "Jace is connected" page still projected `disconnected`, and
  // the panel kept rendering the install CTA forever.
  // ------------------------------------------------------------------- //
  describe("slack installations", () => {
    const SLACK_ENV: GatewayEnv = {
      ...NO_ENV,
      slackInstallUrl: SLACK_URL,
      slackChannelLive: "true",
    };

    it("marks slack connected from a live installation alone, with no chat identity yet", () => {
      const slack = projectGateways([], SLACK_ENV, [
        { teamId: "T123", teamName: "Acme" },
      ]).find((r) => r.kind === "slack")!;
      expect(slack.status).toBe("connected");
      expect(slack.linkedIdentities).toEqual([]);
    });

    it("reports the installed team names so the card can name what it is connected to", () => {
      const slack = projectGateways([], SLACK_ENV, [
        { teamId: "T123", teamName: "Acme" },
        { teamId: "T456", teamName: null },
      ]).find((r) => r.kind === "slack")!;
      expect(slack.installedTeamNames).toEqual(["Acme", null]);
    });

    it("leaves slack disconnected when this workspace has no installation", () => {
      const slack = projectGateways([], SLACK_ENV, []).find(
        (r) => r.kind === "slack"
      )!;
      expect(slack.status).toBe("disconnected");
      expect(slack.installedTeamNames).toEqual([]);
    });

    it("never lets an installation connect a kind other than slack", () => {
      const rows = projectGateways([], NO_ENV, [
        { teamId: "T123", teamName: "Acme" },
      ]);
      for (const row of rows) {
        if (row.kind === "slack") continue;
        expect(row.status).toBe("disconnected");
        expect(row.installedTeamNames).toEqual([]);
      }
    });

    it("still connects slack from a linked chat identity when there is no installation row", () => {
      const slack = projectGateways(
        [{ platform: "slack", displayName: "Ben" }],
        SLACK_ENV,
        []
      ).find((r) => r.kind === "slack")!;
      expect(slack.status).toBe("connected");
    });
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
