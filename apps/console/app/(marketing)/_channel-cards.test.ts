import { describe, expect, it } from "vitest";
import { resolveDiscordChannelCard } from "./_channel-cards";

describe("resolveDiscordChannelCard", () => {
  it("returns null when neither env var is set (the default, pre-verification state)", () => {
    expect(resolveDiscordChannelCard({ live: undefined, inviteUrl: undefined })).toBeNull();
  });

  it("returns null when the invite URL is set but the channel is not flagged live — code-complete is not the same as verified", () => {
    expect(
      resolveDiscordChannelCard({ live: undefined, inviteUrl: "https://discord.com/oauth2/authorize?x" })
    ).toBeNull();
  });

  it("returns null when flagged live but no invite URL is configured (never a dead link)", () => {
    expect(resolveDiscordChannelCard({ live: "true", inviteUrl: undefined })).toBeNull();
  });

  it("returns null when flagged live with a blank invite URL", () => {
    expect(resolveDiscordChannelCard({ live: "true", inviteUrl: "   " })).toBeNull();
  });

  it("resolves the card only when BOTH live=true and an invite URL are present", () => {
    const card = resolveDiscordChannelCard({
      live: "true",
      inviteUrl: "https://discord.com/oauth2/authorize?client_id=123",
    });
    expect(card).toEqual({
      id: "discord",
      label: "Message Jace on Discord",
      href: "https://discord.com/oauth2/authorize?client_id=123",
    });
  });

  it("treats any non-'true' value (including 'false', '1', mixed case typos) as not live", () => {
    expect(resolveDiscordChannelCard({ live: "false", inviteUrl: "https://x" })).toBeNull();
    expect(resolveDiscordChannelCard({ live: "1", inviteUrl: "https://x" })).toBeNull();
    expect(resolveDiscordChannelCard({ live: "TRUE ", inviteUrl: "https://x" })).toEqual(
      expect.objectContaining({ id: "discord" })
    );
  });
});
