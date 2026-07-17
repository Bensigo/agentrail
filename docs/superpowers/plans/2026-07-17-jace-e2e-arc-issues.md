# Jace End-to-End Arc — Issue-Cutting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans when implementing individual issues from this board. This plan's own execution = publishing the board (epic + issues below), then working issues wave by wave.

**Goal:** Turn spec `docs/superpowers/specs/2026-07-17-jace-end-to-end-flow-design.md` (§5) into a complete, dependency-ordered GitHub issue board — the single source of what remains — then execute wave by wave.

**Architecture:** One parent epic; seven waves. Wave 0 (canon rewrite) lands before any agent-executed issue starts. Long-lead process issues (Meta verification, LoopMessage production) start immediately in parallel. Each issue is a vertical tracer-bullet slice carrying its own PR-split list sized for human review.

**Tech Stack:** Next.js console (`apps/console`), Eve-based Jace (`apps/jace`), Python factory CLI (`agentrail/`), Drizzle/Postgres (`packages/db-postgres`), Railway prod (heyjace.com), Claude Code harness + AI-gateway models.

## Global Constraints (from spec §2 — every issue inherits these)

- **PR sizing rule (owner-stated):** one issue ships as MULTIPLE small stacked PRs (e.g. schema → logic → UI), each reviewable alone. Never one big PR per issue.
- **Landing honesty rule:** heyjace.com only claims what the live flow does.
- **Alignment gate:** `requireAlignment` defaults ON once shipped; Jace never starts development without a confirmed brief.
- **Merge stays human** until the merge-permission issue ships; AFK never touches customer repos.
- **Verification:** UI verified in the browser on the live deploy; chat behavior verified in a real channel session; factory changes keep hidden-tests + $ as arbiter; Drizzle migrations must land in `_journal.json` with monotonic `when`.
- **House issue format:** every issue body carries Parent / Required context / What to build / Acceptance criteria / Verification evidence / Blocked by. The factory applies `ready-for-agent` server-side when an issue is dispatched — filing applies no labels.
- **Model policy:** factory = Claude Code harness + AI-gateway third-party models; per-phase split default; per-task override = coding model only.

---

## Epic (file first)

**E. epic: Jace end-to-end flow — message-first door, cloud factory, alignment gate**
Body: spec §1–§3 condensed; ACs = the north-star flow steps as observable checkboxes, closing when the §6 canary passes on prod (fresh chat identity → grill-me → workspace+repo → indexed → aligned brief → factory PR link in thread → approve → merge stays human). All issues below set Parent = this epic.

## Wave 0 — Truth first (blocks all agent-executed work)

**W0-1. docs(canon): rewrite README, CONTEXT.md, TASTE.md to the Jace story**
Depends: none. Blocks: every agent-executed issue below.
PR splits: ① README rewrite + `useagentrail.com`→`heyjace.com` sweep ② CONTEXT.md rewrite (Jace the engineer; AgentRail = factory CLI; retire "context control plane" framing) ③ TASTE.md console guide → light-first product direction (retire "dense dark observability… dark-first") ④ console tab/brand says Jace (`apps/console/app/layout.tsx` metadata).
AC: fresh-agent briefing test — an agent briefed only by the repo describes chat-first Jace, cloud factory, light-first design; zero live `useagentrail.com` references.

**W0-2. process: WhatsApp Business (Meta Cloud API) verification — start now**
Depends: none. Long-lead; owner does the Meta side, issue tracks credentials into prod env.
PR splits: none until credentials exist; then ① env/config plumbing.
AC: verified WABA + phone number id + a successful test send recorded.

**W0-3. process: iMessage production plan (LoopMessage)**
Depends: none. PR splits: ① prod credential plumbing when purchased.
AC: production-capable LoopMessage credentials in prod env; sandbox limits documented as gone.

## Wave 1 — Identity spine + the door

**W1-1. feat(identity): `chat_identities` table + inbound workspace resolution**
Depends: W0-1.
PR splits: ① schema + migration + queries (platform, platform_user_id, display, user_id?, workspace_id, link tokens) ② Jace inbound resolution (message → identity → workspace; unknown → onboarding conversation) ③ multi-workspace disambiguation (ask once, pin to conversation key).
AC: a Telegram message from a linked identity resolves its workspace; unknown identity gets the onboarding conversation, not an error.

**W1-2. feat(door): shared hosted Jace bot (Telegram) replaces per-workspace BotFather tokens**
Depends: W1-1.
PR splits: ① hosted-bot env/config + webhook consolidation to the shared bot ② conversation→workspace mapping via `chat_identities` ③ migration for existing per-workspace-bot workspaces (self-host flow stays documented).
AC: a stranger DMs the Jace bot with zero setup and gets a conversation; existing workspace keeps working.

**W1-3. feat(identity): connect-GitHub magic link in chat**
Depends: W1-1.
PR splits: ① one-time link-token issue + bind API (chat identity + GitHub account + workspace) ② Jace-side send + post-bind confirmation message.
AC: completing the link from a chat thread binds all three; Jace confirms in-thread.

**W1-4. feat(jace): gated `create_workspace` tool**
Depends: W1-1. PR splits: ① tool + console API endpoint ② bind chat identity as owner-elect pending GitHub link.
AC: Jace creates a workspace conversationally after approval; console shows it.

**W1-5. feat(jace): gated `create_repo` tool — repo on the user's behalf**
Depends: W1-3.
PR splits: ① GitHub `POST /user/repos` via stored OAuth token + auto-connect + webhook + onboard enqueue chain ② Jace tool + approval copy ("I'll create <name> on your GitHub").
AC: "create a repo for this idea" → approved → repo exists, connected, webhook set, onboard entry queued.

## Wave 2 — Cloud factory

**W2-1. verify(runtime): Claude Code + AI-gateway end-to-end on prod**
Depends: W0-1. The spec's named verification item — not assumed.
PR splits: ① runner image/config running Claude Code headless against gateway models ② one real issue executed E2E on a test repo with evidence attached to the issue.
AC: a queued test issue reaches green gate + PR using gateway models; cost ledger recorded.

**W2-2. feat(factory): hosted runner fleet service**
Depends: W2-1.
PR splits: ① Railway service definition + multi-workspace claim loop ② per-task container isolation (documented honestly) ③ ops runbook.
AC: a workspace with NO self-hosted runner gets queued work executed in the cloud.

**W2-3. feat(factory): onboard executor — indexing runs in the cloud**
Depends: W2-2.
PR splits: ① `kind=onboard` executor (context index + workspace-memory seed) ② completion wiring so Jace answers codebase questions post-index.
AC: repo connect → onboard entry executes → Jace answers a codebase question about that repo.

**W2-4. fix(factory): wire the dollar budget (absorbs #1224)**
Depends: W0-1.
PR splits: ① per-issue cap enforced in the product path (default non-zero) ② workspace ceiling + surfacing in console/chat.
AC: a run exceeding its cap stops/escalates; #1224 closed by this issue.

**W2-5. fix(factory): independent reviewer must not silently skip**
Depends: W0-1.
PR splits: ① hosted config always carries a distinct reviewer model ② single-model installs WARN loudly instead of skipping.
AC: default hosted run shows reviewer verdict evidence; local single-model run prints the warning.

**W2-6. fix(factory): AFK customer-repo quarantine**
Depends: W0-1. PR splits: ① guard refusing AFK against hosted-workspace repos without explicit override.
AC: AFK against a hosted workspace repo refuses with a clear message.

**W2-7. feat(console): per-workspace cost metering surface**
Depends: W2-4. PR splits: ① per-workspace ledger aggregation ② console surface (the substrate billing bills against).
AC: workspace page shows per-task and period cost from real ledgers.

## Wave 3 — Approvals seam consumers + alignment gate

**W3-1. feat(channels): Telegram approve/deny callbacks → the seam flip**
Depends: W1-2.
PR splits: ① callback handler → `resolveApproval` atomic flip ② run-outcome messages carry buttons.
AC: tapping Approve in Telegram resolves the `jace_approvals` row and unblocks the waiting flow.

**W3-2. feat(factory): alignment gate — brief + parked-awaiting-alignment admission**
Depends: W3-1.
PR splits: ① brief generation (goal, approach, AC, suggested model + cost, budget) posted to channels ② admission holds entries parked "awaiting alignment" until confirm; `requireAlignment` default ON ③ label-born issues (GitHub/Linear) get brief-before-first-claim.
AC: no entry executes before a confirmed brief; chat-born confirm collapses into one approval.

**W3-3. feat(factory): per-task model suggestion + override**
Depends: W3-2.
PR splits: ① task-type-aware suggestion logic + brief field + queue column ② WorkItem passthrough + coding-model-only runner precedence + cost re-estimate.
AC: UI-task brief suggests the frontend-strong model; user override changes the coding model only; reviewer seat unchanged.

**W3-4. feat(console): /approvals page**
Depends: W3-1.
PR splits: ① page (pending approvals / parked-with-reason / dead letters — queries exist) ② approve/requeue actions through the same seam.
AC: single approval seam preserved — console actions and Telegram buttons resolve identically.

**W3-5. feat(jace): replyable run-outcome threads**
Depends: W3-1. PR splits: ① outcome messages land in threads Jace answers ("why did this fail?" → triage subagent).
AC: replying to a failure ping yields a diagnosis in-thread.

**W3-6. feat(trust): merge permission — real, default OFF**
Depends: W0-1.
PR splits: ① DB column (workspace/repo scope) + console toggle ② enforcement at publish + wire the existing Merge Policy module.
AC: default = PR only; toggled ON = merge after green gate; audit trail records who granted.

## Wave 4 — Landing, console, docs truth

**W4-1. redesign(marketing): the resume landing**
Depends: W1-2, W1-3 (CTA must be true).
PR splits: ① chat-demo component (real conversation replaces the dashboard mockup) ② structure/copy per resume shape, anti-slop pass, console tokens ③ platform picker (cards appear only for open doors) + secondary sign-up button (nav + footer) ④ claims audit vs honesty rule.
AC: page sells only live capabilities; demo is a Jace conversation; browser-verified on heyjace.com.

**W4-2. docs: quickstart rewrite — Message-Jace first, self-hosting = advanced**
Depends: W4-1. PR splits: ① quickstart ② self-host/open-source page.
AC: docs teach the message-first flow; runner install appears only under advanced.

**W4-3. feat(console): onboarding wizard rework**
Depends: W1-2, W1-3.
PR splits: ① steps re-derived from the new flow (runner step → advanced, chat-first step in) ② "Give Jace a task" affordances on Home/Work pointing at chat.
AC: fresh workspace completes setup without ever seeing a runner install; empty states link to a real action.

**W4-4. feat(console): light-theme default flip**
Depends: W0-1 (TASTE.md now says light-first). Prep (#1249 hex→vars) merged.
PR splits: ① flip `layout.tsx` default + `color-scheme` (dark stays as toggle).
AC: default render is light; dark toggle works; zero visual regressions in engine room.

**W4-5. fix(console): names over IDs in workspace header**
Depends: none. PR splits: ① header shows name/slug; UUID demoted to href/tooltip.
AC: no raw UUID as visible header text.

## Wave 5 — Filed now, sequenced after the spine

**W5-1. feat(channels): Discord — credential + verify E2E** (dep W1-2 pattern; splits: ① credentials/config ② E2E verify + landing card)
**W5-2. feat(channels): Slack — credential + verify E2E** (same shape as W5-1)
**W5-3. feat(channels): WhatsApp build on Meta Cloud API** (dep W0-2 + W1-2; splits: ① channel file + webhook ② E2E verify + landing card)
**W5-4. feat(channels): iMessage production launch** (dep W0-3 + W1-2)
**W5-5. feat(console): console chat** (jace_messages schema → worker sender → polling UI; 3 PRs; supersedes closed #1235's design carry-over)
**W5-6. feat(jace): goal loop** (schema + loop + leash + Home card; 3 PRs; per `docs/prd/jace-goal-loop.md`)
**W5-7. feat(billing): hire per task or monthly** (metering exists via W2-7; splits: ① plans/checkout ② enforcement ③ pricing page — landing claims only after ship)
**W5-8. feat(jace): backlog triage — the real one** (Jace grooms open issues: prioritize, dedupe, staleness; 2 PRs)
**W5-9. feat(intake): Linear webhook-or-safe-heartbeat + catalog reclassification** (2 PRs; kills the double-claim hazard)
**W5-10. feat(console): GitHub repo picker** (replace hand-typed owner/repo using granted scope; 2 PRs)
**W5-11. feat(auth): incremental OAuth consent** (minimal at sign-in, escalate at connect/create; documented re-login migration; 2 PRs)
**W5-12. feat(factory): isolation hardening** (beyond per-task containers; 2+ PRs)

## Kept-open issues absorbed by this board

- #1172 (verify gate vs hidden tests) — stays open, executes in the Wave-2 factory lane.
- #1224 — closed by W2-4 when it ships. #1221/#1222/#1223/#1225 — eval substrate, untouched by this arc.

## Publication procedure

1. File the epic (E) first via `gh issue create` with the house-format body; capture its number.
2. File waves in order W0 → W5, each body: Parent = epic; Required context = the spec decisions binding that slice (+ researcher citations where external tech is involved); What to build = the PR splits above; AC as checkboxes; Verification evidence per Global Constraints; Blocked by = the Depends line.
3. No labels at filing; `ready-for-agent` is applied at dispatch time per sequencing.
4. Routing per issue at execution time: AFK-able = self-contained factory/CLI slices (W2-4/5/6, W4-5); subagent/direct = flow-touching, schema, channels, landing.

## Self-review (spec §5 coverage)

Door ✓(W1-2, W5-1..4) Identity ✓(W1-1/3/4/5) Factory ✓(W2-1..7, W5-12) Alignment/approvals ✓(W3-1..6) Intake ✓(W5-9/10/11) Console ✓(W4-3/4/5, W5-5) Landing/truth ✓(W0-1, W4-1/2) Later-sequenced ✓(W5-6/7/8) Long-leads ✓(W0-2/3). Model rule consistency: W3-3 matches spec §4.4 (task-type-aware, coding-model-only). No placeholders; every issue has deps, splits, AC.
