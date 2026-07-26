# Jace: `/connect` — bind a chat account to a workspace from any gateway

**Date:** 2026-07-27
**Status:** design, awaiting approval

## Problem

A conversation that starts before its workspace exists can never reach that
workspace, and there is no way to fix it from chat.

Observed live on 2026-07-26. "I want you to review this pr
https://github.com/Bensigo/agentrail/pull/1468" on Telegram returned:

```
fetch_pr_diff  in  {"repo":"Bensigo/agentrail","prNumber":1468}
               out {"ok":false,"degraded":true,"reason":"not_found","status":404}
               0.09s
```

92ms is two DB lookups, not two round trips to GitHub — the 404 came out of
`resolveWorkspaceRepoToken`
(`apps/console/app/api/v1/runner/pr-review/route.ts:182`) before any GitHub
call. The repo *is* connected: `Bensigo/agentrail` under workspace
`475a2141-91a3-4893-b23c-21c07846450f`, App installation present. The
conversation simply did not resolve to it.

Two distinct causes, both in scope:

**1. Nothing can bind a chat identity to a console user except a link Jace
decides to send.** `listWorkspacesForChatIdentity`
(`packages/db-postgres/src/queries/chat_identities.ts:421`) resolves
reachability two ways — `chat_identities.workspace_id` directly, or
`chat_identities.user_id` → `workspace_memberships`. The second path is the
durable one: bind the identity to the console *user* and every workspace that
user belongs to becomes reachable, including ones created later. Because
`resolveConversationWorkspace` re-runs on every inbound turn, an `intro`
conversation then graduates to `single` and pins itself on its next message —
no migration, no re-onboarding. But the only way to set `user_id` today is the
`send_connect_link` tool, which the model must choose to call, in a
conversation that may already be too broken to reach it. This affects every
gateway equally; it is not a Telegram problem.

**2. Telegram messages bypass the resolver entirely.** Jace mounts a native
inbound webhook at `/eve/v1/telegram` (`apps/jace/agent/channels/telegram.ts`)
that turns updates into Eve turns directly. The console's own Telegram webhook
(`apps/console/app/api/v1/connectors/telegram/webhook/route.ts`) does
`resolveInboundChatIdentity` → `enqueueChannelMessage` →
`dispatchQueuedChannelMessages`, which is the path that writes the
`jace_sessions` ledger row via `bindEveSession`
(`apps/console/lib/channel-dispatch.ts:673`). Whichever URL `setWebhook` points
at decides whether the conversation is resolvable at all, and nothing makes
that visible. Discord already does this correctly — its gateway listener
forwards admitted messages to `/api/v1/runner/discord-inbound`
(`apps/jace/agent/lib/discord_gateway.core.mjs:25`) rather than handling turns
itself.

Neither gap has an existing issue.

## Non-goals

- A console-side Connections management surface (listing conversations and
  their pins). Worth building; not this spec.
- Splitting the `not_found` degraded reason in `fetch_pr_diff` so "no such PR"
  and "repo not connected" stop being indistinguishable. Separate issue.
- Subagent trace nesting in Langfuse. Separate issue.
- Any change to how work is *executed*, or to the reviewer subagent.
- Slack credentials. The Slack events route already exists; this design covers
  Slack with no Slack-specific code, but configuring it is out of scope.

## Part 1 — `/connect`

### Where it runs, and why that matters

In `dispatchQueuedChannelMessages`, after identity resolution and **before**
`resolveConversationWorkspace`.

This placement is the design. The dispatcher already holds `chatIdentityId`,
`channel`, and `conversationKey` at that point, and it already replies
out-of-band through `sendSystemChannelMessage` for the workspace-choice
message. Handling `/connect` there means:

- **No `jace_sessions` row is required.** The command runs before the
  resolution that needs one, so it works on precisely the conversations that
  are broken. A repair path with the same precondition as the thing it repairs
  is not a repair path.
- **No model involvement.** This is a recovery path. On 2026-07-26 the model,
  handed a 404, told the user to check that a PR in their own repo was public.
  A user whose conversation is broken cannot depend on that same model to pick
  the right repair tool. Matching is an exact string test, not a
  classification.
- **Every gateway inherits it.** Telegram, Discord, and Slack all enter through
  this dispatcher, so there is one implementation and no per-channel work — now
  or for WhatsApp and iMessage later.

The message is **consumed**: it completes the `channel_inbox` row and is never
forwarded to Jace. No Eve turn, no tokens, no cost.

### Command recognition

The first whitespace-delimited token of the trimmed message text, compared
case-insensitively to `/connect`, after two normalizations:

- Strip a trailing `@botname` suffix. Telegram appends it in group chats
  (`/connect@jace_bot`).
- Strip a leading bot mention. Discord guild messages arrive as
  `<@1234567890> /connect`; the gateway listener only admits @mentions in guild
  channels, so the mention is always present there.

Everything after the first token is the optional workspace argument, trimmed.
An empty remainder is the bare form.

Recognition is deliberately strict: the token must be *first*. A message that
merely contains "/connect" mid-sentence is a normal message and reaches Jace
unchanged.

### Behaviour

A pure module, `apps/console/lib/connect-command-decision.ts`, following the
shape of the existing `connect-bind-decision.ts`: a total function from
`(arg, identity, resolution, reachable)` to a discriminated action. All
branching is in that function; the dispatcher only executes the action it
returns.

| Identity / conversation state | `/connect` | `/connect <workspace>` |
| --- | --- | --- |
| No `user_id` | Mint (or re-send) link; reply URL + expiry | Same — the arg is ignored, account linking comes first |
| Linked, 0 reachable | "Linked, but you're not in a workspace yet" + console URL | Same |
| Linked, 1 reachable, unpinned | Pin it; confirm | Pin on name match, else re-render options |
| Linked, ≥2 reachable, unpinned | Render options; ask for `/connect <name>` | Pin the named one; confirm |
| Linked, pinned to X | "This chat is connected to X" + alternatives | Re-pin per the authority rule below |

**Why an explicit argument rather than the existing `ask` picker.** The `ask`
path in the dispatcher (`channel-dispatch.ts:574`) consumes the *next* reply as
the choice via `parseWorkspaceChoice`. That is safe only because it is
stateless: while a conversation is unpinned, `resolveConversationWorkspace`
returns `ask` on every turn. For an already-pinned, working conversation,
resolution returns `pinned`, so consuming the next reply as a choice would
silently swallow a real message to Jace, and making it correct would require
new pending-choice state. `/connect <name>` is stateless, needs no new table,
and behaves identically on every channel. `buildWorkspaceChoiceMessage` is
still reused to *render* the options.

**Workspace matching** is case-insensitive exact match on `workspaces.name`,
scoped to reachable workspaces only. No match, or an ambiguous match across two
workspaces with the same name, re-renders the list rather than guessing.

### Minting

The dispatcher calls `setChatIdentityLinkToken` directly rather than going
through `POST /api/v1/runner/connect-link`. That route's entire job was to
resolve an identity from an `eveSessionId` via the ledger; we already hold the
identity server-side, and going through it would reintroduce the ledger-row
precondition this design exists to remove. The route stays as-is for
`send_connect_link`.

Its eligibility rule — refuse to mint when `user_id` is set, so a token can
never silently rebind someone else's account — is preserved and becomes
*structural*: that state routes to the picker branch, where no token is minted
at all.

**Re-send rather than re-mint.** If the identity already carries an unexpired
`link_token`, reply with the URL for that existing token instead of minting a
new one. This is idempotent, is self-rate-limiting against repeated `/connect`
spam, and avoids the surprise of an earlier link going dead
(`setChatIdentityLinkToken` is last-write-wins).

### Redemption

Unchanged. `/connect/<token>` (`apps/console/app/(auth)/connect/[token]/page.tsx`)
already signs the visitor in with GitHub, consumes the token atomically via
`consumeChatIdentityLinkToken`, applies `decideConnectIdentityBind`'s
`foreign_user` hijack guard, binds `user_id`, and auto-binds a workspace when
there is exactly one unambiguous answer.

**One ordering in that page is load-bearing and must not be refactored away:**
the signed-out branch returns at line 31, *before* `consumeChatIdentityLinkToken`
on line 90. A link-preview crawler — and Telegram does unfurl links in chat — is
never signed in, so it never reaches the consume. Inverting that order would let
the unfurl burn every token before the user taps it. A test must pin it.

### Re-pin authority

`pinConversationWorkspace` currently refuses `already_pinned_elsewhere` and the
package has no unpin or re-pin function, so a conversation pinned to the wrong
workspace is stuck permanently. This adds the missing path, with a rule.

The pin belongs to the *conversation*, not to any identity in it
(`jace_sessions.ts:316`): every participant sharing `(channel,
conversationKey)` inherits it, including identities that reach zero workspaces
of their own. So in a shared channel, one person re-pinning redirects
everyone's work. That is not a data-leak risk — the re-pinner legitimately
reaches the target — but a colleague's next message would file into a workspace
they did not choose.

**Rule:** re-pinning an already-pinned conversation requires the requesting
identity to reach **both** the current workspace and the target. You may move a
conversation between workspaces you have standing in; you may not walk into a
channel pinned to a workspace you are a stranger to and move it elsewhere. Both
checks come from the one `listWorkspacesForChatIdentity` call already being
made.

A refused re-pin says so plainly, naming neither the current workspace's name
nor its id if the requester cannot reach it.

**Every successful re-pin is announced in the channel**, naming both the old and
new workspace. Silent re-pinning is how a team files a week of work into the
wrong place without noticing. Direct messages have a single participant, so the
announcement there is just the confirmation.

Implemented as a new `repinConversationWorkspace` in
`packages/db-postgres/src/queries/jace_sessions.ts`, taking the same atomic
posture as `bindJaceSessionWorkspace`: a single guarded UPDATE, with the
authority check performed before it and re-verified against the row it
actually matched.

## Part 2 — Telegram transport shim

`apps/jace/agent/channels/telegram.ts` stops handling turns on the way in.
Instead it normalizes the update and POSTs it to the console's Telegram intake,
mirroring `discord_gateway.core.mjs`'s existing shape — the transport that
receives is not the thing that resolves.

The normalize + POST logic goes in a pure `agent/lib/telegram_forward.core.mjs`
with an injected transport, matching the sibling `*.core.mjs` convention, so
every branch is unit-testable without a network.

**Unchanged:** everything outbound. Replies, `chat-split`, the typing
keep-alive, and the new ack-on-silence timer are `message.completed` /
`turn.started` hooks, and they still fire because the console door hands the
turn back to this same telegram module via `args.receive`.

**Flag:** `JACE_TELEGRAM_FORWARD_TO_CONSOLE`, default off. Off is today's
behaviour exactly. Rollout is flip-on after staging verification; revert is
flip-off, not a deploy. `/connect` ships unflagged — it is inert until someone
types it, and gating a recovery path means it is missing when it is needed.

**Verification item, not an assumption:** `runEveTurn` POSTs only
`{message, channel, target, auth}` with no session or continuation token, and
both doors land on the same `telegram` module with the same `chatId` target, so
the same Eve session *should* survive the switch. This must be confirmed on a
real multi-turn staging conversation before the flag is flipped in production.
If it does not hold, flipping the flag silently resets every user's chat
history mid-conversation.

## Error handling

Every failure replies in-channel and completes the inbox row. `/connect` never
leaves a user with silence — silence is the failure mode that produced this
work.

| Failure | Response |
| --- | --- |
| Identity row missing | Generic "couldn't identify this conversation"; no detail |
| Mint fails (DB) | "Couldn't create a link right now, try again"; row completed, not failed |
| Named workspace unreachable / unknown | Identical message for both — never confirms a workspace exists |
| Re-pin refused by authority rule | Plain refusal; no name or id the requester cannot reach |
| Re-pin loses a race | Re-resolve once and report the actual current state, never retry in a loop |

Unknown-vs-unreachable collapsing mirrors `consumeChatIdentityLinkToken`'s
existing posture: a distinguishable response lets a caller enumerate what
exists.

## Security invariants

1. `user_id` is only ever set from an authenticated console session at
   redemption. Never from chat text, never from model output.
2. The command handler never invokes the model. Recognition is exact string
   matching on a normalized first token.
3. `(channel, conversationKey)` remains platform-authoritative — taken from the
   webhook payload's routing fields, never from message content.
4. Re-pin requires reaching both current and target workspace.
5. The minted URL is sent once, in-thread, to the conversation that asked. The
   raw token is never logged and never echoed back.
6. The signed-out-before-consume ordering in the redemption page is preserved.

## Testing

**Pure decision module** — table-driven unit tests covering every row of the
behaviour table in both bare and argument forms, plus: unreachable named
workspace, ambiguous name, re-pin allowed, re-pin refused, and the
already-pinned-to-target no-op.

**Command recognition** — `/connect@botname`, a leading Discord mention,
leading and trailing whitespace, mixed case, `/connect` mid-sentence (must NOT
match), and `/connected` (must NOT match).

**Re-pin authority** — a refusal when the requester reaches the target but not
the current pin, which is the specific hole the rule closes.

**Dispatcher integration** — the command is consumed and no Eve turn is
started; a non-command message is unaffected.

**Redemption ordering** — a test that fails if `consumeChatIdentityLinkToken`
becomes reachable by a signed-out request.

**Telegram shim** — a source-as-text structural test, following the convention
established in `e66d26ed` for channel wiring, asserting the channel has no
inbound turn-handling path when the flag is on. `node --test` cannot import the
`.ts` channels, which is why this repo asserts against channel source rather
than mirroring handler bodies in the test.

**Manual, staging, before the flag flips:** multi-turn Telegram conversation
across the door switch, confirming session continuity and preserved history.

## Rollout

1. Part 1 merges and deploys unflagged. `/connect` works immediately on
   Discord, and on Telegram once step 3 lands.
2. Part 2 merges with `JACE_TELEGRAM_FORWARD_TO_CONSOLE` off — a no-op deploy.
3. Staging verification of session continuity, then flip the flag in
   production.
4. Re-point `setWebhook` at the console route as belt-and-braces. With the shim
   in place both URLs resolve identically, so this is cleanup, not a cutover.

## Open items

- Whether `chat_identities` should stop being bound to `workspace_id` at all in
  favour of `user_id` only. `bindChatIdentityWorkspace` is a point-in-time
  snapshot that goes stale the moment a second workspace exists — the same class
  of bug as this spec's Problem section. Not changed here; worth its own issue.
- Discord guild channels require `@jace /connect` because the gateway listener
  only admits @mentions. Deliberate: relaxing the admission contract for a text
  prefix is a bigger change than it looks. Revisit if users trip on it.
