# Thread Engagement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once Jace has spoken in a thread, the person who engaged it can keep talking without re-mentioning — and Jace goes quiet when someone else joins or the thread stops being about it, until re-mentioned.

**Architecture:** Platform doors normalize their events into a channel-agnostic envelope and decide nothing. One pure console-side state machine answers "is this message a turn?" from the envelope plus two persisted values on `jace_sessions`. The door gates cheaply on those same values; the dispatcher, which already loads that row, makes the real decision.

**Tech Stack:** TypeScript (Next.js console, vitest), Drizzle migrations, plain ESM + JSDoc (`apps/jace`, `node --test`).

## Global Constraints

- **This is PR 2 of the thread-native arc, part 1 of 2.** It ships the engagement rule for **both** Discord and Slack. **Jace opening a thread itself** (Discord `POST /channels/{id}/messages/{msgId}/threads`, the interaction-followup fallback, and the `jaceThreadReplies` flag) is **part 2 and out of scope here.** Do not build it.
- **DMs are exempt from engagement entirely.** A DM is always a turn, exactly as today. Engagement applies only to threads.
- **A thread is one-on-one by default.** A message from anyone other than the thread's engaged speaker, carrying no mention of Jace, bows Jace out. Owner's words, 2026-07-28: *"the point of a thread is for one on one communication… when another user joins and mentions something not related, Jace ignores it unless it's been mentioned in the thread."*
- **Fails toward silence.** An un-mentioned message we are unsure about is not answered. A wrong bow-out costs one `@Jace`; a wrong engagement spams a human conversation.
- **This CHANGES Slack behavior, deliberately.** Slack's door today enqueues every non-bot, non-subtype `message` event with no mention gate at all. After this, an un-engaged Slack thread needs a mention like Discord does. That is the fix, not a regression.
- **Telegram, console, and iMessage paths must be byte-unchanged.** Engagement is Discord + Slack only.
- **PR-per-change rule:** branch → push → PR. No direct commits to `main`.
- Spec: `docs/superpowers/specs/2026-07-28-thread-native-jace-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db-postgres/src/schema/jace_sessions.ts` (**modify**) | Two nullable columns + one index. |
| `packages/db-postgres/drizzle/migrations/0058_thread_engagement.sql` (**create**) | The migration. Slot 0058 — main is at 0057. |
| `packages/db-postgres/src/queries/jace_sessions.ts` (**modify**) | `getThreadEngagement` / `setThreadEngagement`. |
| `apps/console/lib/thread-engagement.ts` (**create**) | Pure: envelope + state → `{ turn, nextState, reason }`. No I/O. |
| `apps/console/lib/thread-engagement.test.ts` (**create**) | Table tests over every transition. |
| `apps/console/app/api/v1/connectors/discord/webhook/route.ts` (**modify**) | Emit envelope fields. |
| `apps/console/app/api/v1/runner/discord-inbound/route.ts` (**modify**) | Emit envelope fields from the Gateway door. |
| `apps/console/lib/discord-inbound.ts` (**modify**) | Carry envelope fields into the payload; gate at the door. |
| `apps/console/app/api/v1/connectors/slack/events/route.ts` (**modify**) | Emit envelope fields; gate at the door. |
| `apps/console/lib/channel-dispatch.ts` (**modify**) | Run `decideEngagement`; skip or run the turn; persist the new state. |
| `apps/jace/agent/lib/discord_gateway.core.mjs` (**modify**) | Stop deciding admission; report mention/reply facts. |
| `apps/jace/agent/lib/discord-gateway.mjs` (**modify**) | Track thread ids from `GUILD_CREATE`/`THREAD_CREATE`; forward thread messages. |

---

### Task 1: Schema + migration for the two engagement values

**Files:**
- Modify: `packages/db-postgres/src/schema/jace_sessions.ts`
- Create: `packages/db-postgres/drizzle/migrations/0058_thread_engagement.sql`
- Modify: `packages/db-postgres/drizzle/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `jaceSessions.engagementDormantSince` (`timestamptz`, nullable), `jaceSessions.engagedSpeakerId` (`text`, nullable), and index `jace_sessions_channel_conversation_idx` on `(channel, conversation_key)`. Tasks 2 and 6 consume these.

**CRITICAL — migration slot.** `main` is at `0057_guardrail_events` (journal idx 58). Take `0058`, journal idx 59. Before writing, run `ls packages/db-postgres/drizzle/migrations/*.sql | tail -3` and confirm nothing already holds 0058. A migration missing from `_journal.json` is **silently skipped** — the journal entry is not optional.

- [ ] **Step 1: Confirm the free slot**

```bash
ls packages/db-postgres/drizzle/migrations/*.sql | tail -3
python3 -c "import json;d=json.load(open('packages/db-postgres/drizzle/migrations/meta/_journal.json'));print(d['entries'][-1])"
```

Expected: last SQL is `0057_guardrail_events.sql`; last journal entry is `idx 58, tag 0057_guardrail_events`.

- [ ] **Step 2: Add the columns and index to the Drizzle schema**

In `packages/db-postgres/src/schema/jace_sessions.ts`, add to the `jaceSessions` column block, after `lastActivityAt`:

```ts
    /**
     * Thread engagement (spec: docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
     *
     * NULL = Jace is engaged in this thread (or it is not a thread at all).
     * Non-null = Jace bowed out at this instant and stays quiet until someone
     * mentions it again. Only the DORMANT state is stored: "never engaged" is
     * the absence of this row, and "engaged" is this row with the latch clear,
     * so neither needs a column. Dormant is irreducible because it is set by a
     * message that produces NO turn and NO `channel_inbox` row — nothing else
     * in the system observes it.
     */
    engagementDormantSince: timestamp("engagement_dormant_since", {
      withTimezone: true,
    }),
    /**
     * The platform user id whose message last engaged this thread. A message
     * from anyone else, carrying no mention of Jace, is a speaker change and
     * bows Jace out — the structural proxy for the owner's "a thread is
     * one-on-one" rule, since "unrelated" is semantic and a per-message model
     * call was rejected.
     *
     * NOT derivable: `channel_inbox` is a work QUEUE (rows are claimed,
     * completed and pruned), so it is no durable record of who Jace last
     * answered. Never used for attribution — that stays on the turn's own
     * chat identity.
     */
    engagedSpeakerId: text("engaged_speaker_id"),
```

and add to the table's index block, alongside `introConversationUnique`:

```ts
    // The door's engagement gate looks up by (channel, conversation_key) with
    // NO workspace in hand. `jace_sessions_conversation_unique` leads with
    // workspace_id (unusable here) and `jace_sessions_intro_conversation_idx`
    // is partial (workspace_id IS NULL), so it covers intro rows only —
    // without this index the gate seq-scans for every graduated session.
    channelConversationIdx: index("jace_sessions_channel_conversation_idx").on(
      t.channel,
      t.conversationKey
    ),
```

Add `index` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 3: Write the migration SQL**

Create `packages/db-postgres/drizzle/migrations/0058_thread_engagement.sql`:

```sql
ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "engagement_dormant_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "engaged_speaker_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jace_sessions_channel_conversation_idx" ON "jace_sessions" USING btree ("channel","conversation_key");
```

- [ ] **Step 4: Register it in the journal**

Append to `entries` in `packages/db-postgres/drizzle/migrations/meta/_journal.json`, matching the existing entry shape exactly (copy the previous entry's keys; `when` is a millisecond epoch — use `1785283200000`):

```json
{ "idx": 59, "version": "7", "when": 1786100000000, "tag": "0058_thread_engagement", "breakpoints": true }
```

(`when` must be LATER than the previous entry's `1786000000000` — the journal is time-ordered.)

- [ ] **Step 5: Verify the package builds and the journal parses**

```bash
cd packages/db-postgres && pnpm build
python3 -c "import json;d=json.load(open('drizzle/migrations/meta/_journal.json'));e=d['entries'][-1];assert e['tag']=='0058_thread_engagement' and e['idx']==59, e;print('journal OK:', e)"
```

Expected: build clean, `journal OK` printed.

- [ ] **Step 6: Commit**

```bash
git add packages/db-postgres/src/schema/jace_sessions.ts packages/db-postgres/drizzle/migrations/0058_thread_engagement.sql packages/db-postgres/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): thread engagement — dormant latch and engaged speaker"
```

---

### Task 2: The pure engagement state machine

**Files:**
- Create: `apps/console/lib/thread-engagement.ts`
- Test: `apps/console/lib/thread-engagement.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces, consumed by Tasks 3–6:

```ts
export interface ThreadInbound {
  channel: "discord" | "slack";
  isDM: boolean;
  threadId: string | null;
  senderId: string;
  mentionsBot: boolean;
  mentionsOtherUsers: boolean;
  repliesToMessageId: string | null;
  repliesToBot: boolean;
}
export interface EngagementState {
  dormantSince: Date | null;
  engagedSpeakerId: string | null;
}
export interface EngagementDecision {
  turn: boolean;
  nextState: EngagementState;
  reason: string;
}
export function decideEngagement(args: {
  inbound: ThreadInbound;
  state: EngagementState | null;   // null = no session row = never engaged
  now: Date;                        // injected; never reads the clock itself
}): EngagementDecision;
```

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/thread-engagement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideEngagement, type ThreadInbound } from "./thread-engagement";

const NOW = new Date("2026-07-28T12:00:00Z");
const ENGAGED = { dormantSince: null, engagedSpeakerId: "U1" };

function inbound(over: Partial<ThreadInbound> = {}): ThreadInbound {
  return {
    channel: "discord",
    isDM: false,
    threadId: "T1",
    senderId: "U1",
    mentionsBot: false,
    mentionsOtherUsers: false,
    repliesToMessageId: null,
    repliesToBot: false,
    ...over,
  };
}

describe("decideEngagement", () => {
  it("always answers a DM, regardless of state", () => {
    const d = decideEngagement({
      inbound: inbound({ isDM: true, threadId: null }),
      state: { dormantSince: NOW, engagedSpeakerId: "U9" },
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState.dormantSince).toBeNull();
  });

  it("answers a channel message that mentions Jace and engages the sender", () => {
    const d = decideEngagement({
      inbound: inbound({ threadId: null, mentionsBot: true, senderId: "U7" }),
      state: null,
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U7" });
  });

  it("ignores a channel message with no mention and no session", () => {
    const d = decideEngagement({ inbound: inbound({ threadId: null }), state: null, now: NOW });
    expect(d.turn).toBe(false);
  });

  it("answers an un-mentioned follow-up from the engaged speaker", () => {
    const d = decideEngagement({ inbound: inbound(), state: ENGAGED, now: NOW });
    expect(d.turn).toBe(true);
    expect(d.nextState.dormantSince).toBeNull();
  });

  it("bows out when a DIFFERENT person posts without mentioning Jace", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U2" }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("bows out when the engaged speaker @-mentions someone else", () => {
    const d = decideEngagement({
      inbound: inbound({ mentionsOtherUsers: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("bows out on a reply to a non-Jace message", () => {
    const d = decideEngagement({
      inbound: inbound({ repliesToMessageId: "M9", repliesToBot: false }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("still answers a reply to Jace's own message", () => {
    const d = decideEngagement({
      inbound: inbound({ repliesToMessageId: "M9", repliesToBot: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(true);
  });

  it("mentioning Jace beats every bow-out signal", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U2", mentionsBot: true, mentionsOtherUsers: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U2" });
  });

  it("stays quiet on an un-mentioned message while dormant", () => {
    const d = decideEngagement({
      inbound: inbound(),
      state: { dormantSince: NOW, engagedSpeakerId: "U1" },
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("re-engages a dormant thread on a mention, from whoever sends it", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U5", mentionsBot: true }),
      state: { dormantSince: NOW, engagedSpeakerId: "U1" },
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U5" });
  });

  it("treats a thread with a session row but no engaged speaker as needing a mention", () => {
    const d = decideEngagement({
      inbound: inbound(),
      state: { dormantSince: null, engagedSpeakerId: null },
      now: NOW,
    });
    expect(d.turn).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/console && npx vitest run lib/thread-engagement.test.ts
```

Expected: FAIL — `Failed to resolve import "./thread-engagement"`.

- [ ] **Step 3: Write the implementation**

Create `apps/console/lib/thread-engagement.ts`:

```ts
/**
 * The ONE engagement rule, shared by Discord and Slack (spec:
 * docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
 *
 * Engagement is CONVERSATION STATE, not per-message classification. The
 * heuristic answers only one question: *has this conversation stopped being
 * about Jace?* Deterministic, no network, no model call — the same posture as
 * `apps/jace/agent/lib/intent-classifier.core.mjs`, and for the same reason:
 * a rule a test can pin beats a rule that is merely clever.
 *
 * Transports differ in what evidence they can supply (Slack has no in-channel
 * reply primitive, so `repliesToMessageId` is always null there) but NOT in
 * semantics — every channel runs this exact table, so Discord and Slack can
 * never drift into different conversational behavior.
 *
 * FAILS TOWARD SILENCE. An un-mentioned message we are unsure about is not
 * answered. A wrong bow-out costs the user one `@Jace`; a wrong engagement
 * spams a human conversation that asked Jace to stay out.
 */

export interface ThreadInbound {
  channel: "discord" | "slack";
  /** DMs are exempt from engagement entirely — always a turn. */
  isDM: boolean;
  /** Null when the message is in the channel proper, not a thread. */
  threadId: string | null;
  senderId: string;
  mentionsBot: boolean;
  /** True when the message @-mentions a human/role that is not Jace. */
  mentionsOtherUsers: boolean;
  /** Discord `message_reference`; ALWAYS null on Slack, which has no
   * in-channel reply primitive (a Slack reply IS a thread). */
  repliesToMessageId: string | null;
  repliesToBot: boolean;
}

export interface EngagementState {
  dormantSince: Date | null;
  engagedSpeakerId: string | null;
}

export interface EngagementDecision {
  turn: boolean;
  nextState: EngagementState;
  reason: string;
}

/** Engaged = a session row exists, the latch is clear, and we know who Jace
 * was talking to. A row with no `engagedSpeakerId` predates this feature, so
 * it needs a mention to (re-)establish who owns the thread. */
function isEngaged(state: EngagementState | null): state is EngagementState & {
  engagedSpeakerId: string;
} {
  return (
    state !== null && state.dormantSince === null && state.engagedSpeakerId !== null
  );
}

export function decideEngagement(args: {
  inbound: ThreadInbound;
  state: EngagementState | null;
  now: Date;
}): EngagementDecision {
  const { inbound, state, now } = args;

  // A DM is one conversation with one person — there is no channel to keep
  // clean and nobody else to bow out for.
  if (inbound.isDM) {
    return {
      turn: true,
      nextState: { dormantSince: null, engagedSpeakerId: inbound.senderId },
      reason: "direct message",
    };
  }

  // An explicit mention always wins, from anyone, in any state. It is the one
  // unambiguous signal that this message is FOR Jace, and it is how a dormant
  // thread is brought back.
  if (inbound.mentionsBot) {
    return {
      turn: true,
      nextState: { dormantSince: null, engagedSpeakerId: inbound.senderId },
      reason: "mentions the bot",
    };
  }

  const keep = (reason: string): EngagementDecision => ({
    turn: false,
    nextState: state ?? { dormantSince: null, engagedSpeakerId: null },
    reason,
  });

  // Outside a thread, or in a thread Jace has never spoken in, a mention is
  // required — and there wasn't one.
  if (inbound.threadId === null) {
    return keep("channel message without a mention of the bot");
  }
  if (!isEngaged(state)) {
    return keep(
      state?.dormantSince
        ? "thread is dormant and this message does not mention the bot"
        : "no engaged session for this thread"
    );
  }

  const bowOut = (reason: string): EngagementDecision => ({
    turn: false,
    nextState: { dormantSince: now, engagedSpeakerId: state.engagedSpeakerId },
    reason,
  });

  // A thread is one-on-one by default: somebody else is talking now.
  if (inbound.senderId !== state.engagedSpeakerId) {
    return bowOut("another participant posted without mentioning the bot");
  }
  // The engaged speaker has turned to address someone else.
  if (inbound.mentionsOtherUsers) {
    return bowOut("mentions another user");
  }
  // ...or is replying to a human, not to Jace.
  if (inbound.repliesToMessageId !== null && !inbound.repliesToBot) {
    return bowOut("replies to a non-bot message");
  }

  return {
    turn: true,
    nextState: { dormantSince: null, engagedSpeakerId: state.engagedSpeakerId },
    reason: "engaged thread, no bow-out signal",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/console && npx vitest run lib/thread-engagement.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the tests have teeth**

Mutate the implementation and confirm a specific test fails each time, restoring after each:

1. Delete the `inbound.senderId !== state.engagedSpeakerId` branch → "bows out when a DIFFERENT person posts" must FAIL.
2. Move the `mentionsBot` check below the dormant check → "re-engages a dormant thread on a mention" must FAIL.
3. Change `isEngaged` to ignore `engagedSpeakerId` → "treats a thread with a session row but no engaged speaker" must FAIL.

If any mutation leaves the suite green, the test is not pinning the behavior — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/thread-engagement.ts apps/console/lib/thread-engagement.test.ts
git commit -m "feat(engagement): the shared thread engagement state machine"
```

---

### Task 3: Engagement queries

**Files:**
- Modify: `packages/db-postgres/src/queries/jace_sessions.ts`
- Test: `packages/db-postgres/src/queries/jace_sessions-engagement.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's columns; Task 2's `EngagementState`.
- Produces, consumed by Tasks 4–6:

```ts
export async function getThreadEngagement(args: {
  channel: string;
  conversationKey: string;
}): Promise<{ dormantSince: Date | null; engagedSpeakerId: string | null } | null>;

export async function setThreadEngagement(args: {
  channel: string;
  conversationKey: string;
  dormantSince: Date | null;
  engagedSpeakerId: string | null;
}): Promise<void>;
```

`getThreadEngagement` returns `null` when no session row exists — the "never engaged" case. It queries by `(channel, conversation_key)` only, which is what Task 1's new index serves. `setThreadEngagement` updates every row matching that pair and is a no-op when none exists.

- [ ] **Step 1: Write the failing test**

Follow the conventions of the sibling tests in that directory (e.g. `jace_sessions-by-id.test.ts`) for database setup and teardown — read one before writing. Cover: a missing row returns `null`; a row with both values null round-trips as `{dormantSince: null, engagedSpeakerId: null}`; setting then getting round-trips a Date and an id; setting against a non-existent conversation does not throw.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd packages/db-postgres && pnpm vitest run src/queries/jace_sessions-engagement.test.ts
```

Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Implement both queries**

Add to `packages/db-postgres/src/queries/jace_sessions.ts`, following the file's existing query style (same `db` import, same `and`/`eq` usage). Export both from `packages/db-postgres/src/queries/index.ts` if that file re-exports per-symbol rather than star-exporting — check before assuming.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd packages/db-postgres && pnpm vitest run src/queries/jace_sessions-engagement.test.ts && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/db-postgres/src/queries/jace_sessions.ts packages/db-postgres/src/queries/jace_sessions-engagement.test.ts packages/db-postgres/src/queries/index.ts
git commit -m "feat(db): read and write thread engagement state"
```

---

### Task 4: Discord Gateway adapter — report facts, decide nothing

**Files:**
- Modify: `apps/jace/agent/lib/discord_gateway.core.mjs`
- Modify: `apps/jace/agent/lib/discord-gateway.mjs`
- Test: `apps/jace/test/discord_gateway.core.test.mjs`

**Interfaces:**
- Produces: `shapeInboundPayload` gains `threadId`, `mentionsBot`, `mentionsOtherUsers`, `repliesToMessageId`, `repliesToBot`. `admitMessage` is replaced by `screenMessage`, which no longer applies the mention rule.

The Gateway listener currently drops any guild message that does not mention the bot. That decision moves to the console, so this adapter must forward more: **DMs, mentions, and every message in a known thread.**

- [ ] **Step 1: Write the failing tests**

Add to `apps/jace/test/discord_gateway.core.test.mjs`, matching its existing `node --test` style. Cover:
- `screenMessage` still rejects bot authors, malformed payloads, and empty content.
- `screenMessage` ADMITS an un-mentioned guild message when `isThread` is true.
- `screenMessage` REJECTS an un-mentioned guild message when `isThread` is false.
- `screenMessage` still admits DMs and mentions.
- `shapeInboundPayload` sets `mentionsBot` true only when the bot is in `mentions`.
- `shapeInboundPayload` sets `mentionsOtherUsers` true when `mentions` contains a non-bot user, false when it contains only the bot.
- `shapeInboundPayload` reads `message_reference.message_id` into `repliesToMessageId`, null when absent.
- `repliesToBot` is true only when `referenced_message.author.bot === true`.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/jace && node --test test/discord_gateway.core.test.mjs
```

- [ ] **Step 3: Implement**

Replace `admitMessage` with:

```js
/**
 * Screen a raw MESSAGE_CREATE for TRANSPORT-level noise only — this function
 * no longer decides whether Jace should answer. That is the console's
 * engagement rule (`apps/console/lib/thread-engagement.ts`), which needs
 * conversation state this process has no access to.
 *
 * Forwarded: DMs, anything mentioning the bot, and EVERY message in a known
 * thread (the console decides those). Still dropped here, because no state
 * could change the answer: bot authors (including our own — the infinite
 * ping-pong guard), malformed payloads, empty content, and a guild message
 * that is nothing but the bot's own mention token.
 *
 * @param {boolean} isThread whether `channel_id` is a thread — resolved by the
 *   socket wrapper from its live thread-id set, since a MESSAGE_CREATE payload
 *   carries no channel type.
 */
export function screenMessage(message, botUserId, isThread) { /* ... */ }
```

Keep `isFromBot`, `isDirectMessage`, `mentionsBot`, `stripBotMention`, and `buildProviderMessageId` unchanged. Extend `shapeInboundPayload` to emit the new fields.

In `discord-gateway.mjs`: maintain a module-level `Set` of thread channel ids, seeded from each `GUILD_CREATE` dispatch's `threads` array and updated on `THREAD_CREATE` / `THREAD_DELETE`. The `Guilds` intent is already requested, so no intent change is needed. Pass `threadIds.has(message.channel_id)` as `isThread`. Log every non-admit at debug level with its reason — the current silent `return` is why a prod thread failure left no trace.

- [ ] **Step 4: Run the full jace suite**

```bash
cd apps/jace && node --test test/*.test.mjs
```

Expected: 0 failures. (Note `apps/jace` installs with **npm**, not pnpm — if modules are missing, run `npm ci` in `apps/jace` first.)

- [ ] **Step 5: Commit**

```bash
git add apps/jace/agent/lib/discord_gateway.core.mjs apps/jace/agent/lib/discord-gateway.mjs apps/jace/test/discord_gateway.core.test.mjs
git commit -m "feat(discord): gateway reports mention and thread facts, stops deciding"
```

---

### Task 5: Doors emit the envelope and gate cheaply

**Files:**
- Modify: `apps/console/app/api/v1/runner/discord-inbound/route.ts`
- Modify: `apps/console/app/api/v1/connectors/discord/webhook/route.ts`
- Modify: `apps/console/lib/discord-inbound.ts`
- Modify: `apps/console/app/api/v1/connectors/slack/events/route.ts`
- Test: the matching `route.test.ts` beside each, and `apps/console/lib/discord-inbound.test.ts`

**Interfaces:**
- Consumes: Task 3's `getThreadEngagement`; Task 4's payload fields.
- Produces: `channel_inbox.payload` carries `mentionsBot`, `mentionsOtherUsers`, `repliesToMessageId`, `repliesToBot`, `threadId`, and the row's `conversationKey` is the thread id when in a thread. Task 6 reads them.

**The door gate** — one indexed lookup, and it exists to keep junk out of `channel_inbox`, not to make the real decision:

> Enqueue if `mentionsBot` **or** `isDM` **or** (a session row exists for this conversation **and** its latch is clear).

A dormant thread's un-mentioned messages are therefore dropped at the door and never become rows. The only skipped row ever written is the one that CAUSES the transition — one per dormancy episode, not one per ignored message.

For Discord, a slash command sets `mentionsBot: true` (an explicit invocation IS addressing Jace by name).

**Slack needs a bot user id the console does not have.** Verified 2026-07-28: nothing in `apps/console` references a Slack bot identity, and **production has no Slack environment variables at all** on either service — no `SLACK_BOT_TOKEN`, no `SLACK_SIGNING_SECRET`. The Slack door fails closed without a signing secret, so **Slack is entirely dark in prod today** and no Slack traffic can reach any of this. Consequences for this task:

- Read the bot id from a new `SLACK_BOT_USER_ID` env var. `mentionsBot` = the text contains `<@${SLACK_BOT_USER_ID}>`; `mentionsOtherUsers` = it contains some *other* `<@U…>` token; `repliesToMessageId` is **always null** (Slack has no in-channel reply primitive).
- **When `SLACK_BOT_USER_ID` is unset, Slack messages must behave exactly as they do today** — enqueued without an engagement gate. Fail toward the current behavior, not toward silence: gating on an unresolvable mention would make Jace mute on Slack the moment someone turns Slack on without also setting this var. Log once when it is unset, in the style of `moderation.ts`'s missing-key notice.
- Do **not** attempt an `auth.test` call to discover the id — that needs a bot token the console does not have, and adds a network dependency to the door's hot path.
- Slack engagement therefore cannot be prod-verified in this PR. Discord can, and is what the owner actually uses.

- [ ] **Step 1: Write the failing tests**

For each door, assert: an un-mentioned message in a thread with an engaged session IS enqueued; the same with a dormant session is NOT; an un-mentioned channel message with no session is NOT; a mention always is; a DM always is. Assert the payload carries the new fields, and that a DM's payload does not gain a `threadId` key.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/console && npx vitest run "app/api/v1/connectors/discord" "app/api/v1/runner/discord-inbound" "app/api/v1/connectors/slack" lib/discord-inbound.test.ts
```

- [ ] **Step 3: Implement**

Thread the new fields through each door into `admitDiscordChannelMessage` / the Slack enqueue, and apply the gate before `enqueueChannelMessage`. Keep the existing `providerMessageId` conventions **unchanged** — they are redelivery dedupe keys, not conversation keys, and re-keying them lets one event enqueue twice.

- [ ] **Step 4: Run the console suite**

```bash
cd apps/console && npx vitest run && pnpm run typecheck
```

Expected: fully green, typecheck clean. (`pnpm run typecheck` is required — vitest does NOT typecheck.)

- [ ] **Step 5: Commit**

```bash
git add apps/console/app/api/v1/runner/discord-inbound/route.ts apps/console/app/api/v1/runner/discord-inbound/route.test.ts apps/console/app/api/v1/connectors/discord/webhook/route.ts apps/console/app/api/v1/connectors/discord/webhook/route.test.ts apps/console/lib/discord-inbound.ts apps/console/lib/discord-inbound.test.ts apps/console/app/api/v1/connectors/slack/events/route.ts apps/console/app/api/v1/connectors/slack/events/route.test.ts
git commit -m "feat(engagement): doors emit the envelope and gate on the latch"
```

---

### Task 6: The dispatcher decides

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts`
- Test: `apps/console/lib/channel-dispatch.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5.
- Produces: a claimed row that `decideEngagement` rejects is completed WITHOUT an Eve turn, and the latch is persisted.

Place the decision **after** the existing input-guardrail seam (`applyInputGuardrails`) and **before** `runEveTurn`. Order matters: guardrails are a safety floor that must run on everything admitted, while engagement decides whether Jace speaks at all.

On every decision, call `setThreadEngagement` with `nextState`. Log one line on each TRANSITION only — `entered dormant` and `reactivated` — never per skipped message.

- [ ] **Step 1: Write the failing tests**

In `apps/console/lib/channel-dispatch.test.ts`, reuse the file's existing `row()` factory, `mockFetch` stub, and `mockClaim.mockResolvedValueOnce(row({...})).mockResolvedValueOnce(null)` idiom. Assert:
- a discord row whose engagement decision is "no turn" completes the row and makes NO hosted-inbound fetch;
- the same row calls `setThreadEngagement` with a non-null `dormantSince`;
- an engaged-speaker follow-up DOES reach `runEveTurn`;
- a telegram row is completely unaffected — no engagement lookup, no state write.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/console && npx vitest run lib/channel-dispatch.test.ts
```

- [ ] **Step 3: Implement**

Add `getThreadEngagement`/`setThreadEngagement` to the `@agentrail/db-postgres` import list, build the `ThreadInbound` from the claimed row's payload, and branch on `decideEngagement`. Guard the whole block so it runs only for `channel === "discord" || channel === "slack"`, leaving telegram/console/iMessage byte-unchanged.

- [ ] **Step 4: Verify**

```bash
cd apps/console && npx vitest run && pnpm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/channel-dispatch.ts apps/console/lib/channel-dispatch.test.ts
git commit -m "feat(engagement): dispatcher runs the engagement decision"
```

---

### Task 7: Full verification and PR

- [ ] **Step 1: Both suites and typecheck**

```bash
cd apps/console && npx vitest run && pnpm run typecheck
cd ../jace && node --test test/*.test.mjs
cd ../../packages/db-postgres && pnpm build
```

Any pre-existing failure must be confirmed to also fail on `main` before proceeding — do not absorb it into this PR.

- [ ] **Step 2: Confirm the branch touches nothing it should not**

```bash
git diff --name-only origin/main..HEAD
git diff --name-only origin/main..HEAD | grep -E "node_modules|package-lock|pnpm-lock|/dist/" && echo "LEAK" || echo "clean"
```

- [ ] **Step 3: Push and open the PR**

Title: `feat(engagement): threads stay one-on-one until Jace is re-mentioned`.
Body must state: the owner-tested failure this fixes; that Slack behavior changes because its door had no mention gate at all; that DMs and telegram are unaffected; and that Jace opening a thread itself is part 2.

- [ ] **Step 4: Prod verification after deploy**

In a Discord channel Jace is in:
1. `@Jace <question>` in a thread → answered, thread engaged.
2. Two un-mentioned follow-ups from the same person → both answered.
3. A message from a second person, no mention → **not** answered.
4. `@Jace` from either person → re-engaged.
5. Confirm `engagement_dormant_since` and `engaged_speaker_id` move as expected:

```bash
psql "$DATABASE_PUBLIC_URL" -c "select conversation_key, engaged_speaker_id, engagement_dormant_since from jace_sessions where channel='discord' order by last_activity_at desc limit 5;"
```

---

## Self-Review

**Spec coverage.** Covers the spec's engagement half: the shared state machine (Task 2), the two persisted values and the index (Tasks 1, 3), adapters reporting facts instead of deciding (Tasks 4, 5), the door gate and dispatcher decision (Tasks 5, 6). **Deferred to part 2, deliberately:** Jace opening a thread (`POST …/threads`), the interaction-followup fallback for a relocated `/jace` reply, the `SEND_MESSAGES_IN_THREADS` ops prerequisite, and the `jaceThreadReplies` flag. Nothing in this plan should implement those.

**Why no flag here.** The spec's `jaceThreadReplies` guards *Discord thread creation* — the change that alters the delivery path and depends on bot permissions. This PR changes only which messages get answered, needs no new scope or API call, and gating it off would leave the re-mention tax in place, which is the bug being fixed.

**Type consistency.** `ThreadInbound` / `EngagementState` / `EngagementDecision` / `decideEngagement` are used under those exact names in Tasks 3, 5, and 6. Column names are `engagement_dormant_since` / `engaged_speaker_id` in SQL and `engagementDormantSince` / `engagedSpeakerId` in Drizzle throughout.

**Known risk.** Task 5 changes Discord's `conversationKey` to the thread id for thread messages, which orphans the workspace pin for any thread-keyed conversation exactly once — the same effect PR 1 had on Slack. `resolveConversationWorkspace` looks the pin up by `(channel, conversationKey)`. No Discord thread conversation exists today (every prod row is channel-keyed, verified 2026-07-28), so there is nothing live to orphan — but the console's Discord system messages must be checked for the flat-reply bug that this exact re-key caused on Slack in PR 1.
