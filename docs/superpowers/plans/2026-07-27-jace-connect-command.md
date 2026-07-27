# Jace `/connect` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user bind their chat account to a workspace by typing `/connect` in any gateway, and stop Telegram messages from bypassing the workspace resolver.

**Architecture:** `/connect` is intercepted in the console's `channel_inbox` dispatcher *before* workspace resolution, so it needs no `jace_sessions` row and never reaches the model. All branching lives in one pure module; the dispatcher only executes the action it returns. Telegram's native Eve channel becomes a transport shim that forwards to the console intake, matching the Discord gateway's existing shape.

**Tech Stack:** TypeScript, Next.js App Router (console), Drizzle (`@agentrail/db-postgres`), Vitest (console + packages), `node --test` (apps/jace `.mjs` cores), Eve 0.19.0.

**Spec:** `docs/superpowers/specs/2026-07-27-jace-connect-command-design.md`

## Global Constraints

- Work in the worktree `/Users/macbook/work/bensigo-ai-workflow-wt-connect`, branch `feat/jace-connect-command`. Do NOT switch branches. Another session is running SDD in the main tree; never `cd` there.
- The command token is exactly `/connect`, case-insensitive, and must be the **first** whitespace-delimited token after normalization. `/connected` and a mid-sentence `/connect` must NOT match.
- Normalization strips a trailing `@botname` from the token (Telegram groups) and a leading `<@…>` Discord mention.
- `/connect` is **unflagged**. The Telegram shim is gated on `JACE_TELEGRAM_FORWARD_TO_CONSOLE`, default **off**.
- Re-pin requires the requesting identity to reach **both** the current and target workspace. A refused re-pin must never name or id the current workspace.
- Workspace matching is case-insensitive **exact** match on `workspaces.name`, scoped to reachable workspaces. Zero matches and 2+ matches both re-render the list.
- `user_id` is only ever written from an authenticated console session at redemption. Never from chat text.
- Never log or echo a raw link token. Only the assembled URL, once, to the asking conversation.
- Console tests: `cd apps/console && pnpm test`. Package tests: `cd packages/db-postgres && pnpm test`. Jace cores: `cd apps/jace && pnpm test`.
- Never stage `pnpm-lock.yaml` or a `node_modules` symlink. Run `git status` before every commit and stage only the named files.

---

## File Structure

**PR① — `/connect` (unflagged)**

| File | Responsibility |
| --- | --- |
| `apps/console/lib/connect-command.ts` | Create. Pure: recognize the command, and decide the action. No I/O. |
| `apps/console/lib/connect-command.test.ts` | Create. Vitest, table-driven. |
| `packages/db-postgres/src/queries/jace_sessions.ts` | Modify. Add `repinConversationWorkspace`. |
| `packages/db-postgres/src/queries/jace_sessions.repin.test.ts` | Create. Vitest. |
| `apps/console/lib/channel-dispatch.ts` | Modify at line 571. Intercept, execute the action, reply. |
| `apps/console/lib/connect-command-copy.ts` | Create. All user-facing strings in one place. |
| `apps/console/app/(auth)/connect/[token]/page.test.ts` | Create. Pins the signed-out-before-consume ordering. |

**PR② — Telegram shim (flagged)**

| File | Responsibility |
| --- | --- |
| `apps/jace/agent/lib/telegram_forward.core.mjs` | Create. Pure normalize + POST with injected transport. |
| `apps/jace/test/telegram_forward.core.test.mjs` | Create. `node --test`. |
| `apps/jace/agent/channels/telegram.ts` | Modify. Forward instead of handling turns when the flag is on. |
| `apps/jace/test/telegram-channel.test.mjs` | Create. Source-as-text structural test. |

---

## Task 1: Recognize the command

**Files:**
- Create: `apps/console/lib/connect-command.ts`
- Test: `apps/console/lib/connect-command.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseConnectCommand(text: string): { isCommand: boolean; arg: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/connect-command.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConnectCommand } from "./connect-command";

describe("parseConnectCommand", () => {
  const matches: Array<[string, string]> = [
    ["/connect", ""],
    ["  /connect  ", ""],
    ["/CONNECT", ""],
    ["/connect@jace_bot", ""],
    ["<@123456789> /connect", ""],
    ["<@!123456789> /connect", ""],
    ["/connect agentrail-dev", "agentrail-dev"],
    ["/connect@jace_bot agentrail-dev", "agentrail-dev"],
    ["<@123456789> /connect  agentrail dev  ", "agentrail dev"],
  ];
  for (const [input, arg] of matches) {
    it(`matches ${JSON.stringify(input)}`, () => {
      expect(parseConnectCommand(input)).toEqual({ isCommand: true, arg });
    });
  }

  const nonMatches = [
    "",
    "   ",
    "connect",
    "/connected",
    "/connect-me",
    "please /connect me",
    "i want you to /connect",
    "//connect",
  ];
  for (const input of nonMatches) {
    it(`does not match ${JSON.stringify(input)}`, () => {
      expect(parseConnectCommand(input)).toEqual({ isCommand: false, arg: "" });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command`
Expected: FAIL — cannot resolve `./connect-command`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/console/lib/connect-command.ts`:

```ts
/**
 * Pure recognition + decision for the in-chat `/connect` command.
 *
 * Handled in the console dispatcher BEFORE workspace resolution, so it works
 * on exactly the conversations that are broken (no jace_sessions row needed)
 * and never reaches the model — recognition is exact string matching, not
 * classification. See docs/superpowers/specs/2026-07-27-jace-connect-command-design.md.
 */

const COMMAND = "/connect";

/** Discord guild messages arrive mention-prefixed: `<@123> /connect`. */
const LEADING_MENTION = /^<@!?\d+>\s*/;

/**
 * Recognize `/connect [workspace]`. The token must be FIRST — a message that
 * merely contains "/connect" is a normal message and reaches Jace unchanged.
 * A trailing `@botname` (Telegram groups) is stripped from the token only.
 */
export function parseConnectCommand(text: string): {
  isCommand: boolean;
  arg: string;
} {
  const stripped = String(text ?? "").trim().replace(LEADING_MENTION, "");
  if (!stripped) return { isCommand: false, arg: "" };

  const firstSpace = stripped.search(/\s/);
  const rawToken = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
  const token = rawToken.split("@")[0]!.toLowerCase();
  if (token !== COMMAND) return { isCommand: false, arg: "" };

  const arg = firstSpace === -1 ? "" : stripped.slice(firstSpace).trim();
  return { isCommand: true, arg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/console/lib/connect-command.ts apps/console/lib/connect-command.test.ts
git commit -m "feat(console): recognize the /connect chat command"
```

---

## Task 2: Decide what `/connect` does

**Files:**
- Modify: `apps/console/lib/connect-command.ts` (append)
- Test: `apps/console/lib/connect-command.test.ts` (append)

**Interfaces:**
- Consumes: `parseConnectCommand` from Task 1.
- Produces:
  - `interface WorkspaceRef { id: string; name: string }`
  - `interface PinnedRef { id: string; name: string | null }`
  - `type ConnectCommandAction` (8 variants, below)
  - `decideConnectCommand(input: DecideConnectCommandInput): ConnectCommandAction`

- [ ] **Step 1: Write the failing test**

Append to `apps/console/lib/connect-command.test.ts`:

```ts
import { decideConnectCommand } from "./connect-command";

const WS_A = { id: "ws-a", name: "agentrail-dev" };
const WS_B = { id: "ws-b", name: "side-project" };

describe("decideConnectCommand", () => {
  const linked = { userId: "user-1" };
  const unlinked = { userId: null };

  it("unlinked identity gets a link, arg ignored", () => {
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: unlinked, pinned: null, reachable: [WS_A] })
    ).toEqual({ kind: "send_link" });
  });

  it("linked with no reachable workspaces", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [] })
    ).toEqual({ kind: "no_workspaces" });
  });

  it("linked, one reachable, unpinned, bare -> pin it", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [WS_A] })
    ).toEqual({ kind: "pin", workspace: WS_A });
  });

  it("linked, two reachable, unpinned, bare -> choose", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "choose", options: [WS_A, WS_B] });
  });

  it("named match is case-insensitive", () => {
    expect(
      decideConnectCommand({ arg: "AGENTRAIL-DEV", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "pin", workspace: WS_A });
  });

  it("unknown name re-renders the list", () => {
    expect(
      decideConnectCommand({ arg: "nope", identity: linked, pinned: null, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "unknown_workspace", options: [WS_A, WS_B] });
  });

  it("ambiguous name re-renders rather than guessing", () => {
    const dupe = { id: "ws-c", name: "agentrail-dev" };
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: linked, pinned: null, reachable: [WS_A, dupe] })
    ).toEqual({ kind: "unknown_workspace", options: [WS_A, dupe] });
  });

  it("already pinned, bare -> status with alternatives excluding current", () => {
    expect(
      decideConnectCommand({ arg: "", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "already_pinned", workspace: WS_A, alternatives: [WS_B] });
  });

  it("re-pin to the workspace already pinned is a no-op status", () => {
    expect(
      decideConnectCommand({ arg: "agentrail-dev", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "already_pinned", workspace: WS_A, alternatives: [WS_B] });
  });

  it("re-pin allowed when the requester reaches BOTH", () => {
    expect(
      decideConnectCommand({ arg: "side-project", identity: linked, pinned: WS_A, reachable: [WS_A, WS_B] })
    ).toEqual({ kind: "repin", from: WS_A, to: WS_B });
  });

  it("re-pin REFUSED when the requester cannot reach the current pin", () => {
    // pinned to a workspace this identity is a stranger to: name is unknown.
    expect(
      decideConnectCommand({
        arg: "side-project",
        identity: linked,
        pinned: { id: "ws-foreign", name: null },
        reachable: [WS_B],
      })
    ).toEqual({ kind: "repin_refused" });
  });

  it("refusal carries no identifying detail", () => {
    const action = decideConnectCommand({
      arg: "side-project",
      identity: linked,
      pinned: { id: "ws-foreign", name: null },
      reachable: [WS_B],
    });
    expect(JSON.stringify(action)).not.toContain("ws-foreign");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command`
Expected: FAIL — `decideConnectCommand` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/console/lib/connect-command.ts`:

```ts
export interface WorkspaceRef {
  id: string;
  name: string;
}

/** The current pin. `name` is null when the requester cannot reach it — in
 * that case nothing about it may be echoed back (see `repin_refused`). */
export interface PinnedRef {
  id: string;
  name: string | null;
}

export type ConnectCommandAction =
  | { kind: "send_link" }
  | { kind: "no_workspaces" }
  | { kind: "pin"; workspace: WorkspaceRef }
  | { kind: "repin"; from: WorkspaceRef; to: WorkspaceRef }
  | { kind: "repin_refused" }
  | { kind: "already_pinned"; workspace: PinnedRef; alternatives: WorkspaceRef[] }
  | { kind: "choose"; options: WorkspaceRef[] }
  | { kind: "unknown_workspace"; options: WorkspaceRef[] };

export interface DecideConnectCommandInput {
  arg: string;
  identity: { userId: string | null };
  pinned: PinnedRef | null;
  reachable: WorkspaceRef[];
}

/** Exact, case-insensitive name match. Returns null for zero OR 2+ matches —
 * an ambiguous name must re-render the list, never silently pick one. */
function matchWorkspace(arg: string, reachable: WorkspaceRef[]): WorkspaceRef | null {
  const wanted = arg.trim().toLowerCase();
  if (!wanted) return null;
  const hits = reachable.filter((w) => w.name.toLowerCase() === wanted);
  return hits.length === 1 ? hits[0]! : null;
}

export function decideConnectCommand(
  input: DecideConnectCommandInput
): ConnectCommandAction {
  const { arg, identity, pinned, reachable } = input;

  // Account linking always comes first — the arg is meaningless until we know
  // which user this chat account belongs to.
  if (identity.userId == null) return { kind: "send_link" };
  if (reachable.length === 0) return { kind: "no_workspaces" };

  const target = arg ? matchWorkspace(arg, reachable) : null;
  if (arg && !target) return { kind: "unknown_workspace", options: reachable };

  if (!pinned) {
    if (target) return { kind: "pin", workspace: target };
    if (reachable.length === 1) return { kind: "pin", workspace: reachable[0]! };
    return { kind: "choose", options: reachable };
  }

  const alternatives = reachable.filter((w) => w.id !== pinned.id);
  if (!target || target.id === pinned.id) {
    return { kind: "already_pinned", workspace: pinned, alternatives };
  }

  // Authority rule: you may move a conversation BETWEEN workspaces you have
  // standing in, but you may not move one out of a workspace you are a
  // stranger to. `pinned.name` is non-null exactly when it is reachable.
  const current = reachable.find((w) => w.id === pinned.id);
  if (!current) return { kind: "repin_refused" };

  return { kind: "repin", from: current, to: target };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/console/lib/connect-command.ts apps/console/lib/connect-command.test.ts
git commit -m "feat(console): decide what /connect does from identity + pin state"
```

---

## Task 3: `repinConversationWorkspace`

**Files:**
- Modify: `packages/db-postgres/src/queries/jace_sessions.ts` (append near `pinConversationWorkspace`)
- Test: `packages/db-postgres/src/queries/jace_sessions.repin.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `repinConversationWorkspace(input: { chatIdentityId: string; channel: string; conversationKey: string; fromWorkspaceId: string; toWorkspaceId: string }): Promise<{ ok: true; sessionId: string } | { ok: false; reason: "not_reachable" | "moved" }>`

Authority (reaching both workspaces) is decided in Task 2 and re-verified here
against `listWorkspacesForChatIdentity` — the check must not live only in the
caller. `moved` means the row's workspace changed under us between the decision
and the write; the caller re-resolves once rather than retrying in a loop.

- [ ] **Step 1: Write the failing test**

Create `packages/db-postgres/src/queries/jace_sessions.repin.test.ts`. Follow the mocking style already used by the sibling tests in this directory — read one first (`ls packages/db-postgres/src/queries/*.test.ts`) and mirror its `vi.mock` of the `db` handle exactly rather than inventing a new harness. Cover:

```
- refuses with "not_reachable" when the identity does not reach fromWorkspaceId
- refuses with "not_reachable" when the identity does not reach toWorkspaceId
- updates the row and returns ok + sessionId on the happy path
- returns "moved" when the guarded UPDATE matches zero rows
- the UPDATE is guarded on BOTH the session id AND the current workspace_id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/packages/db-postgres && pnpm test jace_sessions.repin`
Expected: FAIL — `repinConversationWorkspace` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface RepinConversationWorkspaceInput {
  chatIdentityId: string;
  channel: string;
  conversationKey: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
}

export type RepinConversationWorkspaceResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not_reachable" | "moved" | "conflict" };

/**
 * Move an already-pinned conversation to a different workspace.
 *
 * The pin belongs to the CONVERSATION, not to any identity in it (see
 * `resolveConversationWorkspace`'s doc-comment): every participant sharing
 * (channel, conversationKey) inherits it. So the authority rule is that the
 * requester must reach BOTH the current and target workspace — you may move a
 * conversation between workspaces you have standing in, but you may not walk
 * into a channel pinned to a workspace you are a stranger to and move it.
 * That rule is decided in `connect-command.ts` and RE-VERIFIED here, so a
 * caller bug alone cannot bypass it.
 *
 * The UPDATE is guarded on the row's CURRENT workspace_id, so a concurrent
 * re-pin that landed first yields `moved` rather than silently clobbering it.
 */
export async function repinConversationWorkspace(
  input: RepinConversationWorkspaceInput
): Promise<RepinConversationWorkspaceResult> {
  const { chatIdentityId, channel, conversationKey, fromWorkspaceId, toWorkspaceId } = input;

  const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
  const reaches = (id: string) => reachable.some((w) => w.id === id);
  if (!reaches(fromWorkspaceId) || !reaches(toWorkspaceId)) {
    return { ok: false, reason: "not_reachable" };
  }

  const now = new Date();
  const [row] = await db
    .update(jaceSessions)
    .set({ workspaceId: toWorkspaceId, updatedAt: now })
    .where(
      and(
        eq(jaceSessions.channel, channel),
        eq(jaceSessions.conversationKey, conversationKey),
        eq(jaceSessions.workspaceId, fromWorkspaceId)
      )
    )
    .returning();

  return row ? { ok: true, sessionId: row.id } : { ok: false, reason: "moved" };
}
```

Add `listWorkspacesForChatIdentity` to this file's imports if it is not already imported (it is used by `pinConversationWorkspace` above, so it should be).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/packages/db-postgres && pnpm test jace_sessions.repin`
Expected: PASS.

- [ ] **Step 5: Export and typecheck**

Confirm `repinConversationWorkspace` is re-exported from the package entrypoint the console imports from (`packages/db-postgres/src/index.ts` or the queries barrel — check how `pinConversationWorkspace` is exported and mirror it exactly).

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/packages/db-postgres && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add packages/db-postgres/src/queries/jace_sessions.ts packages/db-postgres/src/queries/jace_sessions.repin.test.ts
git commit -m "feat(db): repinConversationWorkspace with reach-both authority"
```

---

## Task 4: Reply copy

**Files:**
- Create: `apps/console/lib/connect-command-copy.ts`
- Test: `apps/console/lib/connect-command-copy.test.ts`

**Interfaces:**
- Consumes: `ConnectCommandAction`, `WorkspaceRef` from Task 2.
- Produces: `renderConnectReply(action: ConnectCommandAction, ctx: { linkUrl?: string; expiresAt?: Date; consoleUrl: string }): string`

Voice: direct, dry, no ceremony — matches `apps/jace/agent/instructions.md`'s
"Voice and reply length". Plain text only; Telegram, Discord and Slack all
render it.

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/connect-command-copy.test.ts` asserting one case per
action kind. The two that must be asserted precisely:

```ts
it("repin_refused names nothing about the current workspace", () => {
  const out = renderConnectReply({ kind: "repin_refused" }, { consoleUrl: "https://heyjace.com" });
  expect(out).toContain("already connected to a workspace you're not a member of");
  expect(out).not.toMatch(/ws-|workspace [A-Za-z0-9-]+ ->/);
});

it("repin states both sides so the change is never silent", () => {
  const out = renderConnectReply(
    { kind: "repin", from: { id: "a", name: "alpha" }, to: { id: "b", name: "beta" } },
    { consoleUrl: "https://heyjace.com" }
  );
  expect(out).toContain("alpha");
  expect(out).toContain("beta");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command-copy`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/console/lib/connect-command-copy.ts`:

```ts
import type { ConnectCommandAction, WorkspaceRef } from "./connect-command";

function list(options: WorkspaceRef[]): string {
  return options.map((o) => `- ${o.name}`).join("\n");
}

export function renderConnectReply(
  action: ConnectCommandAction,
  ctx: { linkUrl?: string; expiresAt?: Date; consoleUrl: string }
): string {
  switch (action.kind) {
    case "send_link":
      return ctx.linkUrl
        ? `Open this to connect your account:\n${ctx.linkUrl}\n\nIt works once, and expires in 30 minutes.`
        : `I couldn't create a connect link right now. Try /connect again in a moment.`;
    case "no_workspaces":
      return `Your account is connected, but you're not in a workspace yet. Create one at ${ctx.consoleUrl}, then send /connect again.`;
    case "pin":
      return `Connected to ${action.workspace.name}.`;
    case "repin":
      return `Moved this chat from ${action.from.name} to ${action.to.name}. Everyone here is now working in ${action.to.name}.`;
    case "repin_refused":
      return `This chat is already connected to a workspace you're not a member of, so I can't move it. Someone who is a member can, or you can change it in the console.`;
    case "already_pinned":
      // `workspace` is null when the requester cannot reach the current pin —
      // we must not name it, so the copy stays deliberately vague.
      return action.alternatives.length
        ? `This chat is connected to ${action.workspace?.name ?? "a workspace"}. To switch:\n${list(action.alternatives)}\n\nSend /connect <name>.`
        : `This chat is connected to ${action.workspace?.name ?? "a workspace"}.`;
    case "choose":
      return `Which workspace should this chat use?\n${list(action.options)}\n\nSend /connect <name>.`;
    case "unknown_workspace":
      return `I don't have a workspace by that name. Yours:\n${list(action.options)}\n\nSend /connect <name>.`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect-command-copy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/console/lib/connect-command-copy.ts apps/console/lib/connect-command-copy.test.ts
git commit -m "feat(console): /connect reply copy"
```

---

## Task 5: Wire `/connect` into the dispatcher

**Files:**
- Modify: `apps/console/lib/channel-dispatch.ts` (insert after line 571, before the `'ask'` branch at line 574)
- Modify: `apps/console/.env.example` (add `CONSOLE_PUBLIC_URL`)

**Interfaces:**
- Consumes: `parseConnectCommand`, `decideConnectCommand`, `renderConnectReply`, `repinConversationWorkspace`, plus existing `getChatIdentityById`, `listWorkspacesForChatIdentity`, `setChatIdentityLinkToken`, `pinConversationWorkspace`, `sendSystemChannelMessage`.
- Produces: nothing consumed by later tasks.

**Context the implementer needs.** At line 565 the dispatcher already holds
`identity` (a `chat_identities` row, so `identity.userId` is in hand) and
`chatIdentityId`. At 567–571 it computes `decision`. Insert the interception
immediately after 571. `payload.text` is the message text.

**Verify before you code:** `ensureConnectLink` below reads `identity.linkToken`
and `identity.linkTokenExpiresAt` off the row returned by `getChatIdentity`.
Confirm both columns are present on that row type (they are on the row
`consumeChatIdentityLinkToken` returns). If `getChatIdentity`'s select narrows
them away, widen it or re-fetch with `getChatIdentityById` — do not guess.

`CONSOLE_PUBLIC_URL` is a **new** env var. Every existing route derives its
origin from the incoming request (`new URL(request.url).origin`), but this
dispatcher is a background drain with no request, so the link cannot be built
without it. When it is unset, take the `send_link` branch with `linkUrl`
undefined — `renderConnectReply` already returns the honest failure copy.
Never emit a link against a guessed host.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/lib/channel-dispatch.test.ts` (create if absent, mirroring the mocking style of the existing console lib tests):

```
- a "/connect" row is consumed: completeChannelMessage called, runEveTurn NOT called
- a normal message row still reaches runEveTurn (no regression)
- an unlinked identity gets setChatIdentityLinkToken called once
- an identity with an unexpired existing token is NOT re-minted; the same URL is re-sent
- CONSOLE_PUBLIC_URL unset -> reply is the failure copy, row still completed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test channel-dispatch`
Expected: FAIL — `/connect` is forwarded to Jace.

- [ ] **Step 3: Write minimal implementation**

Insert after line 571:

```ts
    // --- '/connect': consumed here, never forwarded to Jace. Runs BEFORE the
    // resolution below so it works on conversations that cannot resolve at
    // all — a repair path with the same precondition as the broken thing is
    // not a repair path. Deterministic string match, never the model.
    const command = parseConnectCommand(payload.text);
    if (command.isCommand) {
      const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
      const pinnedId = decision.kind === "pinned" ? decision.workspaceId : null;
      const pinned = pinnedId
        ? reachable.find((w) => w.id === pinnedId) ?? { id: pinnedId, name: null }
        : null;

      const action = decideConnectCommand({
        arg: command.arg,
        identity: { userId: identity.userId },
        pinned,
        reachable,
      });
      // What we actually tell the user. Diverges from `action` only when a
      // write below loses a race — see the repin branch.
      let reportAction: ConnectCommandAction = action;

      let linkUrl: string | undefined;
      if (action.kind === "send_link") {
        linkUrl = await ensureConnectLink(identity, chatIdentityId);
      } else if (action.kind === "pin") {
        await pinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          workspaceId: action.workspace.id,
        });
      } else if (action.kind === "repin") {
        const moved = await repinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          fromWorkspaceId: action.from.id,
          toWorkspaceId: action.to.id,
        });
        // Lost a race, or the authority re-check refused: re-resolve ONCE and
        // report the state that actually exists, never retry in a loop. Same
        // posture as pinConversationWorkspace's own race contract.
        if (!moved.ok) {
          const now = await resolveConversationWorkspace({
            chatIdentityId,
            channel: row.channel,
            conversationKey: row.conversationKey,
          });
          const nowId = now.kind === "pinned" ? now.workspaceId : null;
          reportAction = nowId
            ? {
                kind: "already_pinned",
                // null when we cannot reach it — never echo an unreachable id.
                workspace: reachable.find((w) => w.id === nowId) ?? null,
                alternatives: reachable.filter((w) => w.id !== nowId),
              }
            : { kind: "repin_refused" };
        }
      }

      await sendSystemChannelMessage(
        row.channel,
        String(payload.chatId),
        renderConnectReply(reportAction, {
          linkUrl,
          consoleUrl: process.env["CONSOLE_PUBLIC_URL"] ?? "the console",
        }),
        payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined
      );
      await completeChannelMessage(row.id);
      return "completed";
    }
```

And the mint helper, near the other module-level helpers:

```ts
const LINK_TOKEN_BYTES = 24;
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Return a usable connect URL for this identity, re-sending an existing
 * unexpired token rather than minting a new one. Re-minting is last-write-wins
 * (`setChatIdentityLinkToken`), so a fresh mint would silently kill a link the
 * user is about to tap; re-sending is idempotent and self-rate-limits repeated
 * /connect. Returns undefined when CONSOLE_PUBLIC_URL is unset or the write
 * fails — the caller renders honest failure copy rather than a broken link.
 */
async function ensureConnectLink(
  identity: { linkToken: string | null; linkTokenExpiresAt: Date | null },
  chatIdentityId: string
): Promise<string | undefined> {
  const base = (process.env["CONSOLE_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!base) return undefined;

  const live =
    identity.linkToken &&
    identity.linkTokenExpiresAt &&
    identity.linkTokenExpiresAt.getTime() > Date.now();
  if (live) return `${base}/connect/${identity.linkToken}`;

  try {
    const token = randomBytes(LINK_TOKEN_BYTES).toString("hex");
    await setChatIdentityLinkToken(
      chatIdentityId,
      token,
      new Date(Date.now() + LINK_TOKEN_TTL_MS)
    );
    return `${base}/connect/${token}`;
  } catch {
    return undefined;
  }
}
```

Add imports: `randomBytes` from `node:crypto`; `parseConnectCommand`/`decideConnectCommand` from `./connect-command`; `renderConnectReply` from `./connect-command-copy`; `listWorkspacesForChatIdentity`, `setChatIdentityLinkToken`, `repinConversationWorkspace` from `@agentrail/db-postgres`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test && pnpm typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Document the env var**

Add to `apps/console/.env.example`:

```
# Absolute public origin of the console, e.g. https://heyjace.com. Required
# for /connect links: the channel dispatcher is a background drain with no
# incoming request to derive an origin from.
CONSOLE_PUBLIC_URL=
```

- [ ] **Step 6: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/console/lib/channel-dispatch.ts apps/console/lib/channel-dispatch.test.ts apps/console/.env.example
git commit -m "feat(console): handle /connect in the channel dispatcher"
```

---

## Task 6: Pin the redemption ordering

**Files:**
- Test: `apps/console/app/(auth)/connect/[token]/page.test.ts`

**Interfaces:** none.

**Why this exists.** `page.tsx` returns the signed-out sign-in screen at line 31,
*before* `consumeChatIdentityLinkToken` on line 90. A link-preview crawler —
and Telegram unfurls links in chat, visibly — is never signed in, so it never
consumes. Invert that order and every token burns on unfurl before the user
taps it. Nothing currently stops a refactor from inverting it.

- [ ] **Step 1: Write the test**

Render `ConnectPage` with `auth()` mocked to return no session, and assert
`consumeChatIdentityLinkToken` was never called. Mirror the `vi.mock` style of
the existing console page/route tests.

- [ ] **Step 2: Run it**

Run: `cd /Users/macbook/work/bensigo-ai-workflow-wt-connect/apps/console && pnpm test connect`
Expected: PASS against today's code — this is a regression guard, so it passes immediately. Verify it BITES by temporarily moving the consume above the signed-out return, re-running (expect FAIL), then restoring. Put both outputs in your report.

- [ ] **Step 3: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add "apps/console/app/(auth)/connect/[token]/page.test.ts"
git commit -m "test(console): pin signed-out-before-consume on the connect page"
```

- [ ] **Step 4: Open PR①**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git push -u origin feat/jace-connect-command
gh pr create --base main --title "feat(jace): /connect — bind a chat account to a workspace from any gateway" --body "<see spec: docs/superpowers/specs/2026-07-27-jace-connect-command-design.md>"
```

Before pushing, run `git diff --stat origin/main..HEAD` and confirm no
`pnpm-lock.yaml` and no `node_modules` entry appears.

---

## Task 7: Telegram forward core

**Files:**
- Create: `apps/jace/agent/lib/telegram_forward.core.mjs`
- Test: `apps/jace/test/telegram_forward.core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `shapeTelegramInbound(update): { ok: true, body: object } | { ok: false, reason: string }`
  - `forwardTelegramInbound({ env, update, transport }): Promise<{ ok: true } | { ok: false, reason: string }>`

Mirror `apps/jace/agent/lib/discord_gateway.core.mjs` exactly: pure, injected
`transport`, resolves console base URL + bearer from
`JACE_CONSOLE_BASE_URL` / `JACE_CONSOLE_TOKEN`, never throws, never retries.
Read that file first and match its doc-comment density and its
`resolveConsoleConfig` duplication convention (duplicated verbatim, not
imported — each core module here is dependency-free of the others by design).

- [ ] **Step 1: Write the failing test** covering: a well-formed update shapes correctly; an update with no message text is refused without a network call; a transport throw resolves to `{ok:false}` and never throws; a non-2xx status resolves to `{ok:false}` carrying the status; missing config resolves to `{ok:false, reason:"config_missing"}`.

- [ ] **Step 2: Run it** — `cd apps/jace && pnpm test telegram_forward` — expect FAIL (module missing).

- [ ] **Step 3: Implement** to match the Discord core's structure.

- [ ] **Step 4: Run it** — expect PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/jace/agent/lib/telegram_forward.core.mjs apps/jace/test/telegram_forward.core.test.mjs
git commit -m "feat(jace): pure core for forwarding Telegram updates to the console"
```

---

## Task 8: Flag the Telegram channel into shim mode

**Files:**
- Modify: `apps/jace/agent/channels/telegram.ts`
- Test: `apps/jace/test/telegram-channel.test.mjs`

**Interfaces:**
- Consumes: `forwardTelegramInbound` from Task 7.

`node --test` cannot import the `.ts` channels, so this repo asserts against
channel **source as text** — see `apps/jace/test/discord-channel.test.mjs` and
commit `e66d26ed`. Mirroring handler bodies inside the test would pass while
the channel is broken.

- [ ] **Step 1: Write the failing structural test** asserting the channel source references `JACE_TELEGRAM_FORWARD_TO_CONSOLE`, imports `forwardTelegramInbound`, and that outbound handlers (`message.completed` chat-split, `turn.started` typing keep-alive and ack) remain present and untouched.

- [ ] **Step 2: Run it** — `cd apps/jace && pnpm test telegram-channel` — expect FAIL.

- [ ] **Step 3: Implement.** When `JACE_TELEGRAM_FORWARD_TO_CONSOLE` is truthy, the inbound path calls `forwardTelegramInbound` and returns without starting a turn. When unset or falsy, today's behaviour is byte-for-byte unchanged. Do not touch any outbound handler.

- [ ] **Step 4: Run it** — expect PASS. Then `cd apps/jace && pnpm test` — full suite green.

- [ ] **Step 5: Commit and open PR②**

```bash
cd /Users/macbook/work/bensigo-ai-workflow-wt-connect
git status --short
git add apps/jace/agent/channels/telegram.ts apps/jace/test/telegram-channel.test.mjs
git commit -m "feat(jace): Telegram inbound forwards to the console behind a flag"
```

---

## Manual verification before the flag flips (not a code task)

Do NOT enable `JACE_TELEGRAM_FORWARD_TO_CONSOLE` in production until this is done:

1. On staging, hold a Telegram conversation of 3+ turns with the flag off.
2. Flip the flag on. Send another message.
3. Confirm from the Langfuse trace that `session.id` is **unchanged** and the turn sequence continues rather than restarting at 0.

`runEveTurn` passes no session or continuation token, so both doors *should*
resolve to the same Eve session for the same `chatId` — but this is unproven.
If it does not hold, flipping the flag resets every user's chat history
mid-conversation.

## Deferred (own issues, not this plan)

- Console-side Connections surface listing conversations and their pins.
- Splitting `fetch_pr_diff`'s `not_found` note so "no such PR" and "repo not connected" stop being indistinguishable.
- Langfuse subagent trace nesting.
- Retiring `bindChatIdentityWorkspace` in favour of `user_id`-only binding.
