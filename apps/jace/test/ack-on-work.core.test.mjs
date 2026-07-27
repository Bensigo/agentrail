// Unit tests for the work-started acknowledgement. Injected fake timers so the
// one-shot behaviour is verified deterministically, with no real time.
//
// Replaces ack-on-silence.core.test.mjs. The timer mechanics carry over almost
// unchanged; what is new is that arming is keyed by TURN (so multi-step tool use
// acks once, not once per step) and that the copy is derived from the
// `actions.requested` payload rather than being a fixed string.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAckOnWork,
  actionName,
  workPhraseFor,
  ACK_AFTER_MS,
  GENERIC_WORK_PHRASE,
  WORK_PHRASES,
  isProactiveTurn,
  JACE_PROACTIVE_ATTRIBUTE,
} from "../agent/lib/ack-on-work.core.mjs";

function fakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    /** Fire every timer scheduled at exactly `ms`. */
    advanceTo(ms) {
      for (const [id, entry] of [...timeouts]) {
        if (entry.ms === ms) {
          timeouts.delete(id);
          entry.fn();
        }
      }
    },
    size: () => timeouts.size,
  };
}

const toolCall = (toolName) => ({ kind: "tool-call", callId: "c1", input: {}, toolName });

// --- action naming -------------------------------------------------------

test("actionName reads toolName off a tool-call", () => {
  assert.equal(actionName(toolCall("codebase_query")), "codebase_query");
});

test("actionName reads subagentName off a subagent-call", () => {
  assert.equal(
    actionName({ kind: "subagent-call", subagentName: "reviewer", name: "n", nodeId: "x" }),
    "reviewer",
  );
});

test("actionName reads remoteAgentName off a remote-agent-call", () => {
  assert.equal(
    actionName({ kind: "remote-agent-call", remoteAgentName: "researcher" }),
    "researcher",
  );
});

test("actionName returns null for load-skill, which carries no name", () => {
  assert.equal(actionName({ kind: "load-skill", callId: "c1", input: {} }), null);
});

test("actionName returns null for an unknown/absent kind rather than throwing", () => {
  assert.equal(actionName({ kind: "invented-later" }), null);
  assert.equal(actionName(null), null);
  assert.equal(actionName(undefined), null);
  assert.equal(actionName({}), null);
});

// --- copy derivation -----------------------------------------------------

test("workPhraseFor names a known tool", () => {
  assert.equal(workPhraseFor([toolCall("codebase_query")]), WORK_PHRASES.codebase_query);
  assert.equal(workPhraseFor([toolCall("fetch_work_status")]), "Checking where that stands…");
});

test("workPhraseFor names a known subagent", () => {
  assert.equal(
    workPhraseFor([{ kind: "subagent-call", subagentName: "reviewer" }]),
    "Reading the PR…",
  );
});

test("workPhraseFor falls back to the generic phrase for an unmapped tool", () => {
  assert.equal(workPhraseFor([toolCall("some_tool_added_next_quarter")]), GENERIC_WORK_PHRASE);
});

test("workPhraseFor prefers a named action over an unmapped one in the same batch", () => {
  assert.equal(
    workPhraseFor([toolCall("some_tool_added_next_quarter"), toolCall("fetch_backlog")]),
    WORK_PHRASES.fetch_backlog,
  );
});

test("workPhraseFor returns null for a load-skill-only batch (no ack at all)", () => {
  assert.equal(workPhraseFor([{ kind: "load-skill", callId: "c1", input: {} }]), null);
});

test("workPhraseFor returns null for smalltalk, the fast conversational path", () => {
  assert.equal(workPhraseFor([{ kind: "subagent-call", subagentName: "smalltalk" }]), null);
});

test("workPhraseFor describes real work even when batched with silent actions", () => {
  assert.equal(
    workPhraseFor([
      { kind: "load-skill", callId: "c1", input: {} },
      { kind: "subagent-call", subagentName: "smalltalk" },
      toolCall("standup"),
    ]),
    WORK_PHRASES.standup,
  );
});

test("workPhraseFor tolerates a non-array payload", () => {
  assert.equal(workPhraseFor(undefined), null);
  assert.equal(workPhraseFor(null), null);
  assert.equal(workPhraseFor([]), null);
});

test("no work phrase is the bare old ack string", () => {
  // Regression guard for the whole point of this change: the fixed "On it."
  // that fired on every turn must not survive anywhere in the copy table.
  for (const phrase of Object.values(WORK_PHRASES)) {
    assert.notEqual(phrase, "On it.");
  }
  assert.notEqual(GENERIC_WORK_PHRASE, "On it.");
});

// --- timer mechanics -----------------------------------------------------

test("posts the ack once the window elapses after work starts", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("ack"));
  assert.deepEqual(posted, [], "must not post synchronously");

  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["ack"]);
});

test("stop before the window elapses suppresses the ack entirely", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("ack"));
  ack.stop("convo-1");
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, []);
  assert.equal(ack.pendingCount(), 0);
});

test("a second actions.requested in the SAME turn does not arm a second ack", () => {
  // The normal shape of multi-step tool use. Re-arming per step would push the
  // ack out indefinitely and a chatty slow turn would never acknowledge at all.
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("first"));
  ack.arm("convo-1", "turn-1", () => posted.push("second"));
  assert.equal(timers.size(), 1, "only one timer may be scheduled for one turn");

  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["first"], "the FIRST step's copy wins, and only it posts");
});

test("a repeat actions.requested AFTER the ack already fired stays silent", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("first"));
  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["first"]);

  // Step 2 of the same turn requests more tools.
  ack.arm("convo-1", "turn-1", () => posted.push("second"));
  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["first"], "one ack per turn, even after it has fired");
});

test("a NEW turn on the same conversation can ack again", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("turn-1"));
  timers.advanceTo(ACK_AFTER_MS);
  ack.stop("convo-1"); // turn.completed

  ack.arm("convo-1", "turn-2", () => posted.push("turn-2"));
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, ["turn-1", "turn-2"]);
});

test("a new turn replaces a stale entry left behind without a stop", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("convo-1", "turn-1", () => posted.push("turn-1"));
  // turn-1 never stopped (a dropped turn.completed); turn-2 arrives.
  ack.arm("convo-1", "turn-2", () => posted.push("turn-2"));
  assert.equal(timers.size(), 1, "the stale timer must be cleared, not left running");

  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["turn-2"]);
});

test("two conversations stay isolated", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const posted = [];

  ack.arm("a", "turn-1", () => posted.push("a"));
  ack.arm("b", "turn-1", () => posted.push("b"));
  ack.stop("a");
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, ["b"], "same turn id on a different convo is a different ack");
});

test("stop on an unknown key is a no-op", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  assert.doesNotThrow(() => ack.stop("never-armed"));
  assert.equal(ack.pendingCount(), 0);
});

test("stop after firing clears the entry", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);

  ack.arm("a", "turn-1", () => {});
  timers.advanceTo(ACK_AFTER_MS);
  assert.equal(ack.pendingCount(), 1, "entry survives firing to keep the turn one-shot");
  assert.equal(ack.armedCount(), 0, "but no timer is still scheduled");

  ack.stop("a");
  assert.equal(ack.pendingCount(), 0);
});

test("a throwing postAck never propagates", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);

  ack.arm("a", "turn-1", () => {
    throw new Error("telegram is down");
  });
  assert.doesNotThrow(() => timers.advanceTo(ACK_AFTER_MS));
});

test("a rejecting postAck is swallowed, not surfaced as an unhandled rejection", async () => {
  const timers = fakeTimers();
  const ack = createAckOnWork(timers);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    ack.arm("a", "turn-1", async () => {
      throw new Error("telegram is down");
    });
    timers.advanceTo(ACK_AFTER_MS);
    // Drain microtasks, then a macrotask turn — by now Node would have
    // reported the rejection had safe() not attached its handler.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "safe() must swallow the rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("afterMs is overridable per channel", () => {
  const timers = fakeTimers();
  const ack = createAckOnWork({ ...timers, afterMs: 9000 });
  const posted = [];

  ack.arm("a", "turn-1", () => posted.push("ack"));
  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, [], "must not fire on the default window");

  timers.advanceTo(9000);
  assert.deepEqual(posted, ["ack"]);
});

// --- isProactiveTurn (run-outcome.ts hand-offs never ack) ----------------
//
// Still load-bearing after the move to actions.requested: a proactive turn can
// call tools too (a terminal-outcome notification may look the run up before
// describing it), so the new trigger does not filter these out by itself.

test("isProactiveTurn: true when current.attributes carries the marker", () => {
  assert.equal(
    isProactiveTurn({ current: { attributes: { [JACE_PROACTIVE_ATTRIBUTE]: true } } }),
    true,
  );
});

test("isProactiveTurn: true when only initiator.attributes carries the marker (turn 1 shape)", () => {
  assert.equal(
    isProactiveTurn({ initiator: { attributes: { [JACE_PROACTIVE_ATTRIBUTE]: true } } }),
    true,
  );
});

test("isProactiveTurn: false when the attribute is absent from a normal human-initiated auth", () => {
  assert.equal(
    isProactiveTurn({
      current: { attributes: { chatIdentityId: "abc", workspaceId: "ws_1" } },
    }),
    false,
  );
});

test("isProactiveTurn: false when current.attributes exists but lacks the marker, even if a differing initiator has it (current wins)", () => {
  assert.equal(
    isProactiveTurn({
      current: { attributes: { chatIdentityId: "abc" } },
      initiator: { attributes: { [JACE_PROACTIVE_ATTRIBUTE]: true } },
    }),
    false,
  );
});

test("isProactiveTurn: false when auth is null", () => {
  assert.equal(isProactiveTurn(null), false);
});

test("isProactiveTurn: false when auth is undefined", () => {
  assert.equal(isProactiveTurn(undefined), false);
});

test("isProactiveTurn: false when auth is an empty object", () => {
  assert.equal(isProactiveTurn({}), false);
});
