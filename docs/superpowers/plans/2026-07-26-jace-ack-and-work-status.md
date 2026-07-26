# Jace ack-on-silence + status-of-work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jace posts a short acknowledgement when a turn runs long, and can answer any question about the state of work in flight from real, workspace-scoped data.

**Architecture:** A pure one-shot timer module (`ack-on-silence.core.mjs`) armed from each channel's existing `turn.started` handler and stopped when the reply lands, posting through each channel's *real* delivery seam. Separately, a new console route `GET /api/v1/runner/work-status` resolves the tenant server-side from the `jace_sessions` ledger and returns workspace-scoped runs/queue/PR state; a new read-only `fetch_work_status` tool consumes it, and `standup` is re-pointed at it so its unscoped direct-Postgres edge can be deleted.

**Tech Stack:** Node ESM (`.mjs` pure cores), TypeScript tool/channel wrappers, eve@0.19.0 channels, Next.js App Router API routes, Drizzle + Postgres, `node --test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-jace-ack-and-work-status-design.md`. Read it before starting.
- Ack copy is exactly `On it.` — no variants, no progress detail, no emoji.
- `ACK_AFTER_MS = 4000`.
- Pure cores are `.mjs`, dependency-free, with injected timers/transport. All branching logic lives there; TS wrappers only bind real dependencies.
- Read-only tools set **no** `approval` field. Approval gates are reserved for mutating tools.
- Tools never accept a `workspaceId` argument. Tenancy is always resolved server-side from `eveSessionId` via the `jace_sessions` ledger.
- Tools return a degraded result and **never throw**, and never retry.
- **Do not** override `turn.failed` or `session.failed` in any channel. eve does not publicly export `defaultEvents`; overriding clobbers eve's error message and drops the error id. See the spec's error-handling section.
- Jace tests run from `apps/jace` with `pnpm test` (`node --test test/*.test.mjs`). `apps/jace` is excluded from the root pnpm workspace — install there with `pnpm install --ignore-workspace`.
- Every change goes on a branch and through a PR. No direct commits to `main`.
- Do not commit `apps/jace/pnpm-lock.yaml` unless the task changes dependencies, and never commit a `node_modules` symlink.

---

## File Structure

**PR 1 — ack (branch `feat/jace-ack-on-silence`, base `main`)**

| File | Responsibility |
|---|---|
| `apps/jace/agent/lib/ack-on-silence.core.mjs` (create) | Pure one-shot silence timer. Arm/disarm keyed by conversation. |
| `apps/jace/test/ack-on-silence.core.test.mjs` (create) | Unit tests, injected fake timers. |
| `apps/jace/agent/channels/telegram.ts` (modify) | Arm ack in `turn.started`; move stops below the tool-calls guard. |
| `apps/jace/agent/channels/discord.ts` (modify) | Same, delivering via `deliverDiscordBubble`. |
| `apps/jace/agent/channels/slack.ts` (modify) | Add `turn.started`/`turn.completed`; ack via `channel.thread.post`. |
| `apps/jace/agent/channels/console.ts` (modify) | Add `turn.started`/`turn.completed`; ack via `postConsoleChatReply`. |
| `apps/jace/test/ack-channel-wiring.test.mjs` (create) | Asserts each channel arms the ack and uses the correct seam. |

**PR 2 — console route (branch `feat/console-work-status-route`, base `main`)**

| File | Responsibility |
|---|---|
| `packages/db-postgres/src/queries/work_status.ts` (create) | Workspace-scoped reads of `runs` and `queue_entries`. |
| `packages/db-postgres/src/queries/index.ts` (modify) | Re-export the new queries. |
| `apps/console/app/api/v1/runner/work-status/route.ts` (create) | GET route: auth, tenant resolution, shaping. |
| `apps/console/app/api/v1/runner/work-status/route.test.ts` (create) | Route tests. |

**PR 3 — tool + standup retirement (branch `feat/jace-fetch-work-status`, base PR 2's branch)**

| File | Responsibility |
|---|---|
| `apps/jace/agent/lib/fetch_work_status.core.mjs` (create) | Pure fetch/classify/degrade core. |
| `apps/jace/test/fetch_work_status.core.test.mjs` (create) | Core tests, every degraded branch. |
| `apps/jace/agent/tools/fetch_work_status.ts` (create) | Thin tool wrapper binding real fetch. |
| `apps/jace/agent/instructions.md` (modify) | Intent-routing rule under "Reporting on the factory". |
| `apps/jace/agent/tools/standup.ts` (modify) | Re-point at the console route. |
| `apps/jace/agent/lib/standup.db.mjs` (delete) | Unscoped direct-Postgres edge, removed. |
| `apps/jace/test/standup.db.test.mjs` (delete if present) | Tests for the deleted edge. |

---

## Task 1: Ack-on-silence pure core

**Files:**
- Create: `apps/jace/agent/lib/ack-on-silence.core.mjs`
- Test: `apps/jace/test/ack-on-silence.core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `createAckOnSilence(deps?) -> { start(key, postAck), stop(key), pendingCount() }`, plus exported constants `ACK_AFTER_MS = 4000` and `ACK_TEXT = "On it."`. `deps` accepts `{ setTimeout, clearTimeout, afterMs }`. `postAck` is `() => unknown | Promise<unknown>`; its throw or rejection is swallowed.

- [ ] **Step 1: Write the failing test**

Create `apps/jace/test/ack-on-silence.core.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A3 ack-on-silence
```

Expected: FAIL — `Cannot find module '../agent/lib/ack-on-silence.core.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `apps/jace/agent/lib/ack-on-silence.core.mjs`:

```javascript
// Post a short acknowledgement when a turn runs long enough to look dead.
//
// A message that triggers real work (a PR review, a codebase query, a subagent
// delegation) produces nothing in chat for 30s-2min. The typing indicator
// (typing-keepalive.core.mjs) is the only in-flight signal today, and on a
// phone it is easy to miss entirely — the user's experience is "I sent a
// message and got nothing".
//
// This is a ONE-SHOT timer, not a keep-alive: it fires at most once per turn.
// Armed from each channel's `turn.started`, disarmed when a real reply lands.
// A turn that answers fast never acks, so small talk stays clean; only turns
// that actually go quiet get "On it.".
//
// Deliberately says nothing about WHAT it is doing. At 4s the model has not
// necessarily decided anything, and inventing progress detail we cannot
// substantiate is the failure mode this is trying not to build.
//
// Pure + injected timers so it is unit-testable without real time or a
// network. Keyed by conversation so two concurrent chats never cross acks.
//
// NOT stopped on `turn.failed` / `session.failed`: eve@0.19.0 does not publicly
// export `defaultEvents` (the telegram entrypoint re-exports only
// `defaultTelegramAuth`), and its default failure handlers build their message
// from `#internal/logging.js` helpers that are equally unreachable — overriding
// them would clobber eve's error text and drop the error id. The residual race
// (a turn failing inside the window, so the ack lands just after eve's error
// message) is accepted and documented in the design spec.

export const ACK_AFTER_MS = 4000; // long enough that fast turns never ack
export const ACK_TEXT = "On it.";

export function createAckOnSilence(deps = {}) {
  const setTo = deps.setTimeout ?? setTimeout;
  const clearTo = deps.clearTimeout ?? clearTimeout;
  const afterMs = deps.afterMs ?? ACK_AFTER_MS;

  const pending = new Map(); // convoKey -> timeout id

  function start(key, postAck) {
    stop(key); // idempotent: a re-armed turn replaces its own timer
    const id = setTo(() => {
      // Clear BEFORE posting so a slow/throwing post can never leave a stale
      // entry behind, and so the turn can only ever ack once.
      pending.delete(key);
      safe(postAck);
    }, afterMs);
    pending.set(key, id);
  }

  function stop(key) {
    const id = pending.get(key);
    if (id === undefined) return;
    clearTo(id);
    pending.delete(key);
  }

  return { start, stop, pendingCount: () => pending.size };
}

function safe(fn) {
  // An acknowledgement must never throw into the turn: a failed ack is strictly
  // less bad than a failed reply. Covers both a synchronous throw and a
  // rejected promise from an async poster.
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.then(undefined, () => {});
    }
  } catch {
    /* swallow */
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all `ack-on-silence` tests pass, and the pre-existing suite is still green.

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/lib/ack-on-silence.core.mjs apps/jace/test/ack-on-silence.core.test.mjs
git commit -m "feat(jace): one-shot silence timer for slow-turn acknowledgement"
```

---

## Task 2: Wire the ack into Telegram

**Files:**
- Modify: `apps/jace/agent/channels/telegram.ts:40-63`
- Test: `apps/jace/test/ack-channel-wiring.test.mjs` (create)

**Interfaces:**
- Consumes: `createAckOnSilence`, `ACK_TEXT` from Task 1.
- Produces: nothing new. This task also **moves** `typing.stop` below the `finishReason === "tool-calls"` guard, so a tool-calling turn keeps its indicator alive until it actually replies.

- [ ] **Step 1: Write the failing test**

Create `apps/jace/test/ack-channel-wiring.test.mjs`.

**Follow this repo's channel-test convention exactly** — read `apps/jace/test/discord-channel.test.mjs:1-20` first. `node --test` cannot import the `.ts` channel modules (no TS loader is configured, and constructing a real channel needs eve's runtime), so channel tests assert against the **source as text**. All real behaviour is covered for real by the pure-core tests in Task 1; this file locks only the *wiring*.

Do **not** re-implement the handler bodies inside the test — a test that mirrors the code passes while the channel is broken.

```javascript
// Structural test for the slow-turn acknowledgement wiring across channels.
//
// agent/channels/*.ts are Eve channel modules — `node --test` cannot import
// them directly (no TS loader is configured for the test run, and constructing
// a real channel would need Eve's runtime context). Following this repo's
// convention (see discord-channel.test.mjs), ALL the real logic lives in and is
// fully exercised by ack-on-silence.core.test.mjs; this test locks only the
// WIRING — that each channel arms the ack on turn.started, disarms it on
// turn.completed, and places its stops BELOW the tool-calls guard — by reading
// the source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../agent/channels/${name}`, import.meta.url)),
    "utf8",
  );

const CHANNELS = ["telegram.ts", "discord.ts", "slack.ts", "console.ts"];

for (const name of CHANNELS) {
  test(`${name}: imports the ack module and instantiates it`, () => {
    const code = read(name);
    assert.match(
      code,
      /import\s*{[^}]*createAckOnSilence[^}]*ACK_TEXT[^}]*}\s*from\s*["']\.\.\/lib\/ack-on-silence\.core\.mjs["']/,
    );
    assert.match(code, /const\s+ack\s*=\s*createAckOnSilence\(/);
  });

  test(`${name}: arms the ack in turn.started and disarms it in turn.completed`, () => {
    const code = read(name);
    const turnStarted = code.slice(code.indexOf('"turn.started"'));
    assert.match(turnStarted.slice(0, 400), /ack\.start\(/);
    const turnCompleted = code.slice(code.indexOf('"turn.completed"'));
    assert.match(turnCompleted.slice(0, 300), /ack\.stop\(/);
  });

  test(`${name}: stops the ack BELOW the tool-calls guard, not above it`, () => {
    // A `tool-calls` message.completed fires mid-turn while the turn keeps
    // working. Stopping above the guard would suppress the ack on exactly the
    // slow, tool-calling turns that most need it.
    const code = read(name);
    const body = code.slice(code.indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.indexOf("ack.stop(");
    assert.ok(guard !== -1, "message.completed must keep eve's default guard");
    assert.ok(stop !== -1, "message.completed must stop the ack");
    assert.ok(stop > guard, "ack.stop must come AFTER the tool-calls guard");
  });
}

test("telegram + discord: typing.stop also moved below the tool-calls guard", () => {
  for (const name of ["telegram.ts", "discord.ts"]) {
    const body = read(name).slice(read(name).indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.indexOf("typing.stop(");
    assert.ok(stop > guard, `${name}: typing.stop must come AFTER the guard`);
  }
});

test("telegram: the ack posts via channel.telegram.post", () => {
  const code = read("telegram.ts");
  const turnStarted = code.slice(code.indexOf('"turn.started"'), code.indexOf('"turn.completed"'));
  assert.match(turnStarted, /channel\.telegram\.post\(\s*ACK_TEXT\s*\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A5 "ack-channel-wiring"
```

Expected: FAIL — the channels do not import `ack-on-silence.core.mjs` yet, so the import and `ack.start`/`ack.stop` assertions all fail. Tasks 3 and 4 turn the remaining channels green.

- [ ] **Step 3: Edit `apps/jace/agent/channels/telegram.ts`**

Add the import next to the existing keepalive import:

```typescript
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";
import { createAckOnSilence, ACK_TEXT } from "../lib/ack-on-silence.core.mjs";
```

Add the instance next to `const typing = createTypingKeepalive();`:

```typescript
const ack = createAckOnSilence();
```

Replace the whole `events` block (currently `telegram.ts:45-62`) with:

```typescript
  events: {
    "turn.started"(_data, channel, ctx) {
      const key = convoKey(ctx);
      typing.start(key, () => channel.telegram.startTyping());
      // One-shot: if this turn goes quiet for ACK_AFTER_MS, tell the human
      // we're on it. Disarmed below the moment a real reply lands.
      ack.start(key, () => channel.telegram.post(ACK_TEXT));
    },
    "turn.completed"(_data, _channel, ctx) {
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
    },
    async "message.completed"(data, channel, ctx) {
      // NOTE: both stops sit BELOW this guard on purpose. A `tool-calls`
      // message.completed fires mid-turn while the turn keeps working —
      // stopping here would kill the typing indicator at the first tool call
      // (the pre-existing behaviour this fixes) and suppress the ack on
      // exactly the slow, tool-calling turns that most need it.
      if (data.finishReason === "tool-calls" || !data.message) return;
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.telegram.startTyping();
        await channel.telegram.post(message);
      }
    },
  },
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/channels/telegram.ts apps/jace/test/ack-channel-wiring.test.mjs
git commit -m "feat(jace): acknowledge slow turns on Telegram; keep typing alive through tool calls"
```

---

## Task 3: Wire the ack into Discord

**Files:**
- Modify: `apps/jace/agent/channels/discord.ts:147-180`
- Test: `apps/jace/test/ack-channel-wiring.test.mjs` (extend)

**Interfaces:**
- Consumes: `createAckOnSilence`, `ACK_TEXT` (Task 1); `deliverDiscordBubble({ content, attributes, postFollowup, postViaBot })` and `resolveSessionAuthAttributes(auth)` from `apps/jace/agent/lib/discord-followup.core.mjs`.
- Produces: nothing new.

**Critical:** the ack must **not** use `channel.discord.post()` directly. In this hosted-shared-bot deployment that path needs View Channel + Send Messages on the specific channel and returns a silently-swallowed `50001 Missing Access` in private channels — the production bug fixed in #1463. Replies go through the interaction followup webhook via `deliverDiscordBubble`, and the ack is a reply like any other.

- [ ] **Step 1: Add the failing test**

Append to `apps/jace/test/ack-channel-wiring.test.mjs`, following the same source-as-text convention as Task 2:

```javascript
test("discord: the ack is delivered via deliverDiscordBubble, not a bare channel.post", () => {
  const code = read("discord.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );

  // The ack is a reply like any other, so it MUST take the interaction
  // followup path. channel.discord.post() alone needs View Channel + Send
  // Messages on this specific channel and dies with a swallowed 50001 in
  // private channels — that was the production bug fixed in #1463.
  assert.match(turnStarted, /deliverDiscordBubble\(/);
  assert.match(turnStarted, /content:\s*ACK_TEXT/);
  assert.match(turnStarted, /attributes:\s*resolveSessionAuthAttributes\(/);
  assert.match(turnStarted, /postFollowup:\s*followupTransport/);
  // channel.discord.post may appear ONLY as the postViaBot fallback.
  assert.match(turnStarted, /postViaBot:\s*\(\)\s*=>\s*channel\.discord\.post\(/);
});

test("discord: imports deliverDiscordBubble alongside deliverDiscordReply", () => {
  const code = read("discord.ts");
  assert.match(code, /deliverDiscordBubble/);
  assert.match(code, /deliverDiscordReply/);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A5 discord
```

Expected: FAIL — `discord.ts` has no `turn.started` ack wiring and does not import `deliverDiscordBubble` yet.

- [ ] **Step 3: Edit `apps/jace/agent/channels/discord.ts`**

Extend the existing import from `discord-followup.core.mjs`:

```typescript
import {
  deliverDiscordBubble,
  deliverDiscordReply,
  resolveSessionAuthAttributes,
} from "../lib/discord-followup.core.mjs";
import { createAckOnSilence, ACK_TEXT } from "../lib/ack-on-silence.core.mjs";
```

Add the instance next to `const typing = createTypingKeepalive({ refreshMs: 8000 });`:

```typescript
const ack = createAckOnSilence();
```

Replace the `events` block with:

```typescript
  events: {
    "turn.started"(_data, channel, ctx) {
      const key = convoKey(ctx);
      typing.start(key, () => channel.discord.startTyping());
      // The ack is a reply like any other, so it takes the SAME interaction
      // followup path message.completed uses. channel.discord.post() alone
      // needs View Channel + Send Messages on this specific channel and dies
      // with a swallowed 50001 in private channels — that was #1463.
      ack.start(key, () =>
        deliverDiscordBubble({
          content: ACK_TEXT,
          attributes: resolveSessionAuthAttributes(ctx?.session?.auth),
          postFollowup: followupTransport,
          postViaBot: () => channel.discord.post(ACK_TEXT),
        }),
      );
    },
    "turn.completed"(_data, _channel, ctx) {
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
    },
    async "message.completed"(data, channel, ctx) {
      // Both stops sit below the guard — see telegram.ts's identical comment.
      if (data.finishReason === "tool-calls" || !data.message) return;
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
      const attributes = resolveSessionAuthAttributes(ctx?.session?.auth);
      await deliverDiscordReply({
        text: data.message,
        attributes,
        postFollowup: followupTransport,
        postViaBot: (message) => channel.discord.post(message),
        startTyping: () => channel.discord.startTyping(),
        splitMessage: splitIntoChatMessages,
      });
    },
  },
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all green, including the pre-existing `discord-followup.core.test.mjs` and `discord-channel.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/channels/discord.ts apps/jace/test/ack-channel-wiring.test.mjs
git commit -m "feat(jace): acknowledge slow turns on Discord via the interaction followup path"
```

---

## Task 4: Wire the ack into Slack and the console channel

**Files:**
- Modify: `apps/jace/agent/channels/slack.ts:46-57`
- Modify: `apps/jace/agent/channels/console.ts:121-138`
- Test: `apps/jace/test/ack-channel-wiring.test.mjs` (extend)

**Interfaces:**
- Consumes: `createAckOnSilence`, `ACK_TEXT` (Task 1); `postConsoleChatReply` already imported in `console.ts`.
- Produces: nothing new.

Neither channel has a `turn.started` or `turn.completed` handler today; both are added. Slack is not currently configured in production (no `SLACK_*` vars on the jace service) — wire it for parity, but do not treat a Slack smoke test as a merge gate.

- [ ] **Step 1: Add the failing test**

Append to `apps/jace/test/ack-channel-wiring.test.mjs`, same source-as-text convention:

```javascript
test("slack: the ack posts to the thread seam", () => {
  const code = read("slack.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /channel\.thread\.post\(\s*ACK_TEXT\s*\)/);
});

test("console: the ack posts through postConsoleChatReply, not a raw transport call", () => {
  const code = read("console.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /postConsoleChatReply\(/);
  assert.match(turnStarted, /text:\s*ACK_TEXT/);
  assert.match(turnStarted, /workspaceId:\s*channel\.state\.workspaceId/);
  assert.match(turnStarted, /conversationKey:\s*channel\.state\.conversationKey/);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A5 "slack:\|console:"
```

Expected: FAIL — neither channel has a `turn.started` handler yet.

- [ ] **Step 3a: Edit `apps/jace/agent/channels/slack.ts`**

```typescript
import { slackChannel } from "eve/channels/slack";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import { createAckOnSilence, ACK_TEXT } from "../lib/ack-on-silence.core.mjs";

const ack = createAckOnSilence();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "slack";

export default slackChannel({
  events: {
    "turn.started"(_data, channel, ctx) {
      ack.start(convoKey(ctx), () => channel.thread.post(ACK_TEXT));
    },
    "turn.completed"(_data, _channel, ctx) {
      ack.stop(convoKey(ctx));
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      ack.stop(convoKey(ctx));
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.thread.startTyping();
        await channel.thread.post(message);
      }
    },
  },
});
```

- [ ] **Step 3b: Edit `apps/jace/agent/channels/console.ts`**

Add next to the existing imports:

```typescript
import { createAckOnSilence, ACK_TEXT } from "../lib/ack-on-silence.core.mjs";

const ack = createAckOnSilence();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "console";
```

Replace the `events` block with:

```typescript
  events: {
    "turn.started"(_data, channel, ctx) {
      ack.start(convoKey(ctx), () =>
        postConsoleChatReply({
          workspaceId: channel.state.workspaceId,
          conversationKey: channel.state.conversationKey,
          text: ACK_TEXT,
          env: process.env,
          transport: realTransport,
        }),
      );
    },
    "turn.completed"(_data, _channel, ctx) {
      ack.stop(convoKey(ctx));
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      ack.stop(convoKey(ctx));
      // Unlike telegram/discord/imessage, no bubble-splitting here: console
      // chat is a scrolling dashboard thread (one row per completed turn),
      // not a cadence-sensitive chat app — chat-split.core.mjs's paragraph
      // splitter exists for those platforms' human-texting feel, which does
      // not apply to a polled web UI.
      await postConsoleChatReply({
        workspaceId: channel.state.workspaceId,
        conversationKey: channel.state.conversationKey,
        text: data.message,
        env: process.env,
        transport: realTransport,
      });
    },
  },
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all green, including `console-channel-registration.test.mjs`.

- [ ] **Step 5: Commit and open PR 1**

```bash
git add apps/jace/agent/channels/slack.ts apps/jace/agent/channels/console.ts apps/jace/test/ack-channel-wiring.test.mjs
git commit -m "feat(jace): acknowledge slow turns on Slack and the console channel"
git push -u origin feat/jace-ack-on-silence
gh pr create --title "feat(jace): acknowledge slow turns before doing the work" --body "$(cat <<'BODY'
Jace goes silent for the whole of a 30s-2min turn. The typing indicator was the only in-flight signal and it is easy to miss on a phone.

Adds a one-shot silence timer (`ack-on-silence.core.mjs`): armed on `turn.started`, disarmed the moment a real reply lands, posting `On it.` at 4s. Fast turns never ack, so small talk stays clean.

Per channel it posts through that channel's real delivery seam — notably Discord goes via `deliverDiscordBubble` (the interaction followup path from #1463), never `channel.discord.post()`, which dies with a swallowed `50001 Missing Access` in private channels.

Also fixes pre-existing behaviour: `typing.stop` sat *above* the `finishReason === "tool-calls"` guard in `message.completed`, so the typing indicator died at the first tool call. Both stops now sit below it.

Deliberately does NOT override `turn.failed`/`session.failed` — eve@0.19.0 does not publicly export `defaultEvents`, and its default failure handlers build their message from unreachable `#internal/logging.js` helpers. The residual race is documented in the spec.

Spec: `docs/superpowers/specs/2026-07-26-jace-ack-and-work-status-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Task 5: Workspace-scoped work-status queries

**Files:**
- Create: `packages/db-postgres/src/queries/work_status.ts`
- Modify: `packages/db-postgres/src/queries/index.ts`
- Test: `packages/db-postgres/src/queries/work_status.test.ts`

**Interfaces:**
- Consumes: `runs` and `queueEntries` from `../schema/index.js`.
- Produces:
  - `getWorkspaceRuns(workspaceId: string, limit?: number): Promise<WorkspaceRun[]>` where `WorkspaceRun = { id: string; title: string | null; status: string; phase: string | null; branch: string; agent: string; prUrl: string | null; costUsd: number | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date }`
  - `getWorkspaceQueueEntries(workspaceId: string, limit?: number): Promise<WorkspaceQueueEntry[]>` where `WorkspaceQueueEntry = { id: string; externalId: string; title: string; state: string; tier: number; kind: string; createdAt: Date; updatedAt: Date }`
  - `findWorkspaceWorkByRef(workspaceId: string, ref: string): Promise<{ runs: WorkspaceRun[]; queueEntries: WorkspaceQueueEntry[] }>` — matches a run by `id`, or queue entries by `externalId`; both scoped to `workspaceId`.

Column names are taken from `packages/db-postgres/src/schema/runs.ts:20-60` (note: the column is `status`, **not** `state`) and `packages/db-postgres/src/schema/queue_entries.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/db-postgres/src/queries/work_status.test.ts` following the existing `runs-by-id.test.ts` conventions in this directory. Read that file first and match its DB setup/teardown exactly. The test must cover:

```typescript
// 1. getWorkspaceRuns returns only rows for the given workspace
//    - seed two workspaces, each with runs; assert no cross-workspace bleed
// 2. getWorkspaceRuns respects the limit and orders by createdAt DESC
// 3. getWorkspaceQueueEntries returns only rows for the given workspace
// 4. findWorkspaceWorkByRef matches a run by id
// 5. findWorkspaceWorkByRef matches queue entries by externalId (e.g. "1468")
// 6. findWorkspaceWorkByRef returns EMPTY for a ref owned by another workspace
//    — this is the cross-tenant assertion; it must never leak existence
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/db-postgres && pnpm test work_status 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/db-postgres/src/queries/work_status.ts`. Match the import style, `db` handle acquisition, and export style of the sibling `runs-by-id`/`goals` query modules — read one before writing. Every query MUST carry `eq(runs.workspaceId, workspaceId)` / `eq(queueEntries.workspaceId, workspaceId)`; there is no unscoped variant, deliberately.

Default `limit` is 50 for runs and 50 for queue entries. Order runs by `createdAt` DESC, queue entries by `updatedAt` DESC.

- [ ] **Step 4: Export from the barrel**

Add to `packages/db-postgres/src/queries/index.ts`, alphabetically among the existing re-exports:

```typescript
export * from "./work_status.js";
```

- [ ] **Step 5: Run the tests**

```bash
cd packages/db-postgres && pnpm test work_status 2>&1 | tail -20
```

Expected: PASS, including the cross-tenant test.

- [ ] **Step 6: Commit**

```bash
git add packages/db-postgres/src/queries/work_status.ts packages/db-postgres/src/queries/work_status.test.ts packages/db-postgres/src/queries/index.ts
git commit -m "feat(db): workspace-scoped run and queue-entry reads for work status"
```

---

## Task 6: The console work-status route

**Files:**
- Create: `apps/console/app/api/v1/runner/work-status/route.ts`
- Test: `apps/console/app/api/v1/runner/work-status/route.test.ts`

**Interfaces:**
- Consumes: Task 5's `getWorkspaceRuns`, `getWorkspaceQueueEntries`, `findWorkspaceWorkByRef`; `requireJaceConsoleSecret` from `apps/console/lib/jace-console-auth`; `getJaceSessionByEveSessionId`, `getChatIdentityById` from `@agentrail/db-postgres`.
- Produces: `GET /api/v1/runner/work-status?eveSessionId=<id>[&ref=<string>]` returning `200 { runs, queueEntries, ref }` where `runs` and `queueEntries` are the arrays from Task 5 with dates serialised as ISO strings.

**Read `apps/console/app/api/v1/runner/pr-review/route.ts` first.** This route copies its auth guard and its tenant-resolution chain exactly. The one deliberate difference: pr-review also validates repo↔workspace ownership because the caller names a repo; this route names no repo, so it stops after resolving `workspaceId`.

- [ ] **Step 1: Write the failing test**

Create `apps/console/app/api/v1/runner/work-status/route.test.ts`, matching the mocking style of the sibling `pr-review/route.test.ts` (read it first). Cases:

```typescript
// 1. missing/incorrect Jace console secret -> 401
// 2. missing eveSessionId -> 400 { error: "eveSessionId is required" }
// 3. eveSessionId with no jace_sessions row -> 404 { error: "Chat identity not found" }
// 4. session resolves but has no workspace -> 409
//    { error: "this conversation has no workspace yet — create one first" }
// 5. happy path, no ref -> 200 with runs[] and queueEntries[] for the RESOLVED
//    workspace only; assert the query was called with the resolved workspaceId
//    and that no caller-supplied workspace id is ever honoured
// 6. happy path with ref -> 200, findWorkspaceWorkByRef called with
//    (resolvedWorkspaceId, ref)
// 7. ref that matches nothing in this workspace -> 200 with empty arrays
//    (NOT 404 — an empty result must not distinguish "not yours" from
//    "does not exist"; see the spec's tenancy note)
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/console && pnpm test work-status 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `apps/console/app/api/v1/runner/work-status/route.ts`. Structure it as:

```typescript
export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const ref = params.get("ref")?.trim() ?? "";

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  // Tenant resolution: eveSessionId -> jace_sessions -> chat identity ->
  // workspaceId. NEVER a caller-supplied workspace id — same chain
  // runner/pr-review, runner/repos and runner/goals use.
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  if (!session || !identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }
  const workspaceId = session.workspaceId ?? identity.workspaceId;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "this conversation has no workspace yet — create one first" },
      { status: 409 }
    );
  }

  const { runs, queueEntries } = ref
    ? await findWorkspaceWorkByRef(workspaceId, ref)
    : {
        runs: await getWorkspaceRuns(workspaceId),
        queueEntries: await getWorkspaceQueueEntries(workspaceId),
      };

  return NextResponse.json(
    { ref: ref || null, runs: runs.map(serialiseRun), queueEntries: queueEntries.map(serialiseEntry) },
    { status: 200 }
  );
}
```

Write `serialiseRun` / `serialiseEntry` as local helpers converting `Date` fields to ISO strings and passing the rest through unchanged. Add a module doc-comment in the house style of `pr-review/route.ts` explaining the auth posture and why tenancy is resolved server-side.

- [ ] **Step 4: Run the tests**

```bash
cd apps/console && pnpm test work-status 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit and open PR 2**

```bash
git add apps/console/app/api/v1/runner/work-status/
git commit -m "feat(console): workspace-scoped work-status route for Jace"
git push -u origin feat/console-work-status-route
gh pr create --title "feat(console): work-status route for Jace status questions" --body "$(cat <<'BODY'
Adds `GET /api/v1/runner/work-status`, the read seam behind Jace answering "how's that going".

Tenancy is resolved server-side from `eveSessionId` through the `jace_sessions` ledger, exactly as `runner/pr-review` does — the route never accepts a caller-supplied workspace id, and every query is scoped with `WHERE workspace_id = $resolved`. A `ref` that belongs to another workspace comes back empty rather than 404, so the response never distinguishes "not yours" from "does not exist".

Spec: `docs/superpowers/specs/2026-07-26-jace-ack-and-work-status-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Task 7: The `fetch_work_status` pure core

**Files:**
- Create: `apps/jace/agent/lib/fetch_work_status.core.mjs`
- Test: `apps/jace/test/fetch_work_status.core.test.mjs`

**Interfaces:**
- Consumes: Task 6's route contract.
- Produces:
  - `WORK_STATUS_PATH = "/api/v1/runner/work-status"`
  - `resolveConsoleConfig(env) -> { ok: true, baseUrl, token } | { ok: false, missing: string[] }`
  - `buildWorkStatusUrl(baseUrl, eveSessionId, ref) -> string`
  - `classifyStatus(status) -> { ok: true } | { ok: false, reason: string }`
  - `degraded(reason, extra?) -> { ok: false, degraded: true, reason, note, ...extra }`
  - `fetchWorkStatus({ env, eveSessionId, ref, transport }) -> Promise<result>`

**This is a near-exact sibling of `apps/jace/agent/subagents/reviewer/lib/fetch_pr_diff.core.mjs`. Read that file and mirror it**, including its deliberate duplication of `resolveConsoleConfig` (each core here is dependency-free of the others by design — do not factor it out) and its cause-free degraded notes.

Differences from `fetch_pr_diff`: no `repo`/`prNumber`, an optional `ref` instead; `bad_request` only when `eveSessionId` is blank; the success shape is `{ ok: true, ref, runs, queueEntries }`.

- [ ] **Step 1: Write the failing test**

Create `apps/jace/test/fetch_work_status.core.test.mjs`, mirroring `apps/jace/test/fetch_pr_diff.core.test.mjs` (read it first). Cases:

```javascript
// blank eveSessionId                       -> degraded("bad_request")
// unset JACE_CONSOLE_BASE_URL / _TOKEN     -> degraded("config_missing", { missing })
// transport throws                         -> degraded("unreachable")
// 400 / 401 / 403 / 404 / 409 / 429 / 500  -> degraded(<mapped>, { status })
// non-JSON body                            -> degraded("bad_body", { status })
// 200 happy path                           -> { ok:true, ref, runs, queueEntries }
// ref is sent as a query param when given, omitted when blank
// arrays default to [] when the body omits them
// the Authorization header is `Bearer <token>` and Accept is application/json
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A5 fetch_work_status
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/jace/agent/lib/fetch_work_status.core.mjs` mirroring `fetch_pr_diff.core.mjs`'s structure exactly. Degraded notes:

```javascript
const DEGRADED_NOTES = {
  config_missing:
    "The console work-status endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no status could be fetched.",
  bad_request:
    "The status request was malformed (missing session); no status could be fetched.",
  unreachable:
    "The console work-status endpoint could not be reached (network error); no status could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — this Jace deployment's console token may be stale.",
  not_found:
    "The console could not resolve this conversation to a workspace (404).",
  conflict:
    "This conversation has no workspace yet (409) — connect one first.",
  rate_limited: "The console is rate limiting; no status could be fetched right now.",
  upstream_error: "The console errored (5xx); no status could be fetched.",
  unexpected_status: "The console returned an unexpected status.",
  bad_body: "The console responded, but the body was not valid JSON.",
};
```

`fetchWorkStatus` success shape:

```javascript
return {
  ok: true,
  ref: typeof body.ref === "string" ? body.ref : null,
  runs: Array.isArray(body.runs) ? body.runs : [],
  queueEntries: Array.isArray(body.queueEntries) ? body.queueEntries : [],
};
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/lib/fetch_work_status.core.mjs apps/jace/test/fetch_work_status.core.test.mjs
git commit -m "feat(jace): pure core for the work-status read"
```

---

## Task 8: The `fetch_work_status` tool and intent routing

**Files:**
- Create: `apps/jace/agent/tools/fetch_work_status.ts`
- Modify: `apps/jace/agent/instructions.md` (the `## Reporting on the factory (read-only)` section, line 127)

**Interfaces:**
- Consumes: Task 7's `fetchWorkStatus`.
- Produces: a default-exported eve tool named `fetch_work_status` (the runtime name is the filename slug).

**Read `apps/jace/agent/tools/fetch_backlog.ts` first and mirror it** — same auth model (`ctx.session.id` as `eveSessionId`, never model-supplied), same injected-transport idiom, same "no `approval` because read-only" posture.

- [ ] **Step 1: Write the tool**

```typescript
import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchWorkStatus } from "../lib/fetch_work_status.core.mjs";

async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, { method: "GET", headers: init.headers });
  return { status: res.status, json: () => res.json() };
}

export default defineTool({
  description:
    "Read-only: fetch the current state of work in this workspace — in-flight " +
    "and recent runs (status, phase, cost, PR link) and issue-queue entries. " +
    "Call this for ANY question about how work is going: 'how's that going', " +
    "'did it land', 'where are we on X', 'is it done', 'what's happening'. " +
    "Pass `ref` to ask about one specific issue, PR, or run; omit it for the " +
    "whole live picture. Writes nothing and needs no approval. Returns a " +
    "degraded result (never throws) when the console is unconfigured, " +
    "unreachable, or this conversation has no workspace; treat that as an " +
    "honest gap, never a reason to guess at what the factory is doing.",
  inputSchema: z.object({
    ref: z
      .string()
      .optional()
      .describe(
        "Optional issue number, PR number, or run id to narrow to one item. " +
          "Omit for the whole workspace's current picture.",
      ),
  }),
  async execute(input, ctx) {
    return fetchWorkStatus({
      env: process.env,
      eveSessionId: ctx.session.id,
      ref: input.ref ?? "",
      transport: realTransport,
    });
  },
});
```

Add a module doc-comment above the imports in the house style of `fetch_backlog.ts`: what it reads, the tenant-resolution model, and why it sets no `approval`.

- [ ] **Step 2: Add the intent-routing rule to `instructions.md`**

Insert this subsection at the end of the `## Reporting on the factory (read-only)` section (before `## Grooming the backlog`, currently line 149):

```markdown
### Answering "how's that going"

Any question whose INTENT is the state of work in flight calls
`fetch_work_status` before you answer. This is about intent, not a phrase —
"how's that going", "did it land", "where are we on the review", "is it done
yet", "what's happening with #1468", "any progress" all qualify, and so does a
bare "and?" following a request you took on.

Two rules:

- Answer ONLY from what the tool returns. Never from what you remember saying
  earlier in the conversation — the fleet moves between turns and your memory of
  it goes stale immediately.
- If it returns a degraded result, say so plainly and report its `note`. Never
  paraphrase a retrieval failure into a guess about the work itself.

Pass `ref` when the human named a specific issue, PR, or run. Omit it when they
asked about things in general.

The `runs` table has no failure-reason column, so "why did it fail" is answered
with what IS known — status, phase, cost, PR link — and an explicit statement
that there is no recorded reason. Never confabulate one.
```

- [ ] **Step 3: Verify the tool loads and the suite is green**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all green. If a test asserts the full tool inventory (check `no-second-write-path.test.mjs` and `qa-read-only.test.mjs`), update its expected list to include `fetch_work_status` and confirm it is asserted as a read-only, non-approval tool.

- [ ] **Step 4: Commit**

```bash
git add apps/jace/agent/tools/fetch_work_status.ts apps/jace/agent/instructions.md
git commit -m "feat(jace): fetch_work_status tool and status-intent routing"
```

---

## Task 9: Retire standup's direct-Postgres edge

**Files:**
- Modify: `apps/jace/agent/tools/standup.ts`
- Delete: `apps/jace/agent/lib/standup.db.mjs`
- Delete: `apps/jace/test/standup.db.test.mjs` (only if it exists)
- Keep unchanged: `apps/jace/agent/lib/standup.core.mjs`

**Interfaces:**
- Consumes: Task 7's `fetchWorkStatus`; the existing `buildStandup`, `renderStandup`, `answerWhyFailed`, `WHY_FAILED_NO_SOURCE` from `standup.core.mjs`.
- Produces: `standup` keeps its current return shape `{ report, standup, whyFailed, failureReasonPolicy }` so nothing downstream changes.

**Why:** `standup.db.mjs:53` is `SELECT … FROM runs ORDER BY created_at DESC LIMIT 500` — no `WHERE`, no workspace filter. It is the only Jace tool that opens Postgres directly instead of going through the console seam, so it reads every workspace's runs. It is also dark in production: it resolves `DATABASE_URL`, which the jace service does not set, and silently falls back to a localhost URL. Re-pointing it at the work-status route fixes both and removes the `DATABASE_URL` dependency entirely.

- [ ] **Step 1: Update the existing standup tests**

Read `apps/jace/test/` for the current standup coverage. Change the tests so the data source is the injected `fetchWorkStatus`-shaped result rather than a fake SQL driver. `standup.core.mjs`'s own tests (`buildStandup`/`renderStandup`/`answerWhyFailed`) stay untouched — only the tool's data plumbing changes.

Add one new test: a degraded `fetchWorkStatus` result makes `standup` return the degraded result verbatim rather than rendering an empty report that reads like "nothing is running".

- [ ] **Step 2: Run to verify the new expectations fail**

```bash
cd apps/jace && pnpm test 2>&1 | grep -A5 standup
```

Expected: FAIL.

- [ ] **Step 3: Rewrite `standup.ts`'s `execute`**

```typescript
  async execute(input, ctx) {
    const status = await fetchWorkStatus({
      env: process.env,
      eveSessionId: ctx.session.id,
      ref: "",
      transport: realTransport,
    });
    if (!status.ok) return status; // degraded — report the gap, never an empty report

    const standup = buildStandup({
      runs: status.runs,
      queueEntries: status.queueEntries,
    });
    const report = renderStandup(standup);

    let whyFailed: ReturnType<typeof answerWhyFailed> | null = null;
    if (input.whyFailedRunId) {
      const run = status.runs.find((r) => r.id === input.whyFailedRunId);
      whyFailed = answerWhyFailed(run);
    }

    return { report, standup, whyFailed, failureReasonPolicy: WHY_FAILED_NO_SOURCE };
  },
```

Drop the now-unused `limit` input (the route owns the cap) and the `openReadOnlyDb`/`realSqlFactory` imports. Replace the module doc-comment's "opens the AgentRail Postgres database through a hard read-only edge" paragraph with one explaining that it now reads the workspace-scoped console route, and why that replaced the direct edge.

- [ ] **Step 4: Delete the dead edge**

```bash
git rm apps/jace/agent/lib/standup.db.mjs
git rm --ignore-unmatch apps/jace/test/standup.db.test.mjs
```

- [ ] **Step 5: Confirm nothing else imports it**

```bash
cd apps/jace && rg -n "standup.db" . --glob '!node_modules'
```

Expected: no matches.

- [ ] **Step 6: Run the full suite**

```bash
cd apps/jace && pnpm test 2>&1 | tail -20
```

Expected: all green.

- [ ] **Step 7: Commit and open PR 3**

```bash
git add -A apps/jace
git commit -m "refactor(jace): retire standup's unscoped direct-Postgres edge onto the console route"
git push -u origin feat/jace-fetch-work-status
gh pr create --base feat/console-work-status-route --title "feat(jace): answer status-of-work questions" --body "$(cat <<'BODY'
Stacked on #<PR 2 number>.

Adds `fetch_work_status` — a read-only, console-backed tool answering any question whose intent is the state of work in flight, with an `instructions.md` rule that routes on intent rather than a trigger phrase.

Also retires `standup`'s direct-Postgres edge onto the same route. That edge was `SELECT … FROM runs` with no `WHERE` — it read every workspace, bypassing the tenant resolution every other Jace tool uses — and it was dark in production anyway, resolving a `DATABASE_URL` the jace service does not set and silently falling back to localhost. Deleting it also removes the `DATABASE_URL` dependency.

Spec: `docs/superpowers/specs/2026-07-26-jace-ack-and-work-status-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Task 10: Verify in production-shaped conditions

**Files:** none — this is a verification gate before merge.

- [ ] **Step 1: Determine whether `turn.completed` fires after `turn.failed`**

The spec flags this as unresolved: if eve emits `turn.completed` on a failed turn, the existing handler already disarms the ack and the documented race closes for free. Determine it against the **running sidecar**, not the `.d.ts` stubs — reading stubs instead of the compiled runtime is what produced an incorrect claim in an earlier draft of this spec and is the same mistake #1463 was root-caused on twice.

Record the answer in the spec's error-handling section either way.

- [ ] **Step 2: Verify the ack end-to-end on Telegram**

Send the bot a message that triggers real work (e.g. a PR review request). Expect `On it.` within ~4s, then the real reply. Then send `hi` and confirm **no** ack appears.

- [ ] **Step 3: Verify the ack end-to-end on Discord in a private channel**

This is the path #1463 fixed. Confirm the ack arrives via the interaction followup (not a `50001 Missing Access` swallow). Check the jace service logs for followup fallback warnings.

- [ ] **Step 4: Verify status answers against the real workspace**

Ask "how's that going" and a `ref`-specific variant. Confirm the numbers match the console dashboard, and that a ref from outside the workspace returns empty rather than leaking.

- [ ] **Step 5: Confirm `DATABASE_URL` is genuinely unneeded**

After PR 3 deploys, confirm the jace service has no `DATABASE_URL` set and `standup` still works.

---

## Self-Review Notes

- **Spec coverage.** Ack module → Task 1. Per-channel wiring incl. the Discord followup constraint → Tasks 2–4. Stop-placement fix → Task 2 (Telegram) and Task 3 (Discord). Console route + tenancy → Tasks 5–6. Tool + degraded branches → Task 7. Intent routing → Task 8. standup retirement + `standup.db.mjs` deletion → Task 9. The spec's "verify during implementation" item → Task 10 Step 1.
- **Deliberately not covered.** The spec's closing note that Jace paraphrased a structured degraded result into a guess ("make sure the PR is public") is called out there as needing its own issue. Task 8's instructions rule addresses it only for `fetch_work_status`; the general fix across all tools is out of scope here. **File that issue before closing this plan.**
- **Naming consistency.** `runs` rows use `status` (not `state`) per the schema; queue entries use `state`. Task 5's interface block, Task 6's route, and Task 7's core all follow that split.
