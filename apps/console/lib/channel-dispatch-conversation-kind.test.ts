import { describe, expect, it } from "vitest";
import { conversationKind } from "./channel-dispatch";

/**
 * `conversationKind` (spec §9 slice 0) — hoists group-vs-DM to a first-class
 * fact at the dispatch seam so a later slice's per-person seat gate can read
 * it without re-deriving each channel's own admission-gate proxy. Pure, no
 * I/O — no mocking needed here, unlike `channel-dispatch.test.ts`'s
 * `processRow` suite.
 *
 * Every channel's extracted payload carries `chatId`/`text` regardless of
 * channel (see `TelegramInboxPayload`'s own doc-comment: the name predates
 * Discord/Slack support but the shape is shared) — this helper supplies
 * those two so each row below only has to specify the field it's actually
 * exercising.
 */
function payload(
  overrides: {
    chatType?: string;
    threadTs?: string;
    threadId?: string | null;
  } = {}
) {
  return { chatId: 1, text: "hi", ...overrides };
}

describe("conversationKind", () => {
  it.each([
    // Telegram: payload.chatType — group|supergroup|channel -> "group",
    // private or a missing/unrecognized value -> "dm".
    ["telegram, chatType=private", "telegram", payload({ chatType: "private" }), "dm"],
    ["telegram, chatType=group", "telegram", payload({ chatType: "group" }), "group"],
    ["telegram, chatType=supergroup", "telegram", payload({ chatType: "supergroup" }), "group"],
    ["telegram, chatType=channel", "telegram", payload({ chatType: "channel" }), "group"],
    ["telegram, chatType missing", "telegram", payload(), "dm"],

    // Slack: mirrors buildThreadInbound's existing isDM
    // (threadTs === undefined) verbatim.
    ["slack, threadTs present", "slack", payload({ threadTs: "1690000000.000100" }), "group"],
    ["slack, threadTs absent", "slack", payload(), "dm"],

    // Discord: mirrors buildThreadInbound's existing isDM VERBATIM
    // (threadId === undefined || threadId === null) — every branch that
    // ternary can take.
    ["discord, threadId undefined", "discord", payload(), "dm"],
    ["discord, threadId null", "discord", payload({ threadId: null }), "dm"],
    ["discord, threadId a real string", "discord", payload({ threadId: "T1" }), "group"],

    // Console: always "dm" — no group concept on this channel. Throw every
    // other channel's group signal at it in one row to prove payload
    // contents are irrelevant here.
    [
      "console, ignores payload entirely",
      "console",
      payload({ chatType: "group", threadTs: "x", threadId: "y" }),
      "dm",
    ],
  ] as const)("%s -> %s", (_label, channel, p, expected) => {
    expect(conversationKind(channel, p)).toBe(expected);
  });
});
