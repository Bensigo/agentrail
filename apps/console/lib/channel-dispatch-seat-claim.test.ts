import { describe, expect, it } from "vitest";
import { decideSeatClaimForServedTurn } from "./channel-dispatch";

/**
 * `decideSeatClaimForServedTurn` (spec §5 rule 1, slice 4 Task 2) — the
 * pure subject-selection + skip decision behind the seat-claim hook
 * `processRow` fires on every SERVED chat turn. Pure, no I/O — no mocking
 * needed here, same convention as `channel-dispatch-conversation-kind.test.ts`'s
 * `conversationKind` suite (see that file's own doc-comment): a real,
 * unmocked import of `./channel-dispatch` is safe because this helper
 * touches neither `db` nor any network seam.
 *
 * What this does NOT cover (by design — it's impure, DB-backed, and the
 * brief's own instruction is to keep this suite harness-free): resolving
 * `billingAccountId` via `getBillingAccountIdForWorkspace` and the
 * null-account ("transitional workspace") skip that follows from it, or the
 * actual `claimSeat` call. Those live in `claimSeatForServedTurn`, exercised
 * indirectly through `processRow`/`processConsoleRow` — this file only
 * proves the decision this function makes BEFORE any of that I/O ever runs.
 */
describe("decideSeatClaimForServedTurn", () => {
  it("skips (returns null) when workspaceId is null — the 'intro' path, no workspace pinned yet", () => {
    const result = decideSeatClaimForServedTurn({
      workspaceId: null,
      channel: "telegram",
      identity: { userId: null, chatIdentityId: "chat-1" },
    });

    expect(result).toBeNull();
  });

  it("skips (returns null) for a channel this helper doesn't recognize as a chat channel — defensive, row.channel is a plain string, not a literal union", () => {
    const result = decideSeatClaimForServedTurn({
      workspaceId: "ws-1",
      channel: "console",
      identity: { userId: null, chatIdentityId: "chat-1" },
    });

    expect(result).toBeNull();
  });

  it("claims by userId when the chat identity is already linked to a console account", () => {
    const result = decideSeatClaimForServedTurn({
      workspaceId: "ws-1",
      channel: "telegram",
      identity: { userId: "user-1", chatIdentityId: "chat-1" },
    });

    expect(result).toEqual({
      workspaceId: "ws-1",
      subject: { userId: "user-1" },
      claimedVia: "telegram",
    });
  });

  it("claims by chatIdentityId when the identity is unlinked (no userId yet)", () => {
    const result = decideSeatClaimForServedTurn({
      workspaceId: "ws-1",
      channel: "telegram",
      identity: { userId: null, chatIdentityId: "chat-1" },
    });

    expect(result).toEqual({
      workspaceId: "ws-1",
      subject: { chatIdentityId: "chat-1" },
      claimedVia: "telegram",
    });
  });

  it.each(["telegram", "discord", "slack"] as const)(
    "recognizes %s and passes it through as claimedVia unchanged",
    (channel) => {
      const result = decideSeatClaimForServedTurn({
        workspaceId: "ws-1",
        channel,
        identity: { userId: "user-1", chatIdentityId: "chat-1" },
      });

      expect(result?.claimedVia).toBe(channel);
      expect(result?.workspaceId).toBe("ws-1");
    }
  );

  it("never returns both userId and chatIdentityId on the subject — exactly one key, matching SeatSubject's XOR contract", () => {
    const result = decideSeatClaimForServedTurn({
      workspaceId: "ws-1",
      channel: "discord",
      identity: { userId: "user-1", chatIdentityId: "chat-1" },
    });

    expect(Object.keys(result?.subject ?? {})).toEqual(["userId"]);
  });
});
