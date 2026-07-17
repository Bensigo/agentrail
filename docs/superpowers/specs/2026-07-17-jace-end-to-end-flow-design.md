# Jace end-to-end flow: message → aligned → shipped — design

**Date:** 2026-07-17
**Status:** Draft for review
**Owner:** bensigo
**Supersedes/updates:** `2026-07-08-cloud-multitenant-jace-design.md` (execution-location decision REVERSED — see §2), `2026-07-09-console-fractional-engineer-redesign.md` (console demoted from front door to evidence surface; chat surface re-sequenced)
**Related:** `docs/prd/coordinator-on-eve.md`, `docs/prd/jace-goal-loop.md`

## 1. Problem

The product story and the shipped system have diverged into three products: the
README sells an AI fractional engineer, CONTEXT.md describes a context control
plane, TASTE.md's design guide mandates a dense dark observability console — and
the live funnel (heyjace.com) onboards a self-hosting operator (full-scope
OAuth on first click, hand-typed repo paths, BotFather tokens, a mandatory
local runner install) rather than the buyer the landing addresses. A
code-level audit (2026-07-17, three-way sweep of entry funnel, work-intake
paths, and execution pipeline) graded every story claim: chat-first entry,
cloud execution, backlog triage, goals, merge permission, approvals loop,
billing are missing or half-baked; the factory itself ships with its
independent reviewer silently disabled on default config, its dollar budget
unwired, and an AFK path that auto-merges with no permission concept.

This spec defines the one true end-to-end flow and everything required to make
it real. **Everything in scope becomes a GitHub issue now — nothing is parked
on a roadmap.** Delivery is sequenced, but the backlog is complete up front.

## 2. Decisions locked (this session, 2026-07-17)

| Decision | Choice |
|---|---|
| Product | **Jace** — an AI engineer (persona, not tool). AgentRail is the SDLC factory CLI underneath him. One product face: heyjace.com |
| Offer | Talk to Jace in chat; he indexes your repo on connect, helps sharpen fuzzy ideas into issues, **aligns with you before building**, works issues through a real SDLC in the cloud, ships PRs; no merge rights by default, grantable later |
| Pain / buyers | (1) Developers priced out of ~$20/mo agentic IDEs + fast-internet requirements (e.g. Nigeria), met on chat platforms they already use, hired per task or monthly; (2) small→enterprise teams whose hiring can't keep up with the backlog and who need production-level SDLC work, not vibe coding |
| Execution location | **REVERSAL of 2026-07-08 spec:** execution happens in the cloud on a hosted runner fleet with operator-supplied model access. "The VPS never runs customer code" is retired. Self-hosting stays possible (Jace is open source) but is the advanced path, not onboarding |
| Factory runtime | The cloud factory runs **Claude Code as the agent harness with third-party models via the AI gateway** (API-key routing; Anthropic OAuth path is not available for this). Per-phase model split stays. Compatibility of harness + gateway is a named verification item, not an assumption |
| Front door | **"Message Jace."** The landing page is Jace's resume; the CTA is messaging him — you don't sign up to talk to an engineer whose resume you like. Console sign-in remains as the secondary door |
| Channels | Shared, hosted Jace bot identity per platform, owned by us. **All of: Telegram (live today, was the test bed), Discord, Slack, iMessage, WhatsApp.** All are issues now; rollout ordered by code reality (§4.1) |
| Alignment gate | **Jace never starts development unverified.** Before any queue entry executes — chat-born or label-born — Jace posts an alignment brief (goal, approach, acceptance criteria, budget) and waits for user confirmation, delivered through the single approval seam |
| Workspace from chat | Every inbound chat message resolves to the user's workspace via a chat-identity link; Jace can create a workspace conversationally; multi-workspace users get asked once per conversation |
| Repo on your behalf | If no repo is connected, Jace (gated) **creates one on the user's GitHub** using the already-granted `repo` scope, connects it, and indexes it |
| Landing honesty rule | The landing may only claim what the live flow does. Capabilities appear on the page as they ship — the backlog is full-scope, the page is truthful at every moment |
| Scope philosophy | No "deferred" bucket. Goals, billing, console chat, backlog triage, isolation hardening, WhatsApp — **all filed as issues in this arc**, sequenced honestly |

## 3. The end-to-end flow (north star)

1. **See the resume** — heyjace.com: who Jace is, how he works, his real track
   record (failures counted), how to work with him.
2. **Message him** — CTA deep-links the shared Jace bot (Telegram first).
   No OAuth, no signup. The chat identity is the provisional account.
3. **Talk** — Jace introduces himself, answers questions about himself and
   (once connected) your codebase, runs `grill-me` on fuzzy ideas — read-only,
   zero setup, real value before any account exists.
4. **Connect** — when work needs a repo, Jace sends a connect-GitHub magic
   link in-chat. Completing it binds chat identity + GitHub account +
   workspace (created conversationally by Jace, or in the console).
   No repo yet? Jace offers to create one on your GitHub (gated).
5. **Index** — repo connect enqueues the `onboard` entry; the cloud factory
   executes it; Jace can now answer questions about the codebase.
6. **Align** — idea → issue draft → **alignment brief** (goal, approach,
   acceptance criteria, cost budget) → your explicit confirm through the
   approval seam. Label-born issues (GitHub `ready-for-agent`, Linear) get the
   same brief-and-confirm before first execution. Only then does work start.
7. **Build** — the cloud factory runs the SDLC: context pack → failing test
   first → red baseline → implement → independent review (ON) → objective
   gate — Claude Code harness, gateway models, dollar budget enforced.
8. **Ship** — PR opens (never merges). The link lands in your chat thread.
9. **Decide** — approve/deny requests, park reasons, and dead letters reach
   you as inline chat buttons and the console Approvals page — one seam.
   "Why did this fail?" in-thread gets a triage-subagent diagnosis.
10. **Trust ladder** — when you're ready, grant merge permission
    (default off, per-workspace toggle, revocable).
11. **Evidence** — the console: digest home, work board, runs, gates, costs.
12. **Pay** — per task or monthly (billing is in the backlog now; free while
    in preview until it ships).

## 4. Design

### 4.1 The door & channels

- One hosted Jace bot identity per platform, credentialed by us, multiplexing
  all workspaces (per-workspace BotFather tokens retired for the hosted
  product; the flow stays for self-hosters).
- Inbound resolution: platform + platform_user_id → chat-identity link →
  workspace (§4.2). Unknown identity → onboarding conversation, not an error.
- Rollout by code reality: **Telegram** (wired today; move to shared-bot
  model) → **Discord, Slack** (channel code exists; credential, wire
  end-to-end, verify) → **iMessage** (code exists on LoopMessage sandbox;
  production plan required) → **WhatsApp** (new build on Meta Cloud API;
  **business verification starts immediately in parallel** — it is the
  long-lead item).
- The landing CTA grows a platform picker as doors open; each platform's
  card appears on the landing only when its door actually works.

### 4.2 Identity & workspace

- New `chat_identities` table: platform, platform_user_id, display name,
  optional user_id (console account), workspace_id, created/linked timestamps.
  One-time link tokens back the connect-GitHub magic link; completing OAuth
  binds all three identities. Rides existing `jace_sessions` conversation keys.
- Jace tools (both `approval: always()`): `create_workspace` (name → console
  workspace, chat identity becomes owner-elect pending GitHub link) and
  `create_repo` (POST /user/repos with the workspace's stored OAuth token →
  auto-connect → webhook → onboard enqueue). The existing manual console
  flows remain.
- Multi-workspace: Jace asks once per conversation and pins the answer to the
  conversation key.

### 4.3 The cloud factory

- Hosted runner fleet (first: one generalized runner service on the prod
  deploy) claims queue entries for **all** early workspaces — both `kind=issue`
  and `kind=onboard` (new executor: onboard = index + seed workspace memory,
  closing the "indexing entry sits queued forever" hole).
- Runtime contract: **Claude Code harness, third-party models via the AI
  gateway**, per-phase model split config baked into the hosted runner image.
  Named verification item: harness+gateway compatibility end-to-end on the
  prod box before the door opens.
- Wired ON in this path from day one: dollar budget (existing module,
  currently unwired; per-issue cap + workspace ceiling) and the independent
  reviewer (fix the silent-skip: hosted config always carries a distinct
  reviewer model; a default single-model install must WARN, not silently
  skip).
- Isolation: per-task container isolation at launch, documented honestly;
  hardened multi-tenant isolation is an issue in this arc, not a footnote.
- AFK quarantine: the auto-merge batch path is fenced off from customer
  repos (guard: refuses to run against repos with a hosted workspace unless
  explicitly overridden). Merging is human-only until §4.5's permission ships.
- Per-workspace cost metering rides the existing pricing/cost-ledger work —
  this is the substrate billing will bill against.

### 4.4 Alignment gate (the missing step)

- Mechanics: admission produces an **alignment brief** — goal, planned
  approach, acceptance criteria, cost budget — posted to the workspace's
  channel(s). The entry holds (parked, reason "awaiting alignment") until the
  user confirms. Confirm/deny are `jace_approvals` rows resolved through the
  **single approval seam** — same atomic flip, same buttons, no second path.
- Chat-born issues: the `grill-me → to-issues` flow ends in the brief; the
  existing gated `create_issue` approval is enriched into it (one confirm,
  not two).
- Label-born issues (GitHub/Linear): brief on admission, before first claim.
- Config: `requireAlignment` default ON per workspace; relaxing it later is
  the same trust ladder as merge permission.

### 4.5 The needs-you loop & trust ladder

- Consumers for the merged-but-unconsumed approvals plumbing: Telegram inline
  Approve/Deny (callback → `resolveApproval`), the console `/approvals` page
  (pending approvals, parked-with-reason, dead letters — queries exist), and
  replyable run-outcome threads (triage subagent answers "why did it fail?").
- Merge permission made real: DB column (workspace or repo scope), console
  toggle (default OFF), enforced at the publish step; the existing unreachable
  Merge Policy module gets wired to it. This is the probation ladder the
  story promises.

### 4.6 Factory repairs (agentrail CLI)

Each is its own issue: reviewer silent-skip fix (see §4.3); dollar budget
wiring; onboard executor; Linear intake made safe (webhook receiver or
heartbeat coexistence rules — no double-claims) and reclassified in the
connector catalog as an issue source; merge-permission wiring; docs/quickstart
rewritten off the wrong flow; `source='cli'` path either implemented or
removed from the enum.

### 4.7 Landing = Jace's resume

- Structure: **who I am** (persona hero, kept) → **how I work** (SDLC
  honestly: failing test first, independent review, aligned before building,
  nothing merges without you) → **track record** (live dogfood numbers,
  failures counted — "I count the ones that didn't land" survives) → **how we
  work together** (channels that are actually open; permission ladder) →
  **Message me.**
- The centerpiece demo is a **real chat conversation with Jace** (the actual
  product), replacing the dashboard mockup that today shows the deleted
  observability console.
- Copy passes the anti-slop skill; visuals use the console tokens + the
  installed design skills; the tab/brand say Jace / heyjace.com.
- Claims track the honesty rule (§2). Goals, billing, triage, unlaunched
  channels: absent from the page until their issues ship.

### 4.8 Truth infrastructure

- README, CONTEXT.md, TASTE.md rewritten to the locked story: one product
  (Jace the engineer), AgentRail = the factory CLI under him, light-first
  design direction replacing the "dense dark observability" guide.
- Every `useagentrail.com` reference replaced with heyjace.com; docs
  quickstart teaches Message-Jace; self-hosting moves to an explicit
  advanced/open-source page.
- These files are the reason agents kept rebuilding the old product; fixing
  them is a deliverable with its own verification (a fresh agent briefed only
  by the repo should describe the current product).

## 5. Backlog enumeration (all filed as issues in this arc)

Grouped for issue creation (house format, one issue per bullet unless noted):

- **Door:** shared Telegram bot model; Discord credential+verify; Slack
  credential+verify; iMessage production plan; WhatsApp Cloud API build;
  WhatsApp business verification (process issue, starts now); landing platform
  picker.
- **Identity:** `chat_identities` + link tokens + magic-link flow;
  `create_workspace` tool; `create_repo` tool; multi-workspace disambiguation.
- **Factory (cloud):** hosted runner fleet service; onboard executor;
  Claude-Code-with-gateway runtime verification; per-task isolation;
  isolation hardening; dollar-budget wiring; reviewer silent-skip fix;
  AFK customer-repo quarantine; per-workspace cost metering surface.
- **Alignment & approvals:** alignment brief + parked-awaiting-alignment
  admission; Telegram approve/deny callbacks; console /approvals page;
  replyable run-outcome threads; merge-permission column + toggle +
  enforcement.
- **Intake:** Linear webhook-or-safe-heartbeat; connector catalog
  reclassification; GitHub repo picker (replace hand-typed owner/repo, uses
  granted scope); incremental OAuth consent (minimal scopes at sign-in,
  escalate to `repo` only at connect/create time, with the documented
  re-login migration for existing users).
- **Console:** onboarding wizard rework (runner step → advanced; steps derive
  from the new flow); "Give Jace a task" affordances pointing at chat;
  console chat (jace_messages + worker sender + UI); light-theme default
  flip (prep merged, flip pending); UUID→names header cleanup.
- **Landing & truth:** resume landing rebuild; chat-demo component; canon
  file rewrites (README/CONTEXT/TASTE); domain sweep; docs quickstart
  rewrite; tab/brand fix.
- **Later-sequenced but filed now:** goal loop (schema + loop + Home card);
  billing (per task / monthly); backlog triage (the real one — Jace grooms
  open issues); WhatsApp launch on the landing.

## 6. Verification

- Every UI surface browser-verified on the live deploy (heyjace.com), not
  just locally; every chat behavior verified in a real channel session.
- **The arc's acceptance test is the flow itself:** a fresh Telegram identity
  messages Jace → grill-me → workspace + repo created → indexed → aligned →
  factory builds → PR link in thread → approve → merge stays human. Runs as
  a scripted canary against prod after each door/factory PR.
- Factory changes keep the existing gates (hidden tests + $ as arbiter);
  two-set acceptance gate applies to any flow-behavior change.
- Docs verification: fresh-agent briefing test (§4.8).

## 7. Sequencing

**Step zero — before any agent-executed issue starts: the canon rewrite**
(README, CONTEXT.md, TASTE.md to the locked story; useagentrail.com →
heyjace.com sweep). Rationale: the agents executing this arc's issues read
those files first; leaving them describing the old product would corrupt the
arc with the exact disease it cures. (The user-facing docs/quickstart rewrite
is the one §4.8 piece that waits — it teaches Message-Jace, so it lands with
the landing rebuild once the door actually works.)

Then: door → identity → cloud factory (incl. onboard executor + runtime
verification) → alignment gate → approvals loop → landing rebuild +
quickstart — with §4.6 repairs slotted where they block the slice, and
long-lead items (WhatsApp business verification, LoopMessage production plan)
started immediately in parallel. One PR per piece; nothing marked done
without live verification (§6). Issues for **everything** in §5 are filed up
front so the backlog is the single source of what remains.
