# Slack Multi-Workspace Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Any Slack workspace can install Jace themselves, and Jace replies to each with that workspace's own credentials — never another's.

**Architecture:** An OAuth install flow stores one encrypted bot token per Slack team. Inbound resolves the team from the event envelope; outbound moves from jace to the console, which holds the tokens. Identities become team-scoped so two workspaces cannot collide.

**Spec:** `docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md` — read it before starting; it records why each decision was made and what was ruled out.

## Global Constraints

- **Cross-tenant isolation is the whole point.** Any path where team A's message could resolve team B's token, identity, or conversation is a Critical defect, not a bug. When unsure, fail loudly rather than guess.
- **Telegram, Discord, console, and iMessage must be byte-unchanged.** Every existing test in `channel-dispatch.test.ts` must pass untouched.
- **Reuse the existing crypto**: `encryptSecret`/`decryptSecret` from `packages/db-postgres/src/crypto.ts` (AES-256-GCM, `CONNECTOR_SECRET_KEY`, `enc:v1:` format). Do NOT write new crypto.
- **Migration slot `0064`, journal idx `65`.** `0063` is claimed by open PR #1521 — verified. A migration missing from `_journal.json` is silently skipped at deploy.
- **Secrets never appear in logs, error strings, or HTTP responses.** Log a team id; never a token.
- **No new dependency.**
- `git add` only exact paths, never `-A`/`.` — other work is live in this repo.

**Testing discipline, learned the hard way this week:**
- Assert whole objects, not one field — two code paths can return the same boolean.
- Where absence is the point, assert it explicitly: Vitest's `toEqual`/`toHaveBeenCalledWith` treat an `undefined`-valued key as absent; `toStrictEqual`/`not.toHaveProperty` do not.
- `apps/console/lib/channel-dispatch.test.ts` mocks `@agentrail/db-postgres` **wholesale**. Any function newly called by `processRow` must be added to that factory or it is `undefined` at runtime — and `void fn(...).catch()` **throws synchronously** when `fn` is undefined or returns undefined, which silently fails the row. Use `vi.fn().mockResolvedValue(undefined)` for async ones.
- `pnpm build` in `apps/console` is mandatory before any PR. CI runs neither `next build` nor lint; a green vitest+tsc says nothing about whether it deploys.

---

### Task 1 — `slack_installations`: schema, migration, queries

**Files:** create `packages/db-postgres/src/schema/slack_installations.ts`, `packages/db-postgres/src/queries/slack_installations.ts` + its test; create migration `0064_slack_installations.sql`; modify `meta/_journal.json`, `schema/index.ts`, `queries/index.ts`.

**Shape** (model on `chat_identities`, NOT `connectors` — `connectors.workspace_id` is NOT NULL, and a Slack install happens before any AgentRail workspace exists):

`id` uuid pk · `team_id` text **unique notNull** · `team_name` text · `bot_token` text notNull (encrypted at rest) · `bot_user_id` text notNull · `installed_by_slack_user_id` text · `scopes` text · `enterprise_id` text nullable · `revoked_at` timestamptz nullable · `created_at`/`updated_at`.

**Exports** (Tasks 2–4 call these by these exact names):
```ts
upsertSlackInstallation(input: {teamId, teamName?, botToken, botUserId, installedBySlackUserId?, scopes?, enterpriseId?}): Promise<void>
getSlackInstallation(teamId: string): Promise<{teamId, teamName, botToken, botUserId, enterpriseId} | null>   // botToken DECRYPTED; null when absent OR revoked
revokeSlackInstallation(teamId: string): Promise<void>                                                        // sets revoked_at; never deletes
```

- `upsert` encrypts `botToken` via `encryptSecret` before write and clears `revoked_at` (a reinstall reactivates).
- `getSlackInstallation` decrypts, and returns `null` for a revoked row so every caller fails closed without needing to remember the check.

- [ ] Write failing tests first (follow the mocked-db conventions of the sibling `jace_sessions-*.test.ts` — this package has **no live-DB harness**; if a behaviour can only be proven against real Postgres, say so rather than writing an assertion that cannot fail).
- [ ] Cover: encrypt-on-write (the stored value must NOT equal the plaintext and must carry the `enc:v1:` prefix); decrypt-on-read round-trip; unknown team → `null`; revoked team → `null`; reinstall clears `revoked_at`.
- [ ] Confirm slot: `ls packages/db-postgres/drizzle/migrations/*.sql | tail -3` and the journal tail, before writing. Journal entry `when` must be LATER than the previous entry's.
- [ ] `pnpm --filter @agentrail/db-postgres build` clean.
- [ ] Commit: `feat(db): slack installations, one encrypted bot token per team`

---

### Task 2 — OAuth install + callback

**Files:** create `apps/console/app/api/v1/connectors/slack/install/route.ts` and `.../slack/callback/route.ts` + tests; create `apps/console/lib/slack-oauth.ts` (pure helpers) + test.

**Install** (`GET`): 302 to `https://slack.com/oauth/v2/authorize` with `client_id` (`SLACK_CLIENT_ID`), the bot scopes, `redirect_uri`, and a **signed, expiring `state`** for CSRF. Reuse an existing signing helper if one exists — search before writing one.

**Callback** (`GET`): validate `state` → exchange `code` at `POST https://slack.com/api/oauth.v2.access` (form-encoded, with `client_id`/`client_secret`) → `upsertSlackInstallation` → render a short "connected" page telling the user to `/invite @Jace` and mention it.

Response fields to read: `access_token`, `bot_user_id`, `team.id`, `team.name`, `authed_user.id`, `scope`, `is_enterprise_install`.

**Must handle, each with its own test:**
- `error=access_denied` (user declined) → friendly page, no row written.
- `ok: false` from Slack → no row written, error logged **without** the code or secret.
- Missing/expired/mismatched `state` → reject, no exchange attempted.
- **`is_enterprise_install === true` → refuse the install** with a clear message and write no row. Org-wide Grid installs break `team_id` keying; Slack truncates the event `authorizations` array to one entry. Guessing here means cross-org delivery.
- A 2xx whose body lacks `access_token`, `bot_user_id`, or `team.id` → treat as failure, not a partial write.

Put the pure parts (authorize-URL construction, response validation/normalization, Grid rejection) in `slack-oauth.ts` so they are testable without HTTP.

- [ ] Tests first; then implement; then `pnpm run typecheck` and `pnpm build`.
- [ ] Commit: `feat(slack): oauth install and callback`

---

### Task 3 — Team-scoped identity and per-install mention detection

**Files:** modify `apps/console/app/api/v1/connectors/slack/events/route.ts` + test.

Two changes:

1. **Identity key.** `resolveInboundChatIdentity` for Slack must key on `platformUserId = \`${team_id}:${event.user}\``. Slack user ids are unique only within a workspace; today two customers collide onto one identity row, and identity is what binds a conversation to an AgentRail workspace. Prod has **zero** Slack identity rows, so there is nothing to migrate. Add a doc-comment saying the composite is opaque — compared, never parsed.
2. **Mention detection per install.** Replace the `SLACK_BOT_USER_ID` env var entirely. Resolve the installation by the envelope's `team_id`; `mentionsBot` = text contains `<@${installation.botUserId}>`, `mentionsOtherUsers` = contains some other `<@U…>`.

**Fail-closed rule:** an event whose `team_id` has no installation (uninstalled, or never installed) must be **ignored with a log line** — not enqueued. There is no credential to reply with, so processing it could only end in a failed send or, worse, a fallback to someone else's token.

- [ ] Tests: two teams with the same Slack user id resolve to **different** identities (this is the cross-tenant test — it is the reason this task exists); mention detection uses the right team's bot id; an event from an unknown team is ignored; `is_enterprise_install`/`enterprise_id` events are handled per Task 2's stance.
- [ ] Delete `SLACK_BOT_USER_ID` from the code and from `deploy/.env.production.example`.
- [ ] Commit: `feat(slack): team-scoped identity and per-install mentions`

---

### Task 4 — Outbound moves to the console

**Files:** modify `apps/console/lib/slack-bot.ts`, `apps/console/lib/slack-system-message.ts`, `apps/console/lib/channel-dispatch.ts`; create a console route that jace posts replies to; modify `apps/jace/agent/channels/slack.ts`; delete jace's Slack token usage.

Today jace posts via eve's Slack channel using one process-wide token. That cannot serve many workspaces — eve's `botToken` thunk takes no arguments, and `slackChannel().receive()` hardcodes `teamId: null` with no field to pass one. See the spec §4 for why ambient context is unsafe here.

**New flow:** jace's `message.completed` hands the reply text back to the console (mirror `apps/jace/agent/lib/console_chat_reply.core.mjs` — read it and follow its shape, including its injected-transport testing pattern). The console resolves the installation by team and posts with `chat.postMessage`.

- The team id must travel **explicitly** — console → `auth.attributes` on the turn → back on the reply call. Never inferred, never ambient.
- `sendSystemSlackMessage` takes the team id and resolves per install; the `process.env.SLACK_BOT_TOKEN` read is deleted.
- Threading is unchanged: the console posts with `thread_ts`, which is what already makes Slack threads work.
- eve's native Slack typing indicator is lost. That is accepted (spec §4). Do not attempt to proxy it in this task.
- Remove `SLACK_BOT_TOKEN` from `apps/jace` entirely, and from `deploy/.env.production.example`.

- [ ] Tests: a reply for team A posts with A's token and never B's; an unknown/revoked team fails cleanly with a logged reason and no send; Telegram/Discord/console system sends are byte-unchanged.
- [ ] Commit: `feat(slack): console posts replies with the installing team's token`

---

### Task 5 — Verify and ship

- [ ] `cd apps/console && npx vitest run && pnpm run typecheck && pnpm build`
- [ ] `cd apps/jace && node --test test/*.test.mjs`
- [ ] `cd packages/db-postgres && pnpm vitest run && pnpm build`
- [ ] Leak scan: `git diff --name-only origin/main..HEAD | grep -E "node_modules|package-lock|pnpm-lock|/dist/"` → must be empty.
- [ ] Grep the diff for any literal token/secret before pushing.
- [ ] Push, open PR. Body must state: what changes for Slack, that Telegram/Discord/console are untouched, that Enterprise Grid is refused, and that `SLACK_BOT_TOKEN`/`SLACK_BOT_USER_ID` are removed.
- [ ] After merge, confirm the console **deployed** — do not report success on a merge alone; two PRs merged green on 2026-07-28 and neither deployed for nine hours.

**Ops, after this ships (owner does these):** set `NEXT_PUBLIC_SLACK_INSTALL_URL` to the new install route and `NEXT_PUBLIC_SLACK_CHANNEL_LIVE=true` to reveal the console's install button; add the Event Subscriptions request URL in the Slack dashboard (**only now** — Slack validates it on save, and it must not go live while the code cannot tell workspaces apart); then tick "Remove Hard Coded Information" and activate public distribution.

---

## Self-Review

**Spec coverage.** Task 1 = §1, Task 2 = §2 and §5, Task 3 = §3, Task 4 = §4 and §6. Rollout and verification are Task 5.

**Deliberately not here:** token rotation (opt-in; off means no expiry and no refresh machinery), Enterprise Grid org-wide installs (refused), Slack DM continuity (eve ties it to threading — needs its own design), Marketplace listing (public distribution is a lower and sufficient bar).

**Ordering.** Tasks 1→2→3→4 are strictly sequential: 2 needs 1's queries, 3 needs 1's lookup, 4 needs the team id 3 puts on the turn.

**Biggest risk.** Task 4 is where cross-tenant leakage would appear, because it is the only place a token is chosen. Its cross-tenant test is not optional.
