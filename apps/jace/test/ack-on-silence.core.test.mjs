// Unit tests for the slow-turn acknowledgement timer. Injected fake timers so
// the one-shot behaviour is verified deterministically, with no real time.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAckOnSilence,
  ACK_AFTER_MS,
  ACK_TEXT,
} from "../agent/lib/ack-on-silence.core.mjs";

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

test("ACK_TEXT is exactly the approved copy", () => {
  assert.equal(ACK_TEXT, "On it.");
  assert.equal(ACK_AFTER_MS, 4000);
});

test("posts the ack once the silence window elapses", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  const posted = [];

  ack.start("convo-1", () => posted.push("ack"));
  assert.deepEqual(posted, [], "must not post synchronously");

  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, ["ack"]);
});

test("stop before the window elapses suppresses the ack entirely", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  const posted = [];

  ack.start("convo-1", () => posted.push("ack"));
  ack.stop("convo-1");
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, []);
  assert.equal(ack.pendingCount(), 0);
});

test("fires at most once per armed turn", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  const posted = [];

  ack.start("convo-1", () => posted.push("ack"));
  timers.advanceTo(ACK_AFTER_MS);
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, ["ack"]);
  assert.equal(ack.pendingCount(), 0, "entry is cleared once it fires");
});

test("two conversations stay isolated", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  const posted = [];

  ack.start("a", () => posted.push("a"));
  ack.start("b", () => posted.push("b"));
  ack.stop("a");
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, ["b"]);
});

test("re-arming the same key replaces its pending timer", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  const posted = [];

  ack.start("a", () => posted.push("first"));
  ack.start("a", () => posted.push("second"));
  timers.advanceTo(ACK_AFTER_MS);

  assert.deepEqual(posted, ["second"]);
  assert.equal(timers.size(), 0);
});

test("stop on an unknown key is a no-op", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);
  assert.doesNotThrow(() => ack.stop("never-started"));
});

test("a throwing postAck never propagates", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);

  ack.start("a", () => {
    throw new Error("telegram is down");
  });
  assert.doesNotThrow(() => timers.advanceTo(ACK_AFTER_MS));
});

test("a rejecting postAck never propagates", async () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence(timers);

  ack.start("a", async () => {
    throw new Error("telegram is down");
  });
  assert.doesNotThrow(() => timers.advanceTo(ACK_AFTER_MS));
  await new Promise((resolve) => setImmediate(resolve));
});

test("afterMs is overridable per channel", () => {
  const timers = fakeTimers();
  const ack = createAckOnSilence({ ...timers, afterMs: 9000 });
  const posted = [];

  ack.start("a", () => posted.push("ack"));
  timers.advanceTo(ACK_AFTER_MS);
  assert.deepEqual(posted, [], "must not fire on the default window");

  timers.advanceTo(9000);
  assert.deepEqual(posted, ["ack"]);
});
