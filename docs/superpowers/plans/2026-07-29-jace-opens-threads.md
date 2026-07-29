# Jace Opens Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone @-mentions Jace in a Discord channel, Jace opens a thread on their message and answers there — so the channel stays clean and the thread is engaged from birth, needing no further mentions.

**Architecture:** The console creates the thread at dispatch time, before the Eve turn, using the bot token it already holds. It then re-keys the whole turn onto the new thread — destination, session ledger, and engagement — so Jace simply posts to the channel id it is handed and lands inside the thread. Jace's own code needs no change.

**Tech Stack:** TypeScript (Next.js console, vitest), Discord REST v10.

## Global Constraints

- **Part 2 of the thread-native arc.** Part 1 (the engagement state machine) is already merged and live. This plan adds **only** thread creation for Discord.
- **Scope, owner-decided:** Jace-created threads only. A thread a human creates manually still needs one `@Jace` — do NOT add auto-engagement for human-created threads.
- **Only relocate a channel mention.** A message already inside a thread, a DM, or any non-Discord channel is untouched.
- **Never lose a reply.** If thread creation fails for any reason, fall back to exactly today's behavior — reply in the channel, do NOT re-key the conversation. `SEND_MESSAGES_IN_THREADS` is confirmed granted (proven in prod 2026-07-29); `CREATE_PUBLIC_THREADS` is NOT confirmed, so the fallback is load-bearing, not theoretical.
- **Strip the interaction credential when relocating.** Discord interaction followups cannot target a thread. If `auth.attributes` still carries `interactionToken`/`applicationId`, `deliverDiscordReply` prefers the followup path and the reply lands in the CHANNEL while the conversation has moved to the thread — a split-brain conversation. Removing them forces the bot-token path, which posts to whatever channel id it is given.
- Telegram, Slack, console, and iMessage must be byte-unchanged.
- No new dependency.
- **PR-per-change rule:** branch → push → PR.
- Spec: `docs/superpowers/specs/2026-07-28-thread-native-jace-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/console/lib/discord-thread-name.ts` (**create**) | Pure: a user's message → a valid Discord thread name. |
| `apps/console/lib/discord-thread-name.test.ts` (**create**) | Table tests. |
| `apps/console/lib/discord-bot.ts` (**modify**) | `createDiscordThreadFromMessage` — the REST call. |
| `apps/console/lib/discord-bot.test.ts` (**modify**) | Its success and typed-failure paths. |
| `apps/console/lib/channel-dispatch.ts` (**modify**) | Relocate the turn: create, re-key, strip credential, engage, fall back. |
| `apps/console/lib/channel-dispatch.test.ts` (**modify**) | The relocation, and every path that must NOT relocate. |

---

### Task 1: Thread name derivation, and the REST call

**Files:**
- Create: `apps/console/lib/discord-thread-name.ts`, `apps/console/lib/discord-thread-name.test.ts`
- Modify: `apps/console/lib/discord-bot.ts`, `apps/console/lib/discord-bot.test.ts`

**Interfaces produced** (Task 2 consumes both):

```ts
export function deriveThreadName(text: string): string;

export type CreateThreadResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string; status?: number; code?: number };

export async function createDiscordThreadFromMessage(
  token: string,
  channelId: string,
  messageId: string,
  name: string
): Promise<CreateThreadResult>;
```

- [ ] **Step 1: Write the failing tests**

`apps/console/lib/discord-thread-name.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveThreadName } from "./discord-thread-name";

describe("deriveThreadName", () => {
  it("uses the message text", () => {
    expect(deriveThreadName("how do I deploy this?")).toBe("how do I deploy this?");
  });

  it("collapses whitespace and newlines", () => {
    expect(deriveThreadName("what  is\n\nbroken")).toBe("what is broken");
  });

  it("cuts to 100 chars on a word boundary", () => {
    const name = deriveThreadName("word ".repeat(50).trim());
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("word")).toBe(true);
  });

  it("hard-cuts a single unbroken token longer than the limit", () => {
    const name = deriveThreadName("x".repeat(200));
    expect(name).toHaveLength(100);
  });

  it("falls back to 'Jace' on empty or whitespace-only input", () => {
    expect(deriveThreadName("   ")).toBe("Jace");
    expect(deriveThreadName("")).toBe("Jace");
  });
});
```

For `discord-bot.test.ts`, follow that file's existing fetch-stubbing convention (read it first) and cover: a 201 returning the created channel yields `{ok: true, threadId: <id>}`; a non-2xx yields `ok: false` carrying the numeric `status` and Discord's `code`; a transport throw yields `ok: false` and never throws.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/console && npx vitest run lib/discord-thread-name.test.ts lib/discord-bot.test.ts
```

- [ ] **Step 3: Implement**

`apps/console/lib/discord-thread-name.ts`:

```ts
/**
 * A Discord channel name is capped at 100 characters, and a thread's name is
 * the first thing anyone scanning the channel sees — so it is derived from the
 * user's own words rather than something generic.
 *
 * The text handed in is already mention-stripped (the Gateway removes the
 * bot's own `<@id>` token before the message ever reaches the console), so
 * this only has to normalize whitespace and fit the limit.
 */
const MAX_THREAD_NAME = 100;
const FALLBACK = "Jace";

export function deriveThreadName(text: string): string {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return FALLBACK;
  if (flat.length <= MAX_THREAD_NAME) return flat;
  const cut = flat.slice(0, MAX_THREAD_NAME);
  const lastSpace = cut.lastIndexOf(" ");
  // A single unbroken token longer than the limit has no boundary to cut on —
  // hard-cut rather than fall back, so the name still carries the user's text.
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}
```

In `apps/console/lib/discord-bot.ts`, add `createDiscordThreadFromMessage` next to `sendDiscordChannelMessage`, reusing that file's `fetchWithTimeout` and `DISCORD_API_BASE`. It POSTs to `/channels/{channelId}/messages/{messageId}/threads` with `{ name, auto_archive_duration: 1440 }`, never throws, and on failure returns the numeric HTTP status and Discord's `code` from the body so the caller can log why (never the token, never the URL).

Note for the implementer: Discord makes the created thread's id **equal to the source message id**, so `threadId` is known even before the response — but read it from the response body anyway rather than assuming, and treat a response missing `id` as a failure.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/console && npx vitest run lib/discord-thread-name.test.ts lib/discord-bot.test.ts && pnpm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/discord-thread-name.ts apps/console/lib/discord-thread-name.test.ts apps/console/lib/discord-bot.ts apps/console/lib/discord-bot.test.ts
git commit -m "feat(discord): create a thread from a message"
```

---

### Task 2: Relocate a channel mention into its own thread

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts`
- Test: `apps/console/lib/channel-dispatch.test.ts`

**When to relocate.** All of these must hold:
- `row.channel === "discord"`
- the engagement decision said **turn**
- the message is NOT already in a thread (`payload.threadId` absent/null)
- it is not a DM
- `DISCORD_BOT_TOKEN` is set

Otherwise proceed exactly as today.

**What relocating means** — do all five, in this order:

1. `createDiscordThreadFromMessage(token, payload.chatId, payload.messageId, deriveThreadName(guard.text))`.
2. On success, treat the thread id as the conversation from here on: resolve the ledger session under `getOrCreateJaceSession(workspaceId, "discord", threadId)` and bind the Eve session to **that** row, not the channel-keyed one.
3. Persist engagement for the THREAD's key — `setThreadEngagement({channel: "discord", conversationKey: threadId, dormantSince: null, engagedSpeakerId: <sender>})` — so the very next un-mentioned message in it is a turn.
4. Pass `chatId: threadId` and `conversationKey: threadId` to `runEveTurn`.
5. Strip `interactionToken`/`applicationId` from the auth attributes for this turn.

**This re-key is the correctness crux.** If the ledger session or the engagement row is written under the channel key while the reply goes to the thread, the next message in that thread finds no session and no engagement — a brand-new conversation with no memory, needing another mention. That is the bug this task most plausibly ships; test it explicitly.

**On failure** (any `ok: false`, or no token): log the status and Discord `code`, then continue with the unrelocated turn exactly as today — same `chatId`, same `conversationKey`, credential left intact. The user still gets their answer, in the channel.

- [ ] **Step 1: Write the failing tests**

Use the file's existing `row()` factory, `mockFetch` stub, and `mockClaim.mockResolvedValueOnce(row({...})).mockResolvedValueOnce(null)` idiom. Mock the new `createDiscordThreadFromMessage`. Assert:

- a Discord channel mention creates a thread, and the hosted-inbound target's `channelId` **and** `conversationKey` are both the new thread id;
- the session ledger and `setThreadEngagement` are both written against the **thread** id, not the channel id;
- the auth attributes sent for a relocated turn carry **no** `interactionToken` and no `applicationId` (assert absence explicitly — `not.toHaveProperty`, since `toEqual` treats an `undefined`-valued key as absent);
- a message already in a thread does NOT create a thread;
- a DM does NOT create a thread;
- a Telegram row does NOT create a thread and is otherwise byte-unchanged;
- thread creation failing still runs the turn, against the original channel id, with the credential intact.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/console && npx vitest run lib/channel-dispatch.test.ts
```

- [ ] **Step 3: Implement**

Place the relocation immediately before the `runEveTurn` call at roughly line 1387, after the engagement decision has said "turn". Read the surrounding code first — `ledgerSessionId` is assigned around line 1252 from `getOrCreateJaceSession(workspaceId, row.channel, row.conversationKey)`, and that is the value `bindEveSession` uses at ~line 1402; relocation must redirect it.

- [ ] **Step 4: Verify**

```bash
cd apps/console && npx vitest run && pnpm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/channel-dispatch.ts apps/console/lib/channel-dispatch.test.ts
git commit -m "feat(discord): answer a channel mention in its own thread"
```

---

### Task 3: Verify, ship, and confirm in prod

- [ ] **Step 1: Everything green**

```bash
cd apps/console && npx vitest run && pnpm run typecheck
cd ../jace && node --test test/*.test.mjs
```

- [ ] **Step 2: Run the build that CI does not**

```bash
cd apps/console && pnpm build
```

**This is mandatory.** On 2026-07-28 the console failed to deploy for nine hours because `vitest`, `tsc --noEmit`, and CI all passed while `next build` failed on a `.js` import specifier and an unknown ESLint rule. Neither `vitest` nor `tsc` catches those, and CI runs neither `next build` nor lint. A green suite says nothing about whether this ships.

- [ ] **Step 3: Leak scan, push, PR**

```bash
git diff --name-only origin/main..HEAD | grep -E "node_modules|package-lock|pnpm-lock|/dist/" && echo LEAK || echo clean
```

PR body must state: the behavior change, that manually-created threads still need one mention (owner-decided), that `SEND_MESSAGES_IN_THREADS` is confirmed but `CREATE_PUBLIC_THREADS` is not, and that the fallback keeps today's behavior when creation fails.

- [ ] **Step 4: Confirm the deploy actually landed**

Do not report success on a merge alone — on 2026-07-28 two PRs merged green and neither ever deployed.

```bash
railway logs --service console --environment production | tail -20
```

- [ ] **Step 5: Prod check**

In a Discord channel: `@Jace <question>` → a thread appears on that message and the reply is inside it. Then reply in that thread with **no** mention → answered. Confirm one session row for the thread:

```bash
psql "$DATABASE_PUBLIC_URL" -c "select conversation_key, engaged_speaker_id, engagement_dormant_since from jace_sessions where channel='discord' order by last_activity_at desc limit 5;"
```

---

## Self-Review

**Spec coverage.** Implements the spec's "Opening the thread" section for Discord, plus its fallback requirement. Slack needs nothing — posting with `thread_ts` already threads, which shipped in PR #1492.

**Deliberately not here:** auto-engaging human-created threads (owner chose Jace-created only); the `jaceThreadReplies` flag — the fallback already makes failure safe, and a flag defaulted off would ship this dead, which is exactly what happened to the last two PRs for a different reason.

**Type consistency.** `deriveThreadName` and `createDiscordThreadFromMessage` are used under those names in Task 2. `threadId` is the field name throughout.

**Known risk.** `CREATE_PUBLIC_THREADS` is unverified. If it is not granted, every relocation fails and every reply lands in the channel — today's behavior, plus a log line naming the Discord error code. That is a degradation, not a breakage, and the log tells you immediately which permission to add.
