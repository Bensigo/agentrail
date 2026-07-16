# Console redesign: fractional-engineer reframe — design

**Date:** 2026-07-09 (updated 2026-07-10: light theme default, goal card)
**Status:** Draft for review
**Owner:** bensigo
**Related:** `docs/superpowers/specs/2026-07-08-cloud-multitenant-jace-design.md` (cloud spec), plan PR #1102, `docs/prd/jace-goal-loop.md` (goal loop, PR #1144)

## 1. Problem

The console's information architecture is factory-operator-centric. All 16
workspace surfaces (`runs`, `queue`, `review-gates`, `costs`, `scorecard`,
`context-quality`, `failures`, `memory`, `repos`, `api-keys`, `connectors`,
`members`, `teams`, …) speak CI-plumbing vocabulary. The product is now a
**fractional engineer**: companies talk to Jace in chat (Slack/Telegram/…),
assign work, and their own runner ships PRs. The console has:

- no surface for the new primitives the cloud spec creates (pending approvals,
  Jace conversations, dead-lettered messages),
- no onboarding flow for a new company,
- a home page that answers "what is the machine doing" instead of
  "what did my engineer get done and what needs me".

The frame needs a full redesign; the code mostly does not — existing pages are
the evidence layer that makes a fractional engineer trustworthy.

## 2. Decisions locked (brainstorm 2026-07-09)

| Decision | Choice |
|---|---|
| Audience | Owner/admin + evidence. Chat is the team's daily surface; the console is the owner/eng-lead's tool |
| Home page | "This week from Jace" digest (shipped / in progress / needs you / cost) |
| In-console chat | Yes — minimal, riding the channel-inbox seam as `channel='console'` |
| Visual scope | Reframe on the existing `@agentrail/ui` kit; no rebrand in this arc |
| Approach | Two-zone IA reframe in place (no clean-slate shell, no URL breakage) |
| Theme (2026-07-10) | **Light background is the default**; dark stays as the existing toggle opt-in. All new surfaces in this spec are designed light-first: `:root` ramp (#ffffff canvas, #fcfcfc/#f9f9f9 panels, #e8e8e8 borders, #202020 text), accent `--brand-accent` = #9e6c00 amber on light — yellow #ffe629 is fill-with-dark-text only, never text on white. The flip itself ships as its own two-PR arc outside ①–⑦: (a) convert ~223 hard-coded dark-ramp hex literals in 42 console files to `var(--*-11)` tokens (zero visual diff while dark is default), (b) flip `layout.tsx` default class + `color-scheme` |
| Goal visibility (2026-07-10) | Home digest gains a flag-gated **goal card** — the console face of the Jace goal loop (`docs/prd/jace-goal-loop.md`, PR #1144). No new sidebar item in v1 |

## 3. Information architecture

Workspace sidebar reorganizes into three zones; every existing URL stays live.

**Your engineer** (new surfaces)
- `Home` — takes over the `[workspaceId]` overview route: the digest
- `Chat` — new `/chat`
- `Work` — new `/work`; `/queue` redirects to it (Next.js redirect)
- `Approvals` — new `/approvals`

**Engine room** (existing pages, demoted into a collapsible group)
- Runs, Review gates, Costs, Scorecard, Context quality, Memory, Failures
- Primarily reached by drilling into a work item; kept for trust/evidence

**Settings**
- Connectors (channels + GitHub incl. mandatory webhook secrets + runner
  attach), Repos, Members, Teams, API keys

### Vocabulary (most of the "redesign")

User-facing copy speaks employer-of-an-engineer language: *task, assigned, in
progress, needs you, shipped, Jace* — never `queue_entry`, `tier`,
`remaining_budget`. One pure, unit-tested mapping function used everywhere:

| queue state | user-facing |
|---|---|
| queued | Assigned |
| running | In progress |
| parked | Blocked — with the human reason (guardrail park reason / unmet blockers) |
| green | Shipped |
| escalated-to-human | Needs you |
| blocked | Blocked |

Engine-room pages keep technical depth but each gets a one-line plain-English
framing header. Names over IDs as primary text (house rule).

## 4. New surfaces

### Home — "This week from Jace"

Four blocks, one screen, week selector (default: this week):
1. **Shipped** — runs green this week with PR links (existing runs +
   ci-reconcile data).
2. **In progress** — work items running/assigned.
3. **Needs you** — one combined count: pending approvals + escalated-to-human
   + parked-with-reason + dead letters; links to Approvals.
4. **Cost this week** — one number + trend from existing cost data.

One action: **"Give Jace a task"** → Chat with a fresh thread. Data: existing
queries + one new aggregate endpoint (`GET /api/v1/workspaces/:id/digest`).
No new tables. Known-broken metrics (always-zero live context-quality,
one-sided savings) are excluded from Home.

**Goal card (flag `jaceGoalLoop`, default OFF — ships with the goal-loop PRD,
not this arc).** When a workspace goal is active, Home shows one card per goal:
objective, machine-check progress (metric value vs threshold, or
command-check pass state), issues filed/merged under the `goal:<slug>` label,
spend vs leash, and Pause/Abandon actions. The weekly digest gains one line per
active goal ("Coverage: 71% → 78%, 4 PRs merged, $11.30, leash 60%"). Data
comes from the `goals`/`goal_events` tables defined in
`docs/prd/jace-goal-loop.md` (PR #1144); this spec owns only the rendering.

### Approvals — the "waiting on you" inbox

Three lists on one page:
- **Pending approvals** (`jace_approvals` status=pending): tool, human summary
  of the draft, requester, age; Approve/Deny inline.
- **Parked work** (queue entries state=parked): the park *reason* in plain
  language; Requeue / Reject.
- **Dead letters** (`channel_inbox` state=dead): last error; Requeue.

**Invariant — single approval seam:** console Approve/Deny enqueues a
`channel_inbox` row (`channel='console'`, `kind='approval_response'`, same
`callbackToken`) exactly like a Telegram button. The worker's atomic
pending→resolved flip remains the only approval/publication path. No second
code path.

Roles: owner/admin can approve/requeue; members view.

### Work — the task list

`queue_entries` rendered through the vocabulary mapping; table with a board
toggle (Assigned / In progress / Blocked / Needs you / Shipped). Clicking a
work item lands on the existing run detail page (queue-entry id equals run id),
which gains a breadcrumb back to Work.

### Chat — minimal console channel

- Thread list + message view. Threads keyed
  `conversationKey='console:<userId>:<n>'` (per-member private threads).
- Send: POST → session + membership check → `enqueueChannelMessage`
  (`channel='console'`).
- Replies: the worker's sender registry gains a **console sender** writing to
  one new table `jace_messages` (workspaceId, conversationKey, role
  `user|jace`, text, createdAt; index on workspace+conversation). The send
  endpoint writes the user rows; the UI polls (no websockets in v1).
- Approval prompts render inline in the thread with the same Approve/Deny
  buttons as the Approvals page (same enqueue path).
- Any workspace member can chat.

## 5. Onboarding wizard

`/setup` (route exists) becomes the first-run flow. Step completion is
**derived from data** — no wizard-state table:

1. **Connect GitHub** — OAuth (exists) + repo selection + webhook: auto-create
   the repo webhook via the GitHub API with a generated secret (owner token has
   `repo` scope); manual instructions as fallback. Complete when the github
   connector has repos + webhookSecret.
2. **Connect a channel** — Telegram flow (exists); skippable.
3. **Say hi to Jace** — embedded console chat; first-conversation moment with
   zero external setup. Complete when a `jace_messages` reply exists.
4. **Invite your team** — invites (exist).
5. **Attach a runner** — device-flow code + live connected check (exists).

Incomplete steps show as a progress banner on Home linking back to the wizard.

## 6. Engine-room reframe (deliberately light)

Nav demotion, one-line framing header per page, breadcrumbs
Work item → run detail → gates / context packs, vocabulary function applied to
user-facing status chips. No page rebuilds.

## 7. Non-goals

No visual rebrand (the light-default theme flip is a separate two-PR arc — see
§2 — not part of this redesign's rollout); no cross-tenant operator view; no
billing; no marketing-site changes; no websockets; no changes to runner
protocol or factory behavior.

## 8. Dependencies & sequencing

- Home, Work, engine-room framing, onboarding steps 1/2/4/5: ship on today's
  tables — no dependency on the cloud plan.
- Approvals, Chat, onboarding step 3: require cloud plan (PR #1102) Tasks 4–5
  (schema/queries) and 7–9 (worker) merged, plus the console sender addition.
- Goal card on Home: requires the goal-loop schema + loop (PR #1144 PRD)
  merged; hidden behind `jaceGoalLoop` until then.
- Light-default flip: independent two-PR arc (token `var()` conversion →
  default flip); can land before, during, or after ①–⑦ with no ordering
  constraint — new surfaces use tokens from day one so they render correctly
  under either default.

**Rollout order (one PR each, no URL breakage):**
① nav shell (pure regroup) → ② Home digest → ③ Work + vocabulary →
④ engine-room framing/breadcrumbs → ⑤ onboarding wizard →
⑥ Approvals → ⑦ Chat (+ `jace_messages` + worker console sender).

## 9. Testing

- Pure functions (state vocabulary, digest aggregation, wizard-step
  derivation): unit tests.
- API routes: membership + role-gate tests (member vs admin on approvals).
- Every surface browser-verified via the DB-session flow (CI skips console
  tests — house rule).
- E2E canary once the worker is live: console chat → Jace reply → approve →
  GitHub issue → work item appears.

## 10. Follow-ups (out of scope here)

- Visual/brand pass across the console.
- Cross-tenant platform-operator view (tenant health, usage, dead letters).
- Websocket/SSE streaming for chat.
- Fixing the context-quality live metrics and net-cost metric before they can
  join Home.
