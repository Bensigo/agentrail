# Slack Thread Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jace answer Slack **channel** messages inside a thread rooted at the user's own message, and make that conversation resume across turns.

**Architecture:** Slack's inbound door computes two values from one event — a stable `conversationKey` and the `threadTs` to reply in — using a new pure module. Both ride the existing `channel_inbox` → dispatcher → hosted-inbound path with no new door and no new table. `threadTs` is forwarded through the dispatcher's target builder and `normalizeHostedInbound`, where eve turns it into the Slack continuation token `channelId:threadTs`.

**Tech Stack:** TypeScript (Next.js console, `node --test` via vitest for `apps/console`), plain ESM + JSDoc (`apps/jace`, `node --test`), eve 0.19.0.

## Global Constraints

- **This is PR 1 of the thread-native arc.** It ships Slack only. Discord thread creation, the shared `ThreadInbound` envelope, the engagement state machine, and the `engagement_dormant_since` migration are all PR 2+ and are **out of scope here**. Do not add them.
- **Slack DMs must be byte-unchanged.** A DM (`event.channel_type === "im"`) keeps `conversationKey = event.channel` and passes **no** `threadTs`. eve's Slack continuation token is `channelId:threadTs`, so DM continuity cannot ride this change — see the spec's Out of scope.
- **Telegram, Discord, and console targets must be byte-unchanged.** `threadTs` is Slack-only; every assertion in the existing `channel-dispatch.test.ts` and `hosted-inbound.core.test.mjs` must still pass untouched.
- **No new dependency.** No new npm package in either app.
- **PR-per-change rule:** branch → push → PR. No direct commits to `main`.
- Spec: `docs/superpowers/specs/2026-07-28-thread-native-jace-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/console/lib/slack-thread.ts` (**create**) | Pure: one Slack message event → `{ conversationKey, threadTs }`. No I/O. |
| `apps/console/lib/slack-thread.test.ts` (**create**) | Table tests for every branch of the above. |
| `apps/console/app/api/v1/connectors/slack/events/route.ts` (**modify**) | Call the pure module; carry `threadTs` into the enqueued payload. |
| `apps/console/lib/channel-dispatch.ts` (**modify**) | Extract `threadTs` from the payload; put it on the Slack hosted-inbound target. |
| `apps/console/lib/channel-dispatch.test.ts` (**modify**) | Assert the Slack target carries `threadTs`, and that other channels don't. |
| `apps/jace/agent/lib/hosted_inbound.core.mjs` (**modify**) | Forward `target.threadTs` through normalization. |
| `apps/jace/test/hosted-inbound.core.test.mjs` (**modify**) | Assert `threadTs` survives normalization and is dropped when absent. |

---

### Task 1: Pure Slack thread resolution

**Files:**
- Create: `apps/console/lib/slack-thread.ts`
- Test: `apps/console/lib/slack-thread.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveSlackThread(event: SlackThreadEvent): SlackThreadTarget`, where
  `SlackThreadEvent = { channel: string; ts?: string; thread_ts?: string; channel_type?: string }`
  and `SlackThreadTarget = { conversationKey: string; threadTs?: string }`.
  Task 2 consumes both fields; Task 3 consumes `threadTs` off the payload.

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/slack-thread.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveSlackThread } from "./slack-thread";

describe("resolveSlackThread", () => {
  it("roots a new thread at the user's own message in a channel", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100" })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("continues an existing thread on its root ts, not the reply ts", () => {
    expect(
      resolveSlackThread({
        channel: "C123",
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
      })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("leaves a DM unthreaded and keyed on the channel", () => {
    expect(
      resolveSlackThread({
        channel: "D999",
        ts: "1700000000.000100",
        channel_type: "im",
      })
    ).toEqual({ conversationKey: "D999" });
  });

  it("keeps a DM keyed on the channel even inside a thread", () => {
    expect(
      resolveSlackThread({
        channel: "D999",
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
        channel_type: "im",
      })
    ).toEqual({ conversationKey: "D999" });
  });

  it("falls back to the channel when ts is missing entirely", () => {
    expect(resolveSlackThread({ channel: "C123" })).toEqual({
      conversationKey: "C123",
    });
  });

  it("treats a blank thread_ts as absent", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100", thread_ts: "  " })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/console && npx vitest run lib/slack-thread.test.ts
```

Expected: FAIL — `Failed to resolve import "./slack-thread"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/console/lib/slack-thread.ts`:

```ts
/**
 * Pure Slack thread resolution for the inbound door (spec
 * docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
 *
 * Two values fall out of one Slack message event:
 *
 *   - `conversationKey` — the STABLE per-conversation id `jace_sessions` and
 *     `channel_inbox` key on. For a channel message this is the THREAD, not
 *     the channel, so a thread is its own conversation. `ts` is unique per
 *     channel, not globally, so the key is compounded with the channel id.
 *   - `threadTs` — what eve's `slackChannel().receive` needs. Verified against
 *     the compiled runtime (apps/jace/.output/server/_libs/eve.mjs): the Slack
 *     continuation token IS `slackContinuationToken(channelId, threadTs)`, and
 *     with no `threadTs` receive falls back to `crypto.randomUUID()` — a fresh
 *     session every turn (#1479's Slack half). It doubles as the thread the
 *     reply posts into, so rooting it at the USER's message is what makes Jace
 *     answer in a thread instead of flat in the channel.
 *
 * DMs are deliberately EXEMPT and byte-unchanged: keyed on the channel, no
 * `threadTs`. Because eve ties continuity to threading, a stable DM session
 * would mean threading every DM reply under one anchor message — pure downside
 * in a DM, where there is no channel to keep clean. DM continuity needs its own
 * design; see the spec's Out of scope.
 */

/** The subset of a Slack `message` event this resolution reads. */
export interface SlackThreadEvent {
  channel: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface SlackThreadTarget {
  conversationKey: string;
  /** Omitted entirely (never `undefined`-valued) when this turn is unthreaded. */
  threadTs?: string;
}

/** Slack marks a direct message with `channel_type: "im"`. */
function isDirectMessage(event: SlackThreadEvent): boolean {
  return event.channel_type === "im";
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveSlackThread(event: SlackThreadEvent): SlackThreadTarget {
  if (isDirectMessage(event)) {
    return { conversationKey: event.channel };
  }
  // An in-thread reply carries the ROOT's ts in `thread_ts`; a top-level
  // message carries none, and roots a new thread at itself.
  const threadTs = trimmed(event.thread_ts) || trimmed(event.ts);
  if (!threadTs) {
    // No ts at all — a shape this door should never see. Degrade to today's
    // channel-keyed behavior rather than invent a key.
    return { conversationKey: event.channel };
  }
  return { conversationKey: `${event.channel}:${threadTs}`, threadTs };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/console && npx vitest run lib/slack-thread.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/slack-thread.ts apps/console/lib/slack-thread.test.ts
git commit -m "feat(slack): pure thread resolution for the inbound door"
```

---

### Task 2: Wire the Slack door to thread-keyed conversations

**Files:**
- Modify: `apps/console/app/api/v1/connectors/slack/events/route.ts:145-167`
- Modify: `apps/console/app/api/v1/connectors/slack/events/route.test.ts` (exists — add to it, follow its existing mock setup rather than the sketch below if they differ)

**Interfaces:**
- Consumes: `resolveSlackThread` from Task 1.
- Produces: a `channel_inbox` row whose `conversationKey` is thread-scoped and whose `payload` carries `threadTs` when threaded. Task 3 reads `payload.threadTs`.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/console/app/api/v1/connectors/slack/events/route.test.ts`. Mock the two db-postgres calls and the dispatch kick, then assert on what `enqueueChannelMessage` received:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueChannelMessage = vi.fn(async () => ({ deduped: false }));
const resolveInboundChatIdentity = vi.fn(async () => ({
  identity: { id: "ident-1", workspaceId: "ws-1" },
}));

vi.mock("@agentrail/db-postgres", () => ({
  enqueueChannelMessage,
  resolveInboundChatIdentity,
}));
vi.mock("../../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(async () => ({ processed: 0, failed: 0 })),
}));
vi.mock("../../../../../../lib/slack-bot", () => ({
  verifySlackSignature: () => true,
}));

import { POST } from "./route";

function post(event: Record<string, unknown>) {
  return POST(
    new Request("https://console.test/api/v1/connectors/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "event_callback", event_id: "Ev1", event }),
    }) as never
  );
}

describe("slack events door — threading", () => {
  beforeEach(() => {
    enqueueChannelMessage.mockClear();
  });

  it("keys a top-level channel message on its own thread and carries threadTs", async () => {
    await post({
      type: "message",
      channel: "C123",
      user: "U1",
      text: "hello jace",
      ts: "1700000000.000100",
    });
    const arg = enqueueChannelMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["conversationKey"]).toBe("C123:1700000000.000100");
    expect((arg["payload"] as Record<string, unknown>)["threadTs"]).toBe(
      "1700000000.000100"
    );
  });

  it("keys an in-thread reply on the thread root", async () => {
    await post({
      type: "message",
      channel: "C123",
      user: "U1",
      text: "and another thing",
      ts: "1700000009.000900",
      thread_ts: "1700000000.000100",
    });
    const arg = enqueueChannelMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["conversationKey"]).toBe("C123:1700000000.000100");
    expect((arg["payload"] as Record<string, unknown>)["threadTs"]).toBe(
      "1700000000.000100"
    );
  });

  it("leaves a DM byte-unchanged — channel-keyed, no threadTs", async () => {
    await post({
      type: "message",
      channel: "D999",
      channel_type: "im",
      user: "U1",
      text: "hi",
      ts: "1700000000.000100",
    });
    const arg = enqueueChannelMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["conversationKey"]).toBe("D999");
    expect(arg["payload"]).not.toHaveProperty("threadTs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/console && npx vitest run "app/api/v1/connectors/slack/events/route.test.ts"
```

Expected: FAIL — first test reports `conversationKey` is `"C123"`, not `"C123:1700000000.000100"`.

- [ ] **Step 3: Write minimal implementation**

In `apps/console/app/api/v1/connectors/slack/events/route.ts`, add to the imports:

```ts
import { resolveSlackThread } from "../../../../../../lib/slack-thread";
```

Add `thread_ts` to the event interface:

```ts
interface SlackMessageEvent {
  type: string;
  channel?: string;
  user?: string;
  text?: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
}
```

Then, immediately before the `enqueueChannelMessage` call, resolve the thread, and replace the `conversationKey` and `payload` fields:

```ts
  // Thread-scoped conversation key + the thread eve must reply in. A channel
  // message is its own conversation per THREAD (see lib/slack-thread.ts); a DM
  // is exempt and byte-unchanged.
  const thread = resolveSlackThread({
    channel: event.channel,
    ts: event.ts,
    thread_ts: event.thread_ts,
    channel_type: event.channel_type,
  });

  const result = await enqueueChannelMessage({
    ...anchor,
    channel: "slack",
    conversationKey: thread.conversationKey,
    kind: "message",
    senderId: event.user,
    providerMessageId: `${event.channel}:${body.event_id ?? event.ts}`,
    payload: {
      chatId: event.channel,
      text: event.text,
      fromId: event.user,
      // Slack-only; omitted (never written as `undefined`) for a DM, so a DM
      // payload stays byte-identical to today's. channel-dispatch.ts's
      // extractPayload reads this back.
      ...(thread.threadTs !== undefined ? { threadTs: thread.threadTs } : {}),
    },
  });
```

Leave `providerMessageId` keyed on `event.channel` — it is a redelivery dedupe key over Slack's globally-unique `event_id`, not a conversation key, and re-keying it would let one event enqueue twice.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/console && npx vitest run "app/api/v1/connectors/slack/events/route.test.ts"
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/app/api/v1/connectors/slack/events/route.ts apps/console/app/api/v1/connectors/slack/events/route.test.ts
git commit -m "feat(slack): key channel conversations on the thread, carry threadTs"
```

---

### Task 3: Carry `threadTs` through the dispatcher onto the Slack target

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts` — `TelegramInboxPayload` (~line 171), `extractPayload` (~line 215), `runEveTurn` (~line 405), and the `runEveTurn` call site (~line 956)
- Test: `apps/console/lib/channel-dispatch.test.ts`

**Interfaces:**
- Consumes: `payload.threadTs` written by Task 2.
- Produces: a hosted-inbound request body whose `target` is `{ channelId, threadTs }` for a threaded Slack turn. Task 4 normalizes it.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/lib/channel-dispatch.test.ts`. That file already has a `row()` factory (line 88), a `mockFetch` stub installed in `beforeEach` (line 110), and drives a turn with `mockClaim.mockResolvedValueOnce(row({...})).mockResolvedValueOnce(null)` — reuse all three exactly as the existing "a normal message row still reaches the Eve turn" test does (line 355). Add one small helper next to `row()`:

```ts
/** The parsed hosted-inbound request body from the single Eve turn a test drove. */
function hostedInboundBody(): {
  channel: string;
  message: string;
  target: Record<string, unknown>;
} {
  const init = mockFetch.mock.calls[0]![1] as { body: string };
  return JSON.parse(init.body);
}
```

Then the three tests:

```ts
describe("dispatchQueuedChannelMessages — slack threadTs", () => {
  it("puts threadTs on the slack hosted-inbound target", async () => {
    mockClaim
      .mockResolvedValueOnce(
        row({
          channel: "slack",
          conversationKey: "C123:1700000000.000100",
          payload: {
            chatId: "C123",
            text: "hello",
            fromId: "U1",
            threadTs: "1700000000.000100",
          },
        })
      )
      .mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(hostedInboundBody().target).toEqual({
      channelId: "C123",
      threadTs: "1700000000.000100",
    });
  });

  it("omits threadTs for an unthreaded slack turn (DM)", async () => {
    mockClaim
      .mockResolvedValueOnce(
        row({
          channel: "slack",
          conversationKey: "D999",
          payload: { chatId: "D999", text: "hi", fromId: "U1" },
        })
      )
      .mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(hostedInboundBody().target).toEqual({ channelId: "D999" });
  });

  it("never puts threadTs on a telegram target", async () => {
    mockClaim
      .mockResolvedValueOnce(
        row({
          payload: {
            chatId: -100123,
            text: "hi",
            threadTs: "1700000000.000100",
          },
        })
      )
      .mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(hostedInboundBody().target).not.toHaveProperty("threadTs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/console && npx vitest run lib/channel-dispatch.test.ts -t threadTs
```

Expected: FAIL — the first test gets `{ channelId: "C123" }`, with no `threadTs`.

- [ ] **Step 3: Write minimal implementation**

Three edits in `apps/console/lib/channel-dispatch.ts`.

(a) Add the field to `TelegramInboxPayload`, after `applicationId`:

```ts
  /**
   * Slack-only (#1479's Slack half): the thread this conversation lives in.
   * Set by the Slack door from `resolveSlackThread`. eve's Slack continuation
   * token IS `channelId:threadTs` — with none, `slackChannel().receive` falls
   * back to `crypto.randomUUID()` and every turn starts a new session. A
   * telegram/discord payload never carries this.
   */
  threadTs?: string;
```

(b) In `extractPayload`, after the `applicationId` block, extract it with the same tolerance as its neighbors:

```ts
  const threadTs = p["threadTs"];
  if (typeof threadTs === "string" && threadTs.trim()) {
    result.threadTs = threadTs;
  }
```

(c) In `runEveTurn`, add the parameter and put it on the target. Add to the params type, next to `messageThreadId`:

```ts
  /** Slack-only — see TelegramInboxPayload.threadTs. Ignored for every other
   * channel, so their targets stay byte-unchanged. */
  threadTs?: string;
```

and extend the target literal:

```ts
  const target =
    params.target ??
    {
      [targetKey]: params.chatId,
      ...(pinnedConversationId !== undefined && pinnedConversationId !== ""
        ? { conversationId: pinnedConversationId }
        : {}),
      ...(params.messageThreadId !== undefined
        ? { messageThreadId: params.messageThreadId }
        : {}),
      ...(channel === "slack" && params.threadTs !== undefined
        ? { threadTs: params.threadTs }
        : {}),
    };
```

(d) At the `runEveTurn` call site (~line 956, where `messageThreadId: payload.messageThreadId` is already passed), add:

```ts
      threadTs: payload.threadTs,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/console && npx vitest run lib/channel-dispatch.test.ts
```

Expected: PASS — the three new tests plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/channel-dispatch.ts apps/console/lib/channel-dispatch.test.ts
git commit -m "feat(slack): carry threadTs onto the hosted-inbound target"
```

---

### Task 4: Forward `threadTs` through hosted-inbound normalization

**Files:**
- Modify: `apps/jace/agent/lib/hosted_inbound.core.mjs` — the non-console branch of `normalizeHostedInbound`
- Test: `apps/jace/test/hosted-inbound.core.test.mjs`

**Interfaces:**
- Consumes: the request body Task 3 produces.
- Produces: `normalizeHostedInbound(raw).target.threadTs` reaching `args.receive(slack, …)`, which eve turns into `slackContinuationToken(channelId, threadTs)`.

- [ ] **Step 1: Write the failing test**

Add to `apps/jace/test/hosted-inbound.core.test.mjs`, matching that file's existing `node --test` style:

```js
test("forwards target.threadTs for slack", () => {
  const result = normalizeHostedInbound({
    channel: "slack",
    message: "hello",
    target: { channelId: "C123", threadTs: "1700000000.000100" },
    auth: { workspaceId: "ws-1" },
  });
  assert.deepEqual(result.target, {
    channelId: "C123",
    threadTs: "1700000000.000100",
  });
});

test("omits threadTs when absent rather than writing undefined", () => {
  const result = normalizeHostedInbound({
    channel: "slack",
    message: "hello",
    target: { channelId: "D999" },
    auth: { workspaceId: "ws-1" },
  });
  assert.deepEqual(result.target, { channelId: "D999" });
  assert.ok(!("threadTs" in result.target));
});

test("drops a blank threadTs", () => {
  const result = normalizeHostedInbound({
    channel: "slack",
    message: "hello",
    target: { channelId: "C123", threadTs: "   " },
    auth: { workspaceId: "ws-1" },
  });
  assert.deepEqual(result.target, { channelId: "C123" });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/jace && node --test test/hosted-inbound.core.test.mjs
```

Expected: FAIL — first test reports `target` is `{ channelId: "C123" }`, missing `threadTs`.

- [ ] **Step 3: Write minimal implementation**

In `apps/jace/agent/lib/hosted_inbound.core.mjs`, in the `else` (non-console) branch, after the `messageThreadId` forward:

```js
    // Slack-only (#1479's Slack half): eve's `slackChannel().receive` derives
    // its continuation token as `slackContinuationToken(channelId, threadTs)`
    // and falls back to `crypto.randomUUID()` without one — a brand-new
    // session every turn. Forwarded UNCHANGED, exactly like conversationId
    // above; this module does not interpret it. A blank string is treated as
    // absent so it can never produce the token `"C123:"`.
    if (typeof target.threadTs === "string" && target.threadTs.trim()) {
      normalizedTarget.threadTs = target.threadTs;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/jace && node --test test/hosted-inbound.core.test.mjs
```

Expected: PASS — the three new tests plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/lib/hosted_inbound.core.mjs apps/jace/test/hosted-inbound.core.test.mjs
git commit -m "feat(slack): forward target.threadTs through hosted-inbound"
```

---

### Task 5: Full-suite verification and PR

**Files:** none modified — this task proves the change and opens the PR.

- [ ] **Step 1: Run the console suite**

```bash
cd apps/console && npx vitest run
```

Expected: PASS. Any pre-existing failure must be confirmed to also fail on `main` before proceeding — do not absorb it into this PR.

- [ ] **Step 2: Run the jace suite**

```bash
cd apps/jace && node --test test/
```

Expected: PASS, all files.

- [ ] **Step 3: Confirm no other channel's target changed**

```bash
cd apps/console && npx vitest run lib/channel-dispatch.test.ts --reporter=verbose 2>&1 | grep -iE "telegram|discord|console"
```

Expected: every pre-existing telegram/discord/console target assertion still passing.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/slack-thread-continuity
gh pr create --title "feat(slack): thread-native channel replies and conversation continuity" --body "$(cat <<'EOF'
Slack channel messages now become their own thread-scoped conversation, and Jace answers inside a thread rooted at the user's message.

Verified against eve@0.19.0's compiled runtime (`apps/jace/.output/server/_libs/eve.mjs`): `slackChannel().receive` derives its continuation token as `slackContinuationToken(channelId, threadTs)` and falls back to `crypto.randomUUID()` when no `threadTs` is supplied — so every console-dispatched Slack turn was starting a brand-new session. `onThreadTsChanged` then re-keyed the live session to Jace's own first reply ts, the Slack twin of the Discord `anchor()` bug in #1479.

PR 1 of the thread-native arc (spec: `docs/superpowers/specs/2026-07-28-thread-native-jace-design.md`). Discord thread creation, the shared engagement state machine, and the `engagement_dormant_since` migration are deliberately NOT here.

**Slack DMs are byte-unchanged.** eve ties Slack continuity to threading, so a stable DM session would mean threading every DM reply under one anchor message. That needs its own design; DMs keep today's behavior exactly.

## Verification
- `apps/console`: full vitest suite green.
- `apps/jace`: `node --test test/` green.
- Prod (post-merge): a channel mention gets a threaded reply; a second reply in that thread reaches a Jace that remembers the first.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Prod verification after deploy**

Once Railway has deployed the console, in a Slack channel the bot is in:

1. Post `@Jace what repos do I have?` → the reply lands **in a thread** on that message.
2. Reply **in that thread**: `and which has the most open issues?` → Jace answers in the same thread and the answer shows it remembered the first question.
3. Confirm exactly one `jace_sessions` row exists for `channel = 'slack'` and `conversation_key = '<C…>:<ts>'` — not one per turn:

```bash
psql "$DATABASE_PUBLIC_URL" -c "select conversation_key, eve_session_id, created_at from jace_sessions where channel='slack' order by created_at desc limit 10;"
```

Expected: the two turns share one row with one `eve_session_id`. Two rows means the continuation token is still not matching — stop and re-read `receive` in the compiled runtime before patching further.

4. DM the bot twice and confirm its behavior is unchanged from before this PR (replies top-level, no threading).

---

## Self-Review

**Spec coverage.** This plan covers the spec's Slack half: `thread_ts` capture (Task 2), target forwarding (Tasks 3–4), thread-scoped conversation keys (Tasks 1–2), and the channel-continuity proof (Task 5). The spec's Discord half — adapters/envelope, `thread-engagement.core.mjs`, `engagement_dormant_since` + the `(channel, conversation_key)` index, thread creation, the followup fallback, and the `jaceThreadReplies` flag — is deliberately deferred to PR 2, per the owner's sequencing decision that the conversationKey model be validated first. **No task here implements the engagement state machine, and none should.**

**No flag in PR 1.** The spec puts thread behavior behind `jaceThreadReplies` default OFF. That flag governs *Discord thread creation*, which is the change that alters the delivery path and depends on bot permissions. Slack threading needs no new scope and no new API call, and gating it OFF would make the continuity fix a no-op — the flag would ship dead code. PR 2 introduces the flag with the behavior it actually guards.

**Type consistency.** `resolveSlackThread` / `SlackThreadEvent` / `SlackThreadTarget` (Task 1) are used under those exact names in Task 2. The payload field is `threadTs` in Tasks 2, 3, and 4; the wire target field is `threadTs` in Tasks 3 and 4. The Slack event field is snake_case `thread_ts` at the door only (Task 2), converted at the `resolveSlackThread` boundary.

**Known risk — CORRECTED after the whole-branch review.** Task 2 changes `conversationKey` for Slack channel messages. The original note here claimed "there is nothing live to orphan, since no Slack channel conversation can currently resume at all." That is true of the **eve session** and **false of the workspace pin**, which lives in `jace_sessions` and does resume today: `resolveConversationWorkspace` looks the pin up by `(channel, conversationKey)` alone, so after deploy every existing Slack channel pinned under `<channel>` is dead. Consequences by identity:

- 1 reachable workspace → silent per-thread re-pin; invisible to the user, but one `jace_sessions` row per thread from now on.
- 0 reachable → the intro/onboarding flow restarts in each new thread.
- 2+ reachable → **was a hard loop** until the final-review fix: the workspace picker posted flat in the channel while the conversation was keyed to the thread, so the user's flat reply landed on a *new* unpinned key and got asked again forever. Fixed by threading the console's own Slack system sends (`sendSystemChannelMessage` → `sendSystemSlackMessage` → `sendSlackChannelMessage` now carry `thread_ts`).

Do not port this key change to Telegram, whose sessions do resume.
