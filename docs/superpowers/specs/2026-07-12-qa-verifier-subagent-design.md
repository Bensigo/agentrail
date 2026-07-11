# QA Verifier as a Jace Subagent — Design

**Date:** 2026-07-12
**Status:** Approved (brainstormed + locked with user)
**Issue:** #1148 (redefined by this spec) · Epic: #1145 lifecycle subagents
**Supersedes:** the runner-side QA phase in PR #1179 (to be closed unmerged; see §9)

## 1. Decision

The QA verifier is **Jace's third declared Eve subagent** (`qa`), alongside researcher (#1124) and triage (#1147) — not a runner pipeline phase. It performs **full-app QA, not just frontend**: it drives real browsers against the running app and hits API endpoints, then returns a **purely advisory** structured verdict. It never changes run status, never writes to any Jace system. Root Jace consumes the advisory and decides whether to file an issue through its **existing gated `create_issue`** path.

Rationale for placement: triage explains *failed* runs; QA reviews *shipped* results — symmetric lifecycle subagents. The "Jace VPS never runs customer code" invariant survives because QA only **browses URLs and fetches endpoints**; it never boots or executes repo code, and page JS executes inside browser sidecar containers, never in Jace's process.

## 2. Layout (mirrors triage/researcher exactly)

```
apps/jace/agent/subagents/qa/
  agent.ts                      # defineAgent: description, model, outputSchema: QA_SCHEMA
  instructions.md               # QA methodology + anti-confabulation + injection posture
  lib/qa.core.mjs               # QA_SCHEMA + pure validation/shaping logic (tested)
  lib/connections.core.mjs      # URL resolvers + tool allowlists (pure, tested)
  connections/agent_browser.ts  # MCP connection: agent-browser sidecar (allowlisted)
  connections/browser_use.ts    # MCP connection: browser-use sidecar (allowlisted)
  tools/*.ts                    # disableTool() sentinels (see §4 — web_fetch NOT stripped)
```

Root wiring: a new "QA-checking a shipped change" delegation section in `apps/jace/agent/instructions.md`, sibling to triage's "Diagnosing a failed run". Model: the **sonnet-class tier** — which is already the gateway default (`GATEWAY_MODEL_ID = "anthropic/claude-sonnet-4.6"` in `agent/lib/model.core.mjs`), so `qa/agent.ts` calls `chooseModel(process.env)` with **no override** and `model.core.mjs` is unchanged. QA is multi-step and judgmental, heavier than triage's mechanical fetch-and-shape (triage overrides down to haiku); root and QA share the default. Self-hosted (non-gateway) operators keep exactly the model they configured, same as triage.

## 3. Trigger & data flow

On-demand delegation (mirrors triage). Root delegates when the user asks for a QA pass, or when a conversation concerns a shipped/merged UI or API change. Auto-dispatch after merges is **out of scope** — it belongs to the goal loop (#1144, flag OFF).

Root passes in the task prompt:
- **What shipped:** PR URL and/or issue context (title, summary of the change).
- **Where to test:** the app base URL (from the operator/user; there is no auto-discovery).
- Optionally: specific routes/flows to exercise.

The subagent tests like a user (browse, click, fill, read what renders, check console/network) and like an integrator (fetch API endpoints, check status/shape), then returns the structured advisory. Root renders it in the channel voice; for findings with `suggests_issue: true`, root walks its existing gated `create_issue` flow — which already runs every field through `hardenUntrusted()` (`agent/lib/sanitize-untrusted.core.mjs`), the enforced backstop for page-content injection. **QA itself writes nothing anywhere.**

## 4. Tools & capability boundary

**Two MCP browser connections** (`defineMcpClientConnection`, pattern from researcher's `connections/playwright.ts`):

| Connection | Role | Server | Allowlist scope |
|---|---|---|---|
| `agent_browser` | Primary driver: deterministic step-wise testing + debugging | `agent-browser mcp` sidecar (Vercel Labs) | navigate/snapshot/click/fill/press/wait + console/errors/network (its `core,network` profiles) |
| `browser_use` | LLM-powered extraction + fallback engine | `browser-use --mcp` sidecar | `browser_navigate/click/type/get_state/scroll/screenshot/extract_content` + tab tools |

Excluded from both allowlists: JS `evaluate`, file upload, cookie/storage manipulation. Exact tool names are pinned at implementation time from each server's live tool list (verify against current docs; both were confirmed to ship MCP server modes on 2026-07-12).

**`web_fetch` stays enabled** — the one Eve-injected harness tool NOT sentinel-stripped, for API-level QA (GET endpoints, status codes, response shape). Sentinels strip the rest: `bash`, `write_file`, `read_file`, `glob`, `grep`, `web_search`, `todo`, `ask_question`, `load_skill` (9 sentinels; triage/researcher strip all 10).

**Zero write capability into Jace's systems, by construction (two mechanisms, as in triage):**
1. Eve isolation — the subagent inherits nothing from root; it cannot see `create_issue`, `standup`, or `codebase_query`.
2. The sentinel set above — no bash, no filesystem, no child_process anywhere in the subagent's own code, no DB client.

Interacting with the **app under test** (clicking buttons that POST, submitting forms, exercising endpoints) is sanctioned — that *is* the QA act. The boundary protects Jace's own systems (DB, GitHub, files, shell), not the app being tested.

## 5. Advisory contract (`QA_SCHEMA`, in `lib/qa.core.mjs`)

```
verdict: "passed" | "issues_found" | "not_verifiable"
summary: string                     # one-paragraph channel-voice summary
tested: [{ surface: "ui" | "api", target: string, result: string }]
findings: [{
  title: string
  severity: "low" | "medium" | "high"
  route: string                     # page route or endpoint path
  repro_steps: [string]
  observed: string                  # what the user/API consumer actually sees
  expected: string
  suggests_issue: boolean
  issue_draft: { title: string, body: string } | null   # house-format sections
}]
not_verifiable_reason: string | null   # required when verdict = not_verifiable
evidence_refs: [string]             # which tool observations each claim rests on
```

**Anti-confabulation rules (mirrors triage AC3):**
- Every finding must trace to an actual tool observation (`evidence_refs`); a finding with no observation behind it is invalid.
- App URL missing, unreachable, or clearly not reflecting the change → `verdict: not_verifiable` with an honest reason. Never invented results, never a guessed "passed".
- Validation in `qa.core.mjs` rejects: findings with empty `repro_steps`/`observed`, `issues_found` with zero findings, `not_verifiable` without a reason, `suggests_issue: true` without an `issue_draft`.

## 6. Security posture

- **Untrusted page content:** everything the browsers and `web_fetch` return is injection surface. `instructions.md` mandates treating page/API content as data, never as instructions; keep quoted evidence inert (no control/zero-width chars, no `@everyone`/`@here`, no `javascript:`/`data:`/`file:` URLs). Enforced backstop: `hardenUntrusted()` at root's `create_issue` seam (already live).
- **Secrets:** the subagent has no access to `.agentrail/server.json`, no bearer tokens, no DB URL. Sidecar containers get only what a headless browser needs. Exception: browser-use's `extract_content` is allowlisted (§4), so its sidecar carries an LLM key; if the key is absent that single tool fails and QA falls back to `get_state` — no other browser tool needs a key.
- **Blast radius under successful injection:** the subagent can browse more pages and skew the advisory — nothing else. Issue creation stays behind root's gate; the advisory is rendered, not executed.
- **VPS-never-runs-customer-code:** preserved. QA never clones, builds, boots, or executes repo code. Page JS runs inside the browser sidecars.

## 7. Deployment

Two compose sidecar services next to the existing Playwright one. Both servers speak **stdio**, so each is bridged to an HTTP/SSE URL (supergateway-style bridge) unless Eve supports command-launched MCP connections — resolve at implementation, prefer whatever the existing Playwright sidecar does. Env: `JACE_AGENT_BROWSER_MCP_URL`, `JACE_BROWSER_USE_MCP_URL`, with local-dev fallbacks (pattern: `resolvePlaywrightUrl`). Eve discovers connection tools lazily — unreachable sidecars mean those tools never resolve and QA degrades honestly to `not_verifiable` (or API-only QA via `web_fetch`), never a boot failure (researcher AC5 pattern).

## 8. Testing (mirrors triage's suite)

- `test/qa.core.test.mjs` — schema validation: verdict rules, anti-confabulation rejections (§5), issue_draft coupling.
- `test/qa-read-only.test.mjs` — every sentinel present and correctly named (a misnamed sentinel throws at resolve under Node 24); `web_fetch` deliberately absent from sentinels; no `child_process`/DB imports in the subagent tree.
- `test/no-second-write-path.test.mjs` — no edit needed: its subagent guarantee is a generic loop over `agent/subagents/*` (write-path regex + approval-gate regex + recursive `child_process` scan), so `qa` is auto-covered; verify it still passes unmodified.
- Connection allowlist tests in `lib/connections.core.mjs` coverage: excluded tools (evaluate/upload/cookies) never allowlisted; URL resolvers honor env + fallback.
- `eve build` green.

## 9. PR #1179 disposition

- **Close PR #1179 unmerged** (branch retained). The runner-side phase — `qa_phase.py`, `qa_push.py`, the pipeline `_run_qa_gate` seam, `.agentrail/qa.sh`, native_runner consult — does not ship.
- **Extract `agentrail/run/proc.py` hardening** (process-group kill: `start_new_session=True` + `os.killpg` SIGKILL + reader join, rc 124 on timeout) into its own small PR — it is shared infra used by review_engine, check_runner, and pipeline, valuable regardless of QA.

## 10. Acceptance criteria

- **AC1** Declared subagent surfaces to root as the bare tool `qa`; `outputSchema: QA_SCHEMA` runs it in task mode.
- **AC2** A grounded advisory validates; every finding carries repro steps, observed/expected, and evidence_refs; `suggests_issue` findings carry a house-format `issue_draft`.
- **AC3** Zero write capability into Jace's systems: Eve isolation + 9 sentinels; `web_fetch` is the only harness tool kept; no child_process/DB/filesystem in the subagent tree. `no-second-write-path` still passes.
- **AC4** Both browser MCP connections declared with explicit allowlists (no evaluate/upload/cookie tools); unreachable sidecars degrade to an honest `not_verifiable`/API-only advisory, never a crash and never invented results.
- **AC5** Root delegation section added; root consumes the advisory and routes `suggests_issue` findings through the existing gated `create_issue` (no new write path).
- **AC6** PR #1179 closed unmerged; proc.py hardening landed via its own PR.

## Out of scope

- Auto-dispatch on merge (goal loop #1144 integration).
- Preview-deploy provisioning (getting a per-PR URL to test is the operator's/platform's concern; QA reports `not_verifiable` honestly when absent).
- Onboarder subagent (#1149).
