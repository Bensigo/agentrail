# B2b-ii Reviewer Wiring (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Wire the (already-merged, flag-gated) boot plane into the reviewer of record: a `request_preview_boot` root tool that requests a boot and polls for its URL, and a rung-2 line in the review-job prompt so that a PR with no preview URL gets booted and browsed by the QA arm exactly as a real preview — with honest `not_testable` when no boot becomes ready.

**Architecture:** Thin consumer of B2b's live console routes. Root (the review-job agent) gains one tool and one prompt rung. The QA arm and the reviewer are unchanged (the settled reviewer-owns-the-VM / qa-keeps-the-browser split). Everything degrades cleanly: if the boot plane is off or a boot never readies, the affected ACs are `not_testable` with the concrete reason.

**Tech Stack:** `apps/jace` ESM `.core.mjs` (pure) + thin `defineTool` wrapper convention; `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md` §B2b (rung-2 / `request_preview_boot`); consumes the routes shipped in #1573.

## Global Constraints

- Worktree `feat/b2b-reviewer-wiring` off `origin/main` `2fe9a811` (boot plane present). No migration (no schema change).
- `apps/jace`: `pnpm install --ignore-workspace`; run tests via `cd apps/jace && pnpm test`; NEVER commit `apps/jace/pnpm-lock.yaml`.
- Repo hook BLOCKS Grep/Glob/bare `grep` — Read exact paths; `git grep`.
- **Live route contract this consumes (from #1573, do NOT re-derive — mirror exactly):**
  - `POST {base}/api/v1/runner/preview-boots` body `{eveSessionId, repo, prNumber, headSha}`, `Authorization: Bearer {JACE_CONSOLE_TOKEN}` → 200 `{id, deduped}`; 503 (boots disabled); 403 (workspace not enrolled); 404 (session/repo); 409 (no workspace); 400 (bad body).
  - `GET {base}/api/v1/runner/preview-boots/{id}?eveSessionId={eveSessionId}` Bearer → 200 `{status, url, reason}` where `status ∈ pending|claimed|booting|ready|failed|torn_down`; 404 (absent/foreign).
- **Root-tool conventions (mirror `apps/jace/agent/tools/post_pr_review.ts` + `lib/post_pr_review.core.mjs` and `fetch_issue.*`):** `defineTool({description, inputSchema: z.object(...), async execute(input, ctx)})`, default export, tool name = filename; **root session id is `ctx.session.id` directly** (NOT the `?? rootSessionId` subagent form); **no `approval`** (a headless review job has no human to approve — an approval gate would deadlock, per post_pr_review's header); copy `resolveConsoleConfig` **verbatim** from `lib/fetch_issue.core.mjs` (reads `JACE_CONSOLE_BASE_URL` + `JACE_CONSOLE_TOKEN`); never throw — degrade to a structured `{degraded, reason}` with stable cause-free notes.
- **Poll idiom (mirror `apps/jace/agent/lib/console_gated_approval.core.mjs`):** seam-split (`transport`, `sleep`, `now` injected; the thin wrapper supplies fetch-with-timeout + `setTimeout` + `Date.now`); backoff-before-GET, TTL checked each iteration, one blip-retry on a transient GET failure, per-call timeout distinct from the overall TTL.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/jace/agent/lib/request_preview_boot.core.mjs` (+ test) | POST + poll pure logic, error taxonomy |
| `apps/jace/agent/tools/request_preview_boot.ts` | thin `defineTool` wrapper (real transport/sleep/now) |
| `apps/jace/agent/lib/review_job_prompt.mjs` | the rung-2 line |
| `apps/jace/test/review_job_prompt.test.mjs` | update the verbatim pin + add a rung-2 match |
| `docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md` §4 | keep the prompt-pin source-of-truth in lockstep |

---

### Task 1: `request_preview_boot` root tool

**Files:** Create `apps/jace/agent/lib/request_preview_boot.core.mjs` + `apps/jace/agent/lib/request_preview_boot.core.test.mjs`; create `apps/jace/agent/tools/request_preview_boot.ts`.

**Interface (produces):**
```
requestPreviewBoot({ eveSessionId, repo, prNumber, headSha, env, transport, sleep, now }) ->
  Promise<{ ok:true, id, url } | { ok:false, degraded:true, reason, note }>
```
- `resolveConsoleConfig(env)` verbatim from `fetch_issue.core.mjs`; unset → `degraded("config_missing", {missing})`.
- POST `/api/v1/runner/preview-boots` with the Bearer + JSON body. Classify non-2xx to a stable reason: 503→`"boots_disabled"`, 403→`"not_enrolled"`, 404→`"session_or_repo"`, 409→`"no_workspace"`, 400→`"bad_request"`, other→`"request_failed"` (+status). Non-JSON body → `"bad_body"`. Transport throw → `"unreachable"`.
- On `{id}`, poll GET `/api/v1/runner/preview-boots/{id}?eveSessionId=…`: constants `POLL_BACKOFF_MS=[2000,5000,10000]` (cap at last), `POLL_JITTER_MS=250`, `POLL_TTL_MS=8*60*1000` (a real `npm ci` + dev-server boot can take minutes — this is how long root waits for READY, distinct from the boot's own live-TTL), `MAX_POLL_ATTEMPTS=1000`, `BLIP_RETRY_DELAY_MS=500`, `REQUEST_TIMEOUT_MS=8000`. Terminal mapping: `ready`→`{ok:true, id, url}`; `failed`→`degraded("boot_failed",{reason})`; `torn_down`→`degraded("boot_gone")`; deadline→`degraded("boot_timeout")`; a 404 on poll→`degraded("boot_lost")`.
- `degraded(reason, extra)` returns `{ok:false, degraded:true, reason, note: NOTES[reason], ...extra}`; `NOTES` are fixed strings (never interpolate transport text or secrets).

- [ ] Steps: TDD the core with injected `transport`/`sleep`/`now` — happy (POST→poll `pending`×2→`ready` returns url); `boot_failed`; `boot_timeout` (deadline hit); `boots_disabled` (503 POST, no poll); the backoff-before-first-GET + blip-retry. Then the thin `tools/request_preview_boot.ts` (mirror `post_pr_review.ts`: `defineTool`, `ctx.session.id`, real fetch-with-`AbortController`-timeout transport, `setTimeout` sleep, `Date.now`). → `cd apps/jace && pnpm test` green → Commit: `feat(jace): request_preview_boot root tool — request + poll the boot plane (B2b-ii)`.

### Task 2: rung-2 in the review-job prompt

**Files:** Modify `apps/jace/agent/lib/review_job_prompt.mjs` (the behavioral-AC bullet, ~line 55) + `apps/jace/test/review_job_prompt.test.mjs` (the `EXPECTED` verbatim pin + a new match) + `docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md` §4 (the pin's source-of-truth prose) + the `review_job_prompt.mjs` header comment (lines ~11-23) if it asserts the bullet count/verbatim-ness.

**The rung-2 rewrite** (replace the current single behavioral bullet; keep the `not_testable with the concrete reason` + `which environment rung was reached` language intact):
> - If acceptance criteria are behavioral (running-app behavior a diff cannot prove) AND the PR carries a reachable preview URL, dispatch qa against it and fold its ac_results into the posted review's coverage before posting (rung 1). If there is no preview URL, call request_preview_boot with (repo, prNumber, headSha); if it returns a booted URL, dispatch qa against THAT url exactly as rung 1 (rung 2). If there is no preview URL AND no boot becomes ready, do NOT guess: the affected ACs are not_testable with the concrete reason, and the posted review says which environment rung was reached.

- [ ] Steps: update the bullet in `review_job_prompt.mjs:55`; update the `EXPECTED` array element in `review_job_prompt.test.mjs` in LOCKSTEP (byte-for-byte) so the full-string pin passes; add `assert.match(reviewJobPrompt(JOB), /request_preview_boot/)`; confirm the existing `/not_testable with the concrete reason/` match still passes; update the §4 spec prose + the stale header-comment note. → `cd apps/jace && pnpm test` green → Commit: `feat(jace): review-job rung 2 — boot a no-preview PR before falling to not_testable (B2b-ii)`.

### Task 3: sweep + final review + PR

- [ ] Full `apps/jace` suite green; a wire-contract check that the tool's POST/GET shapes + query param match the live `preview-boots` routes (read them, confirm field names/casing). Coordinator runs a whole-branch review + opens the PR. (A full tool→worker→boot live smoke is optional — the routes+worker+boot were end-to-end-proven in #1573; this arc's new surface is the tool's poll logic (unit-covered) and the prompt pin.)

## Acceptance criteria (final walk)

1. `request_preview_boot` POSTs then polls with the console_gated_approval idiom (seam-split, backoff+TTL+blip-retry), maps every terminal + every non-2xx to a stable degraded reason, never throws, uses `ctx.session.id`, is ungated.
2. Wire matches the live routes byte-for-byte (body `{eveSessionId, repo, prNumber, headSha}`; poll `?eveSessionId=`; `status` vocab).
3. Rung 2 slots between rung 1 and the terminal `not_testable`; the verbatim prompt pin + a `request_preview_boot` match both pass; `not_testable`/`which rung` language preserved; the §4 spec pin is in lockstep.
4. Degrades cleanly with the boot plane OFF (503 → `boots_disabled` → ACs `not_testable`) — nothing breaks when `PREVIEW_BOOTS_ENABLED` is unset.
5. No migration; only `apps/jace` (+ the one spec doc) touched.
