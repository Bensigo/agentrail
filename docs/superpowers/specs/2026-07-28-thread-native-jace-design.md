# Thread-native Jace — Discord and Slack

**Date:** 2026-07-28 · **Status:** approved (owner) · **Supersedes the "Threads" line in** `2026-07-26-discord-gateway-listener-design.md`'s Out of scope

## Problem

The owner's words: *"on discord Jace can't reply thread, which is something
most those users do when talking to jace on discord or on slack."*

That is correct, and it was a deliberate deferral, not a regression — the
Gateway listener spec lists *"Threads, reactions, message edits"* under Out of
scope. Nothing in either channel's path is thread-aware. Three concrete breaks:

1. **Re-mention tax.** `admitMessage` (`apps/jace/agent/lib/discord_gateway.core.mjs`)
   rejects any guild message with no explicit `<@bot>` token. A thread is just
   another guild channel, so *every* turn inside a thread needs `@Jace` again.
   In Slack, once a bot is in a thread you simply talk. That gap is the
   complaint.

2. **Replies into a thread need a permission the bot may not hold.** The
   @mention path carries no interaction token, so `agent/channels/discord.ts`
   falls back to `channel.discord.post()` → `POST /channels/{threadId}/messages`.
   Discord: *"The `SEND_MESSAGES` permission has no effect in threads; users
   must have `SEND_MESSAGES_IN_THREADS`."* Prod's `NEXT_PUBLIC_DISCORD_INVITE_URL`
   is a bare `?client_id=` link, so the granted set lives in Developer Portal
   default install settings and is not verifiable from this repo.

3. **Jace never opens a thread.** Every reply is a flat channel message.

Slack is worse than Discord, and silently: `app/api/v1/connectors/slack/events/route.ts`
captures no `thread_ts` at all, while `agent/channels/slack.ts` already posts
through `channel.thread.post()`. eve's Slack `receive` derives its continuation
token as `threadTs || crypto.randomUUID()`, so today **every Slack turn gets a
random token and no Slack conversation can resume** — the Slack half of #1479.

## Design

Four layers. Conversation semantics live above the transports, so Discord and
Slack cannot drift into different behavior.

### 1. Adapters — normalize, never decide

Each platform door answers one question: *what is this event, structurally?* It
emits a channel-agnostic envelope and owns no conversation semantics.

```
ThreadInbound {
  channel:              "discord" | "slack"
  parentChannelId:      string
  threadId:             string | null   // null = message is in the channel proper
  isDM:                 boolean
  authorId:             string
  text:                 string
  mentionsBot:          boolean
  mentionsOtherUsers:   boolean
  repliesToMessageId:   string | null
  repliesToBot:         boolean
}
```

- **Discord Gateway listener** keeps a set of known thread ids, populated from
  `GUILD_CREATE.threads` and `THREAD_CREATE`/`THREAD_DELETE`. The `Guilds`
  intent is already requested, so this needs no new intent and no REST call —
  "is this message in a thread" becomes a local lookup. `admitMessage`'s
  mention rule stops being the admission gate and becomes envelope fields
  (`mentionsBot`, `mentionsOtherUsers`).
- **Discord interactions webhook** emits the same envelope; a `/jace` invoked
  inside a thread already arrives with `channel_id` set to the thread. An
  explicit slash-command invocation sets `mentionsBot: true` — the user
  addressed Jace by name, which is what that field means.
- **Slack events route** maps `thread_ts` → `threadId`, `channel` →
  `parentChannelId`, and captures the message `ts` (needed to open a thread).
  `repliesToMessageId` is **always null on Slack**: Slack has no in-channel
  reply primitive, a reply *is* a thread. So Slack bows out on the
  mentions-another-user signal alone, and the reply signal is Discord-only
  (`message_reference`). This is a difference in available evidence, not in
  semantics — the state machine is identical.

### 2. Engagement — one shared state machine

A new pure core module, `apps/jace/agent/lib/thread-engagement.core.mjs`,
following `intent-classifier.core.mjs`'s shape: no network, no model call,
`node --test`-able, one exported decision function.

```
decideEngagement({ inbound, dormantSince }) -> { turn, nextDormantSince, reason }
```

Engagement is **conversation state, not per-message classification**. The
heuristic answers only *"has this conversation stopped being about Jace?"*

| Situation | Turn? | Latch |
|---|---|---|
| DM, or mention in a channel | yes | cleared |
| In thread, engaged, no bow-out signal | yes | cleared |
| In thread, engaged, mentions another user (and not Jace) | no | **set** |
| In thread, engaged, replies to a non-Jace message | no | **set** |
| In thread, dormant, mentions Jace | yes | cleared |
| In thread, dormant, no mention | no | stays set |
| No session for this thread, no mention | no | — |

**Fails toward silence.** An un-mentioned message we are unsure about is not
answered. A wrong bow-out costs the user one `@Jace`; a wrong engagement spams
a human conversation.

**Engagement is per-thread, not per-user.** Any participant's message in an
engaged thread is a turn, whoever opened it — a thread is one conversation, and
tracking per-speaker engagement would mean Jace answering one person and
ignoring another in the same exchange. Attribution is unchanged: the turn is
still attributed to its own sender's chat identity, exactly as today.

### 3. State — persist only what cannot be derived

Two of the three states are already derivable and are **not** stored:

- *never engaged* ⇔ no `jace_sessions` row for `(channel, thread id)`.
- *engaged* ⇔ that row exists with the latch clear.

Only **dormant** is irreducible, precisely because it is set by a message that
produces no turn, no `channel_inbox` row, and no `jace_messages` row. Nothing
else in the system observes it. The alternative — re-fetching thread history
from Discord/Slack per message and re-judging it — is a network call per
message and reintroduces per-message classification.

**Migration:**

- `jace_sessions.engagement_dormant_since timestamptz` (nullable). Not a state
  enum; engaged is implied by row existence, dormant by the flag.
- An index on `(channel, conversation_key)`. The existing unique is
  `(workspace_id, channel, conversation_key)` — leading column `workspace_id`,
  unusable for the door's lookup — and `jace_sessions_intro_conversation_idx`
  is partial (`WHERE workspace_id IS NULL`), so it covers intro rows only.
  Without this index the door's gate seq-scans for every graduated session.

Why durable rather than in-process: **not** a multi-worker argument today
(console runs one replica). The argument is deploy cadence plus failure
asymmetry — console auto-deploys on every merge to main, so process restart is
routine, and losing the latch silently returns Jace to a human side-conversation
it was just told to stay out of. Losing *engaged* is self-correcting; losing
*dormant* is invisible. `channel-dispatch.ts` also plans a Wave 2 worker pool,
at which point in-memory latch state would break outright.

### 4. Placement — gate at the door, decide in the dispatcher

The dispatcher already loads the session row, so reading and writing the latch
there costs nothing extra. The door keeps a cheap gate over the same row:

> **Door enqueues if** `mentionsBot` **or** `isDM` **or** (a session row exists
> for this thread **and** the latch is clear).

Consequence: a dormant thread's un-mentioned messages never reach
`channel_inbox` at all. The only skipped row ever written is **the single
message that causes the transition** — one per dormancy episode, not one per
ignored message.

**Observability:** a structured log line per transition (`entered dormant`,
`reactivated`) plus the timestamp column, which already records when. No event
table and no per-message telemetry; skipped-message sampling is a follow-up if
the heuristic ever needs tuning.

### 5. Opening the thread

An admitted turn whose `threadId` is null and which is not a DM answers in a
new thread.

- **Discord:** `POST /channels/{parent}/messages/{userMessageId}/threads`, name
  derived from the user's message: bot-mention tokens stripped (the text Jace
  already receives), whitespace collapsed, cut to Discord's 100-char
  channel-name limit on a word boundary, falling back to `"Jace"` if that
  leaves nothing. Discord makes the new thread's id **equal to the source
  message id**, so the conversation's new key is known before the call — no
  re-key race.
- **Slack:** nothing to create. Posting with `thread_ts = <user message ts>`
  opens the thread implicitly, and `agent/channels/slack.ts` already posts via
  `channel.thread.post()`; it simply never receives a `threadTs` today.

Once the thread exists the conversation key **is** the thread id, so every
later message in it continues the same Eve session. The Discord `conversationId`
pin from #1479 (`HOSTED_INBOUND_PINS_CONVERSATION` in `channel-dispatch.ts`)
becomes the thread id.

Slack's `threadTs` must be threaded through `hosted_inbound.core.mjs`'s target
normalization, which closes the Slack half of #1479 as a direct consequence.

### 6. Fallback — preserve the 2026-07-25 private-channel fix

Discord interaction followups **do not support `thread_id`** (documented
explicitly), so a `/jace` reply relocated into a thread must go out over the bot
token — the exact path that failed in the 2026-07-25 private-channel bug.

On thread-create failure or thread-post failure (`50001 Missing Access`,
`50013 Missing Permissions`, archived thread), Jace falls back to today's
behavior unchanged: interaction followup when a token is present, else a bot
post to the parent channel — and **does not re-key the conversation**, so the
next message in that channel still resolves to the same session. The numeric
HTTP status and Discord error code are logged (never the token, never the URL),
matching `discord-followup.core.mjs`'s existing fallback logging.

## Rollout

Behind `jaceThreadReplies`, default OFF, flipped after prod verification.

**Ops prerequisite, not code:** the Discord app's default install settings must
grant **Create Public Threads** and **Send Messages in Threads**. `SEND_MESSAGES`
has no effect in threads. Prod's invite URL carries only `client_id`, so the
granted set is a Developer Portal setting; verify it before flipping the flag.
Slack needs no new scope beyond the `chat:write` it already posts with.

## Verification

**Unit** — table-driven tests over every `decideEngagement` transition; per-adapter
envelope normalization (Discord guild / DM / thread, Slack channel / thread);
thread-name derivation and truncation; the door gate's three branches.

**Prod (the only proof that counts, per the Gateway spec's own convention):**

1. `@Jace <question>` in a public channel → a thread appears on that message and
   the reply lands inside it.
2. Two un-mentioned follow-ups in that thread are both answered.
3. A message in that thread @-mentioning another user is **not** answered.
4. `@Jace` in that thread re-engages it.
5. The same four in Slack.
6. A Slack conversation resumes across turns (proving #1479's Slack half).

## Out of scope

- Private threads (Jace must be added as a thread member first) and forum
  channels.
- Reactions, message edits, WhatsApp/iMessage equivalents.
- Model-based side-chat classification. Revisit only if the heuristic proves
  wrong against real thread traffic.
- Retro-threading existing channel-keyed conversations; the flag applies to new
  conversations only.
