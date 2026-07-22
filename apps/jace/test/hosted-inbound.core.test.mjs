import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHostedInbound,
  HOSTED_INBOUND_CHANNELS,
} from "../agent/lib/hosted_inbound.core.mjs";

test("normalizeHostedInbound accepts a valid minimal payload", () => {
  const out = normalizeHostedInbound({
    message: "hello jace",
    target: { chatId: 555 },
    auth: { authenticator: "agentrail", principalType: "service", principalId: "chat-identity-1" },
  });
  assert.deepEqual(out, {
    channel: "telegram",
    message: "hello jace",
    target: { chatId: 555 },
    auth: { authenticator: "agentrail", principalType: "service", principalId: "chat-identity-1" },
  });
});

// --- #1284/#1285: multi-channel generalization ------------------------------

test("`channel` absent defaults to 'telegram' — every pre-#1284 caller never sent this field", () => {
  const out = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: {} });
  assert.equal(out.channel, "telegram");
});

test("accepts an explicit channel: 'discord' with a channelId target", () => {
  const out = normalizeHostedInbound({
    channel: "discord",
    message: "hi from discord",
    target: { channelId: "123456789" },
    auth: {},
  });
  assert.deepEqual(out, {
    channel: "discord",
    message: "hi from discord",
    target: { channelId: "123456789" },
    auth: {},
  });
});

test("accepts an explicit channel: 'slack' with a channelId target", () => {
  const out = normalizeHostedInbound({
    channel: "slack",
    message: "hi from slack",
    target: { channelId: "D0PNCRP9N" },
    auth: {},
  });
  assert.deepEqual(out, {
    channel: "slack",
    message: "hi from slack",
    target: { channelId: "D0PNCRP9N" },
    auth: {},
  });
});

test("rejects an unknown channel", () => {
  assert.throws(
    () => normalizeHostedInbound({ channel: "carrier-pigeon", message: "hi", target: {}, auth: {} }),
    /unknown channel 'carrier-pigeon'/,
  );
});

test("a discord/slack payload keyed on chatId (the telegram field name) is rejected — the channel's OWN target key is required, not a generic one", () => {
  assert.throws(
    () => normalizeHostedInbound({ channel: "discord", message: "hi", target: { chatId: 1 }, auth: {} }),
    /`target\.channelId` is required/,
  );
});

test("HOSTED_INBOUND_CHANNELS includes telegram, discord, and slack", () => {
  assert.ok(HOSTED_INBOUND_CHANNELS.includes("telegram"));
  assert.ok(HOSTED_INBOUND_CHANNELS.includes("discord"));
  assert.ok(HOSTED_INBOUND_CHANNELS.includes("slack"));
});

test("normalizeHostedInbound trims the message", () => {
  const out = normalizeHostedInbound({
    message: "  spaced  ",
    target: { chatId: 1 },
    auth: {},
  });
  assert.equal(out.message, "spaced");
});

test("normalizeHostedInbound rejects a non-object payload", () => {
  assert.throws(() => normalizeHostedInbound(null), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound("nope"), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound([1, 2]), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound(undefined), /must be a JSON object/);
});

test("normalizeHostedInbound rejects a missing / blank message", () => {
  assert.throws(
    () => normalizeHostedInbound({ target: { chatId: 1 }, auth: {} }),
    /`message` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "   ", target: { chatId: 1 }, auth: {} }),
    /`message` is required/,
  );
});

test("normalizeHostedInbound rejects a non-object target", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", auth: {} }),
    /`target` must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: "555", auth: {} }),
    /`target` must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: [1], auth: {} }),
    /`target` must be an object/,
  );
});

test("normalizeHostedInbound rejects a target missing chatId (Eve's telegram receive hook throws without it)", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: {}, auth: {} }),
    /`target\.chatId` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: "  " }, auth: {} }),
    /`target\.chatId` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: null }, auth: {} }),
    /`target\.chatId` is required/,
  );
});

test("normalizeHostedInbound accepts a numeric or string chatId, passed through unchanged", () => {
  const numeric = normalizeHostedInbound({ message: "hi", target: { chatId: 555 }, auth: {} });
  assert.equal(numeric.target.chatId, 555);

  const stringy = normalizeHostedInbound({ message: "hi", target: { chatId: "555" }, auth: {} });
  assert.equal(stringy.target.chatId, "555");
});

test("normalizeHostedInbound keeps conversationId when present, omits when absent", () => {
  const withConvo = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, conversationId: 42 },
    auth: {},
  });
  assert.deepEqual(withConvo.target, { chatId: 1, conversationId: 42 });

  const withoutConvo = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: {} });
  assert.equal("conversationId" in withoutConvo.target, false);
});

test("normalizeHostedInbound keeps messageThreadId when present, omits when absent", () => {
  const withThread = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, messageThreadId: 7 },
    auth: {},
  });
  assert.deepEqual(withThread.target, { chatId: 1, messageThreadId: 7 });

  const withoutThread = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: {} });
  assert.equal("messageThreadId" in withoutThread.target, false);
});

test("normalizeHostedInbound drops stray target keys (minimal target, matches run_outcome.core's convention)", () => {
  const out = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, botToken: "SECRET", somethingElse: "x" },
    auth: {},
  });
  assert.deepEqual(out.target, { chatId: 1 });
});

test("normalizeHostedInbound rejects a missing auth (auth is required, unlike run-outcome's optional auth)", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 } }),
    /`auth` is required/,
  );
});

test("normalizeHostedInbound rejects an explicit null auth", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: null }),
    /`auth` is required/,
  );
});

test("normalizeHostedInbound rejects a non-object auth", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: "chat-identity-1" }),
    /`auth`.*must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: [1, 2] }),
    /`auth`.*must be an object/,
  );
});

test("normalizeHostedInbound passes auth through UNCHANGED (deep, not just present)", () => {
  const auth = {
    authenticator: "agentrail",
    principalType: "service",
    principalId: "ws-1",
    attributes: { chatIdentityId: "chat-1", workspaceId: "ws-1", channel: "telegram", conversationKey: "555" },
  };
  const out = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth });
  assert.deepEqual(out.auth, auth);
});

// --- #1288: console's compound target (workspaceId + conversationKey) ------

test("accepts an explicit channel: 'console' with a {workspaceId, conversationKey} target", () => {
  const out = normalizeHostedInbound({
    channel: "console",
    message: "hi from console",
    target: { workspaceId: "ws-1", conversationKey: "console:user-1:1" },
    auth: {},
  });
  assert.deepEqual(out, {
    channel: "console",
    message: "hi from console",
    target: { workspaceId: "ws-1", conversationKey: "console:user-1:1" },
    auth: {},
  });
});

test("HOSTED_INBOUND_CHANNELS includes console alongside telegram/discord/slack", () => {
  assert.ok(HOSTED_INBOUND_CHANNELS.includes("console"));
  assert.ok(HOSTED_INBOUND_CHANNELS.includes("telegram"));
});

test("console rejects a target missing workspaceId", () => {
  assert.throws(
    () =>
      normalizeHostedInbound({
        channel: "console",
        message: "hi",
        target: { conversationKey: "console:user-1:1" },
        auth: {},
      }),
    /`target\.workspaceId` is required/,
  );
});

test("console rejects a target missing conversationKey", () => {
  assert.throws(
    () =>
      normalizeHostedInbound({
        channel: "console",
        message: "hi",
        target: { workspaceId: "ws-1" },
        auth: {},
      }),
    /`target\.conversationKey` is required/,
  );
});

test("console rejects blank-string workspaceId/conversationKey", () => {
  assert.throws(
    () =>
      normalizeHostedInbound({
        channel: "console",
        message: "hi",
        target: { workspaceId: "   ", conversationKey: "console:user-1:1" },
        auth: {},
      }),
    /`target\.workspaceId` is required/,
  );
  assert.throws(
    () =>
      normalizeHostedInbound({
        channel: "console",
        message: "hi",
        target: { workspaceId: "ws-1", conversationKey: "  " },
        auth: {},
      }),
    /`target\.conversationKey` is required/,
  );
});

test("console's normalized target never carries a stray chatId/channelId even if present in the raw payload", () => {
  const out = normalizeHostedInbound({
    channel: "console",
    message: "hi",
    target: { workspaceId: "ws-1", conversationKey: "console:user-1:1", chatId: 999, channelId: "x" },
    auth: {},
  });
  assert.deepEqual(out.target, { workspaceId: "ws-1", conversationKey: "console:user-1:1" });
});

test("a telegram payload keyed on workspaceId (console's field name) is rejected — console does not fall back to the generic TARGET_KEY", () => {
  assert.throws(
    () =>
      normalizeHostedInbound({
        channel: "telegram",
        message: "hi",
        target: { workspaceId: "ws-1", conversationKey: "console:user-1:1" },
        auth: {},
      }),
    /`target\.chatId` is required/,
  );
});
