import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRunOutcome,
  RUN_OUTCOME_CHANNELS,
  TARGET_KEY,
} from "../agent/lib/run_outcome.core.mjs";

test("normalizeRunOutcome accepts a valid telegram payload", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "AgentRail: PR ready — issue #42",
    target: { chatId: "12345" },
  });
  assert.deepEqual(out, {
    channel: "telegram",
    message: "AgentRail: PR ready — issue #42",
    target: { chatId: "12345" },
  });
});

test("normalizeRunOutcome accepts a valid discord payload (channelId)", () => {
  const out = normalizeRunOutcome({
    channel: "discord",
    message: "AgentRail: Blocked — issue #7",
    target: { channelId: "C0123" },
  });
  assert.equal(out.channel, "discord");
  assert.deepEqual(out.target, { channelId: "C0123" });
});

test("normalizeRunOutcome accepts a valid slack payload (channelId)", () => {
  const out = normalizeRunOutcome({
    channel: "slack",
    message: "AgentRail: PR ready — issue #99",
    target: { channelId: "C0SLACK" },
  });
  assert.equal(out.channel, "slack");
  assert.deepEqual(out.target, { channelId: "C0SLACK" });
});

test("normalizeRunOutcome recognizes imessage and normalizes its handle target", () => {
  // imessage is recognized by the core (valid channel + `handle` target key)
  // even though the run-outcome wrapper leaves it UNWIRED (no native Eve module
  // yet). At the wrapper this normalized payload draws a clean 400 "not wired";
  // at the core it is a well-formed, normalizable outcome.
  const out = normalizeRunOutcome({
    channel: "imessage",
    message: "AgentRail: Blocked — issue #12",
    target: { handle: "+15551234567", channelId: "ignored" },
  });
  assert.equal(out.channel, "imessage");
  // minimal target keeps only the `handle` key, dropping the stray channelId
  assert.deepEqual(out.target, { handle: "+15551234567" });
});

test("normalizeRunOutcome passes auth through when it is an object", () => {
  const auth = {
    authenticator: "agentrail",
    principalType: "service",
    principalId: "ws_1",
  };
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
    auth,
  });
  assert.deepEqual(out.auth, auth);
});

test("normalizeRunOutcome omits auth when absent", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
  });
  assert.equal("auth" in out, false);
});

test("normalizeRunOutcome drops extra / secret target fields (minimal target)", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1", botToken: "SECRET", threadId: "x" },
  });
  assert.deepEqual(out.target, { chatId: "1" });
});

test("normalizeRunOutcome trims message and destination", () => {
  const out = normalizeRunOutcome({
    channel: "discord",
    message: "  spaced  ",
    target: { channelId: "  C1  " },
  });
  assert.equal(out.message, "spaced");
  assert.deepEqual(out.target, { channelId: "C1" });
});

test("normalizeRunOutcome coerces a numeric destination to string", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: 98765 },
  });
  assert.deepEqual(out.target, { chatId: "98765" });
});

test("normalizeRunOutcome rejects an unknown channel", () => {
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "carrier-pigeon",
        message: "hi",
        target: { chatId: "1" },
      }),
    /unknown channel 'carrier-pigeon'/,
  );
});

test("normalizeRunOutcome rejects a non-object payload", () => {
  assert.throws(() => normalizeRunOutcome(null), /must be a JSON object/);
  assert.throws(() => normalizeRunOutcome("nope"), /must be a JSON object/);
  assert.throws(() => normalizeRunOutcome([1, 2]), /must be a JSON object/);
});

test("normalizeRunOutcome rejects a missing / blank message", () => {
  assert.throws(
    () => normalizeRunOutcome({ channel: "telegram", target: { chatId: "1" } }),
    /`message` is required/,
  );
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "telegram",
        message: "   ",
        target: { chatId: "1" },
      }),
    /`message` is required/,
  );
});

test("normalizeRunOutcome rejects a non-object target", () => {
  assert.throws(
    () => normalizeRunOutcome({ channel: "telegram", message: "hi" }),
    /`target` must be an object/,
  );
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "telegram",
        message: "hi",
        target: "12345",
      }),
    /`target` must be an object/,
  );
});

test("normalizeRunOutcome rejects a target missing the channel's key", () => {
  // telegram needs chatId, not channelId
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "telegram",
        message: "hi",
        target: { channelId: "C1" },
      }),
    /telegram target requires a non-empty 'chatId'/,
  );
  // blank value is rejected too
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "discord",
        message: "hi",
        target: { channelId: "   " },
      }),
    /discord target requires a non-empty 'channelId'/,
  );
});

test("normalizeRunOutcome rejects a non-object auth", () => {
  assert.throws(
    () =>
      normalizeRunOutcome({
        channel: "telegram",
        message: "hi",
        target: { chatId: "1" },
        auth: "ws_1",
      }),
    /`auth`, when present, must be an object/,
  );
});

test("every supported channel has a target key", () => {
  for (const ch of RUN_OUTCOME_CHANNELS) {
    assert.equal(
      typeof TARGET_KEY[ch],
      "string",
      `channel ${ch} must declare a target key`,
    );
  }
});
