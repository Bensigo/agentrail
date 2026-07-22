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

test("normalizeRunOutcome normalizes an imessage handle target", () => {
  // imessage is a wired channel (Jace's LoopMessage channel, #1100). When the
  // caller does supply a handle it is kept (minimal — stray keys dropped).
  const out = normalizeRunOutcome({
    channel: "imessage",
    message: "AgentRail: Blocked — issue #12",
    target: { handle: "+15551234567", channelId: "ignored" },
  });
  assert.equal(out.channel, "imessage");
  // minimal target keeps only the `handle` key, dropping the stray channelId
  assert.deepEqual(out.target, { handle: "+15551234567" });
});

test("normalizeRunOutcome allows an EMPTY imessage target (handle resolved Jace-side)", () => {
  // imessage has no non-secret "channel id" the console can send — the recipient
  // is resolved Jace-side (LOOPMESSAGE_DEFAULT_RECIPIENT / last inbound contact),
  // so notifyIMessageViaJace posts an empty target. That must normalize cleanly
  // (empty target), NOT 400 like the other channels' missing key does.
  const out = normalizeRunOutcome({
    channel: "imessage",
    message: "AgentRail: PR ready — issue #12",
    target: {},
  });
  assert.equal(out.channel, "imessage");
  assert.deepEqual(out.target, {});
});

test("normalizeRunOutcome still requires target to be an object for imessage", () => {
  // handle-optional does NOT mean target-optional: a non-object target is a
  // wiring bug for every channel, imessage included.
  assert.throws(
    () => normalizeRunOutcome({ channel: "imessage", message: "hi" }),
    /`target` must be an object/,
  );
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

// --- #1289 (Jace goal loop) — optional enrichment fields ---
// The console's notify.ts has sent workspaceId/outcome/issueNumber/costUsd
// in this payload since before this feature existed (#1338); these are the
// first tests to exercise them being READ. Every field is additive and
// best-effort — see the module's own comment on why a missing/malformed
// value is omitted rather than throwing.

test("normalizeRunOutcome passes through workspaceId/issueExternalId/outcome/costUsd when present and well-formed", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "AgentRail: PR ready — issue #42",
    target: { chatId: "12345" },
    workspaceId: "ws-1",
    issueNumber: "42",
    outcome: "green",
    costUsd: 1.23,
  });
  assert.equal(out.workspaceId, "ws-1");
  assert.equal(out.issueExternalId, "42");
  assert.equal(out.outcome, "green");
  assert.equal(out.costUsd, 1.23);
});

test("normalizeRunOutcome coerces a numeric issueNumber to a string issueExternalId", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
    issueNumber: 42,
  });
  assert.equal(out.issueExternalId, "42");
});

test("normalizeRunOutcome omits every enrichment field when none are present — byte-identical to before #1289 (existing deepEqual test at the top of this file pins this)", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
  });
  assert.equal("workspaceId" in out, false);
  assert.equal("issueExternalId" in out, false);
  assert.equal("outcome" in out, false);
  assert.equal("costUsd" in out, false);
});

test("normalizeRunOutcome omits an unrecognized outcome value rather than throwing (best-effort enrichment, never breaks the core platform-notify path)", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
    outcome: "success", // the run_outcomes-table vocabulary, NOT this wire's vocabulary — deliberately rejected
  });
  assert.equal("outcome" in out, false);
});

test("normalizeRunOutcome omits a non-finite costUsd rather than throwing", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
    costUsd: Number.NaN,
  });
  assert.equal("costUsd" in out, false);
});

test("normalizeRunOutcome omits a blank workspaceId/issueNumber rather than passing through whitespace", () => {
  const out = normalizeRunOutcome({
    channel: "telegram",
    message: "hi",
    target: { chatId: "1" },
    workspaceId: "   ",
    issueNumber: "",
  });
  assert.equal("workspaceId" in out, false);
  assert.equal("issueExternalId" in out, false);
});
