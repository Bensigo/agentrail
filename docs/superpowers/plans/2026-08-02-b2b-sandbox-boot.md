# B2b Sandbox Boot — the boot plane (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. The coordinator dispatches one fresh Sonnet subagent per task and adversarially reviews each before the next.

**Goal:** Give a no-preview-URL PR head something to browse — a dedicated, flag-gated *boot plane* that clones a PR head on the fleet side, boots it as a supervised child process, health-checks it, exposes a private URL, and tears it down. Provable in isolation via a standalone boot smoke. The reviewer wiring (`request_preview_boot` tool + rung 2) is a **separate follow-up plan** that consumes this.

**Architecture:** A dedicated `preview_boots` queue (NOT the generic `queue_entries` — that hardcodes `ref='main'`, is terminal-only, and auto-squash-merges the PR on `green`). Four console routes on `/api/v1/runner/preview-boots` (all `requireJaceConsoleSecret`): request + poll (Jace-facing) and claim + report (worker-facing). A dedicated **out-of-process Python preview worker** claims a boot, clones the PR head, detects a run recipe, boots a supervised child under the fleet's existing public-safe env allowlist, health-checks a TCP port, reports `ready{url}`, supervises to a TTL, then unconditionally tears down. Reuses real primitives only: `authenticated_clone_url` (clone), `build_native_child_env` (env allowlist), `os.killpg` (group teardown), the `context/daemon.py` deadline+interval poll shape (health-check). Touches **no** existing runner/fleet code path — it is a parallel, isolated plane.

**Tech Stack:** Drizzle hand-authored migration + `packages/db-postgres` queries (real Postgres tests); Next.js routes + vitest; Python `agentrail/sandbox` + `agentrail/runner` (`subprocess`, `socket`, `urllib`, stdlib only) with `pytest`.

**Spec:** `docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md` §B2b (§4–§5), as corrected by the topology ruling below (the spec's "ride the WorkItem.kind queue" text is superseded — see Global Constraints).

## Global Constraints

- **Base:** worktree branch `feat/b2b-sandbox-boot` off `origin/main` (B2a merged, `eba77a23`). Work happens in `.claude/worktrees/b2b-sandbox-boot/`.
- **Topology ruling (supersedes spec §5's "work-item kind" text):** preview boots do NOT ride `queue_entries` / `/api/v1/runner/claim` / `/result`, and do NOT touch `WorkItem.kind`, `_make_execute` (`agentrail/cli/commands/runner.py`), or any existing runner loop. Reasons, all verified in code: `claimQueueEntry` hardcodes `ref='main'` (`packages/db-postgres/src/queries/runner.ts` ~772) so it cannot carry a PR head; `/result` status vocab is terminal-only (`green|red|error|running`); the `green` path attempts a PR squash-merge. The boot plane is fully dedicated and isolated.
- **Repo hook blocks Grep/Glob and bare `grep`** — Read exact paths; `git grep` (allowed) or `python3` heredocs for searches.
- **`apps/jace`** is NOT in this plan (reviewer wiring is the follow-up). No `apps/jace` edits here.
- **Console tests** via its package script; **db-postgres integration tests** need `DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail`. **Python tests** via the repo's pytest (focused paths only).
- **Migration:** hand-authored SQL (drizzle-kit generate is broken here); next slot **`0068_preview_boots.sql`**, journal **idx 72** — RE-VERIFY live before writing (recompute max filename # and max journal idx independently; they differ; idempotent `CREATE TABLE IF NOT EXISTS` modeled on `0066_review_jobs.sql`; hand-append the `_journal.json` entry). Add the new schema+queries to BOTH barrels (`packages/db-postgres/src/schema/index.ts`, `.../queries/index.ts`).
- **Flags (default OFF):** `PREVIEW_BOOTS_ENABLED` (console; `!== "1"` → 503 on every route, checked immediately after auth) + `PREVIEW_BOOTS_WORKSPACES` (CSV enrollment allowlist; empty/unset ⇒ no workspace enabled — mirror `REVIEWER_OF_RECORD_WORKSPACES`/`enrolledWorkspaceIds()` in `webhooks/github-app/route.ts:66,105`). The worker is gated by `PREVIEW_WORKER_ENABLED` + its own console token.
- **Auth (all four routes):** `requireJaceConsoleSecret` (`apps/console/lib/jace-console-auth.ts:76`), imported six `../` up from `app/api/v1/runner/preview-boots/<x>/route.ts` (same depth as `review-jobs`). The worker authenticates as a house process with `JACE_CONSOLE_TOKEN` as its bearer — same trust class as the Jace review worker. Auth is checked BEFORE the flag gate so an unauthenticated caller never learns the feature state.
- **Session→workspace** (request/poll routes only): copy the token-less `resolveWorkspaceId(eveSessionId)` twin from `apps/console/app/api/v1/runner/review-evidence/route.ts:111-139` (`getJaceSessionByEveSessionId` → `workspaceId` off the session; identity-less sessions supported since #1569; `null` → 404 `{error:"Session not found"}`; no workspace → 409). Claim/report routes are worker-facing and key off the boot id + `workerId`, NOT a session.
- **Security invariant (the load-bearing one):** the boot child's env is built ONLY through `build_native_child_env` (`agentrail/sandbox/native_runner.py:1161`) — never workspace secrets, never any console token, never `FLEET_CONSOLE_TOKEN`/`DATABASE_URL`/`AUTH_SECRET`. The child is untrusted repo code. A test MUST assert no disallowed key reaches the child env.
- **Reachability:** the child binds `0.0.0.0:<port>`; the worker health-checks `127.0.0.1:<port>`; the URL advertised to Jace is `http://<PREVIEW_ADVERTISE_HOST>:<port>` (`PREVIEW_ADVERTISE_HOST` default `127.0.0.1` for dev; the `*.railway.internal` host in prod). Nothing is ever bound to a public interface.
- **Naming collision note:** `apps/console/lib/evidence/` (observability) is unrelated; this plane is `preview_boots`. No new file should imply otherwise.
- Commit after each task. Never commit `apps/jace/pnpm-lock.yaml` (N/A here, but the hook still watches).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/db-postgres/drizzle/migrations/0068_preview_boots.sql` + `meta/_journal.json` | the table (hand-authored, idempotent) |
| `packages/db-postgres/src/schema/preview_boots.ts` (+ barrel) | Drizzle table + `PreviewBootRow` |
| `packages/db-postgres/src/queries/preview_boots.ts` (+ test, + barrel) | id/enqueue/claim/report/get/sweep |
| `apps/console/app/api/v1/runner/preview-boots/route.ts` (+ test) | POST request (Jace) |
| `apps/console/app/api/v1/runner/preview-boots/[id]/route.ts` (+ test) | GET poll (Jace) |
| `apps/console/app/api/v1/runner/preview-boots/claim/route.ts` (+ test) | POST claim (worker) — mints github_token |
| `apps/console/app/api/v1/runner/preview-boots/report/route.ts` (+ test) | POST report (worker) — booting/ready/failed/torn_down |
| `agentrail/sandbox/preview_recipe.py` (+ test) | pure recipe detection |
| `agentrail/sandbox/preview_boot.py` (+ test) | clone PR head → boot child → health-check → teardown |
| `agentrail/runner/preview_worker.py` (+ test) + CLI entry | claim loop + supervise + report |
| `deploy/…` docs + `.env` examples | flags, advertise host, private-network note |

---

### Task 1: `preview_boots` table + migration

**Files:** Create `packages/db-postgres/src/schema/preview_boots.ts`; modify `packages/db-postgres/src/schema/index.ts` (barrel); create `packages/db-postgres/drizzle/migrations/0068_preview_boots.sql`; modify `packages/db-postgres/drizzle/migrations/meta/_journal.json`.

**Model on** `packages/db-postgres/src/schema/review_jobs.ts` (same idioms: `uuid` PK with NO `defaultRandom` — caller-supplied deterministic id; `text` status column with a `.default`, NOT a pg enum; timestamptz `defaultNow`; partial index on the claimable state).

**Interfaces (produces):** `previewBoots` table + `export type PreviewBootRow = typeof previewBoots.$inferSelect;`

Columns (exact):
- `id uuid primaryKey` (deterministic uuid5, supplied by `previewBootId`)
- `workspaceId uuid notNull references(workspaces.id, onDelete cascade)`
- `repo text notNull`, `prNumber integer notNull`, `headSha text notNull`
- `ref text notNull` — the clone target (the head SHA, or `refs/pull/<n>/head`; the request route sets it)
- `status text notNull default 'pending'` — vocab `pending|claimed|booting|ready|failed|torn_down`
- `workerId text` (nullable, set at claim), `claimedAt timestamptz` (nullable)
- `url text` (nullable, set on `ready`), `port integer` (nullable, set on `ready`)
- `reason text` (nullable — failure/teardown reason)
- `attempts integer notNull default 0`
- `expiresAt timestamptz` (nullable — set at claim: `now() + ttl`)
- `lastLivenessAt timestamptz` (nullable — bumped by report)
- `nextEligibleAt timestamptz` (nullable — requeue backoff)
- `createdAt`/`updatedAt timestamptz notNull defaultNow`

Indexes: `preview_boots_pending_idx` partial `ON (created_at) WHERE status='pending'`; `preview_boots_pr_idx ON (workspace_id, repo, pr_number)`.

- [ ] **Step 1:** Write `preview_boots.ts` mirroring `review_jobs.ts` structure (copy its import + `pgTable` shape; adjust columns above). Export `PreviewBootRow`.
- [ ] **Step 2:** Add `export * from "./preview_boots.js";` to `schema/index.ts` (match the `review_jobs` line).
- [ ] **Step 3:** RE-VERIFY the slot: read `meta/_journal.json` max idx and the max `NNNN` among `migrations/*.sql`; confirm `0068`/idx `72` still free (recompute independently). Hand-write `0068_preview_boots.sql` — idempotent `CREATE TABLE IF NOT EXISTS preview_boots (...)` + `CREATE INDEX IF NOT EXISTS ...`, snake_case columns matching the Drizzle names, modeled byte-for-byte on `0066_review_jobs.sql`'s style.
- [ ] **Step 4:** Append the `_journal.json` entry `{ idx: 72, version: <same as neighbors>, when: <copy the style; a fixed integer — do NOT call Date.now>, tag: "0068_preview_boots", breakpoints: true }`.
- [ ] **Step 5:** Run migrations against local Postgres and a schema-agreement test (a query selecting every column round-trips) — `DATABASE_URL=... pnpm --filter @agentrail/db-postgres test`. Expected: green; the table exists with the exact columns.
- [ ] **Step 6:** Commit — `feat(db): preview_boots queue table — the boot plane's dedicated queue (B2b)`.

### Task 2: `preview_boots` queries

**Files:** Create `packages/db-postgres/src/queries/preview_boots.ts` + `preview_boots.test.ts`; modify `packages/db-postgres/src/queries/index.ts` (barrel).

**Model on** `packages/db-postgres/src/queries/review_jobs.ts` (uuid5 helper, `pg_advisory_xact_lock` enqueue with supersede, `SKIP LOCKED` claim, guarded `WHERE …=$ AND status=$ RETURNING *` transitions, `db.execute` raw-row `new Date()` mapping via a `mapRow` + `toDateOrNull`).

**Interfaces (produces):**
- `previewBootId(input:{workspaceId;repo;prNumber:number;headSha:string}): string` — `uuid5Url("preview-boot:<ws>:<repo>:<pr>:<headSha>")` (copy `uuid5Url` + `NAMESPACE_URL` from review_jobs).
- `enqueuePreviewBoot(input:{workspaceId;repo;prNumber;headSha;ref}): Promise<{id:string; deduped:boolean; superseded:number}>` — one `db.transaction`; first `SELECT pg_advisory_xact_lock(hashtext($lockKey))` with `lockKey="preview-boot:<ws>:<repo>:<pr>"`; `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id` (deduped = 0 rows); if deduped return early; else `UPDATE … SET status='torn_down', reason='superseded' WHERE ws/repo/pr match AND head_sha<>$ AND status IN ('pending','claimed','booting','ready') RETURNING id` (supersede older heads — a newer push obsoletes an in-flight boot). NOTE: superseding a live boot only marks the row; the worker's teardown is driven by its own supervise loop hitting the flipped status (Task 7 polls), so this is safe.
- `claimPreviewBoot(input:{workerId:string; ttlSeconds:number}): Promise<PreviewBootRow | null>` — pre-pass `expireStalePreviewBoots` (below), then atomic `UPDATE preview_boots SET status='claimed', worker_id=$, claimed_at=now(), expires_at=now()+($ttl||' seconds')::interval, last_liveness_at=now() WHERE id=(SELECT id FROM preview_boots WHERE status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=now()) ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
- `reportPreviewBoot(input:{id:string; workerId:string; status:"booting"|"ready"|"failed"|"torn_down"; url?:string|null; port?:number|null; reason?:string|null}): Promise<PreviewBootRow | null>` — guarded per target: `booting` requires current `status IN ('claimed','booting')`; `ready` requires `IN ('claimed','booting','ready')` (the `ready`→`ready` case is the idempotent liveness re-report during supervision — it bumps `last_liveness_at` without a bogus transition) and writes `url,port` on the first `ready`; `failed`/`torn_down` allowed from any non-terminal (`status NOT IN ('failed','torn_down')`), write `reason`. Every UPDATE also `WHERE worker_id=$workerId` (a worker can only report its own boot) and bumps `last_liveness_at=now()`, `updated_at=now()`. Returns the row or `null` (stale/foreign — no-op).
- `getPreviewBoot(id:string): Promise<PreviewBootRow | null>` — plain select by id.
- `expireStalePreviewBoots(): Promise<void>` — `UPDATE … SET status='failed', reason='stale' WHERE status IN ('claimed','booting','ready') AND last_liveness_at < now()-(<STALE_SECONDS> ||' seconds')::interval`; also `pending` older than N min with attempts exhausted → failed. (STALE_SECONDS const = 180.)

- [ ] **Step 1:** Write the failing test file: dedupe (same input → same id, `deduped:true` on 2nd enqueue), supersede (newer headSha marks the older row `torn_down/superseded`, returns `superseded:1`), claim (SKIP LOCKED hands the oldest `pending`, sets `claimed`+worker+expires), report transitions (booting→ready writes url/port; ready allowed only from claimed/booting; foreign `workerId` → null no-op; failed from any non-terminal), getPreviewBoot, expireStalePreviewBoots (stale liveness → failed). Run: `DATABASE_URL=... pnpm --filter @agentrail/db-postgres test preview_boots` → FAIL (module missing).
- [ ] **Step 2:** Implement `preview_boots.ts` (copy the review_jobs helpers verbatim where identical). Add both to `queries/index.ts`.
- [ ] **Step 3:** Run the suite → green. Commit — `feat(db): preview_boots queries — enqueue/claim/report/sweep (B2b)`.

### Task 3: console request + poll routes (Jace-facing)

**Files:** Create `apps/console/app/api/v1/runner/preview-boots/route.ts` (POST) + `[id]/route.ts` (GET), each with a colocated test.

**Behavior (each a mandatory test):**
- **POST** (Jace requests a boot): `requireJaceConsoleSecret` (401) → `PREVIEW_BOOTS_ENABLED!=="1"` → 503 `{error:"preview boots not enabled"}` → body `{eveSessionId, repo, prNumber, headSha}` all required (400) → `resolveWorkspaceId(eveSessionId)` (404 no session / 409 no workspace) → enrollment `previewBootsWorkspaces().has(workspaceId)` else 403 `{error:"workspace not enrolled"}` → `getRepositoryByName(workspaceId, repo)` gates the repo (404 not connected) → `ref = headSha` → `enqueuePreviewBoot({workspaceId, repo, prNumber, headSha, ref})` → 200 `{id, deduped}`.
- **GET** `[id]` (Jace polls): auth → flag → load `getPreviewBoot(id)` (404 if absent) → `resolveWorkspaceId(eveSessionId)` from `?eveSessionId=` (required) and assert `row.workspaceId === workspaceId` else 404 (cross-tenant hidden as not-found) → 200 `{status, url:row.url??null, reason:row.reason??null}`.

- [ ] Steps: TDD (write both route tests first, incl. identity-less session, enrollment 403, cross-tenant 404, flag 503, missing-field 400) → implement (mirror `review-evidence/route.ts` for the auth+flag+session skeleton; `enrolledWorkspaceIds` idiom for `previewBootsWorkspaces`) → console suite green → Commit — `feat(console): preview-boots request + poll routes (B2b)`.

### Task 4: console claim + report routes (worker-facing)

**Files:** Create `apps/console/app/api/v1/runner/preview-boots/claim/route.ts` (POST) + `report/route.ts` (POST), each with a test.

**Behavior:**
- **POST claim:** auth → flag → body `{workerId}` (400) → `claimPreviewBoot({workerId, ttlSeconds: previewTtlSeconds()})` → if `null` return **204** (nothing pending) → else mint `githubToken = (await getInstallationToken(row.workspaceId)) ?? ""` (`packages/db-postgres/src/queries/github-app-token.ts:79`) and derive `repoUrl` from `row.repo` (reuse the same `repoSlugToUrl` helper the generic claim uses — find it via `git grep -n "repoSlugToUrl" origin/main -- packages/db-postgres`) → 200 `{ id, workspaceId, repo, repoUrl, prNumber, headSha, ref, githubToken, ttlSeconds }`. `previewTtlSeconds()` = numeric-env idiom from `review-jobs/claim/route.ts:44` (`PREVIEW_BOOT_TTL_SECONDS`, default `720`).
- **POST report:** auth → flag → body `{id, workerId, status, url?, port?, reason?}` (`status` ∈ the 4 values, else 400) → `reportPreviewBoot(...)` → `null` → **409** `{error:"boot not found or not owned"}` → else 200 `{ok:true, status:row.status}`.

- [ ] Steps: TDD (claim returns full item incl. minted token + 204-when-empty; report guarded transitions incl. foreign-worker 409, terminal-idempotency) → implement → console suite green → Commit — `feat(console): preview-boots claim + report routes — worker surface (B2b)`.

### Task 5: recipe detector (python, pure)

**Files:** Create `agentrail/sandbox/preview_recipe.py` + `agentrail/sandbox/tests/test_preview_recipe.py` (match the repo's pytest layout — verify where sandbox tests live via `git grep -l "def test_" origin/main -- agentrail/sandbox`).

**Precedent:** `agentrail/runner/onboard.py:220 _detect_command_hints` (string-match on a text digest) — this detector instead reads REAL files and sits beside it, serving *commands*, not hints.

**Interface (produces):**
```python
@dataclass(frozen=True)
class PreviewRecipe:
    install: list[str] | None   # argv, e.g. ["npm","ci"]; None = skip install
    start: list[str]            # argv for the dev server
    port: int
    ready_path: str = "/"       # GET path that returns 2xx/3xx when up

def detect_recipe(repo_dir: str) -> PreviewRecipe | None: ...
```
Detection order: (1) explicit `.agentrail/config.json` flat key **`preview`** `{install, start, port, readyPath}` (string commands are shell-split via `shlex.split`; `start` required; `port` required) — the `jace.preview` nested name from the directional text is dead. (2) else `package.json`: a `scripts.dev` → `["npm","run","dev"]`, else `scripts.start` → `["npm","run","start"]`; install `["npm","ci"]` if `package-lock.json` present else `["npm","install"]`; port heuristic by dep: `next`→3000, `vite`→5173, `react-scripts`→3000, else 3000. (3) undetectable → `None`.

- [ ] Steps: TDD a matrix (explicit config wins; next/vite/CRA variants; install picks ci-vs-install by lockfile; missing start → None; malformed config.json → None, never raises) → implement (stdlib `json`, `shlex`, `os.path`) → `pytest agentrail/sandbox/tests/test_preview_recipe.py` green → Commit — `feat(sandbox): preview recipe detector — explicit config + package.json heuristics (B2b)`.

### Task 6: boot lifecycle (python)

**Files:** Create `agentrail/sandbox/preview_boot.py` + `agentrail/sandbox/tests/test_preview_boot.py`.

**Reuse (do not reinvent):** `authenticated_clone_url` (`agentrail/sandbox/clone_auth.py:16`) + `redact_token`; `build_native_child_env` (`agentrail/sandbox/native_runner.py:1161`) for the child env; `os.killpg`/`start_new_session=True` idiom (`agentrail/run/proc.py:28-115`); the deadline+interval poll shape (`agentrail/context/daemon.py:161 _wait_for_socket`) but over TCP.

**Interfaces (produces):**
```python
@dataclass
class BootHandle:
    proc: subprocess.Popen
    pgid: int
    port: int
    url: str            # http://<advertise_host>:<port>
    clone_dir: str

def clone_pr_head(repo_url: str, ref: str, dest: str, *, token: str, timeout: float = 120.0) -> None:
    # git clone --depth 1 <authed> dest ; git -C dest fetch --depth 1 origin <ref> ; git -C dest checkout FETCH_HEAD
    # (ref is a SHA or refs/pull/N/head — cannot use --branch; token-redacted errors via redact_token)

def pick_free_port() -> int:  # bind ('127.0.0.1',0), read port, close (v1 race-tolerant)

def health_check(port: int, ready_path: str, *, timeout: float, interval: float = 0.5) -> bool:
    # monotonic deadline loop: socket.create_connection(('127.0.0.1',port),1.0); then urllib GET ready_path expects <500; True on first success

def boot(recipe: PreviewRecipe, clone_dir: str, *, advertise_host: str, process_env: dict, timeout: float) -> BootHandle:
    # run recipe.install (subprocess.run, capped) in clone_dir with build_native_child_env(process_env, {}); 
    # port = recipe.port or pick_free_port(); child_env = build_native_child_env(process_env, {"PORT":str(port),"HOST":"0.0.0.0"});
    # Popen(recipe.start, cwd=clone_dir, env=child_env, start_new_session=True, stdout/stderr→pipe or file);
    # if not health_check(port, recipe.ready_path, timeout=...): teardown + raise BootError(tail_of_logs);
    # url = f"http://{advertise_host}:{port}"; return BootHandle(...)

def teardown(handle: BootHandle) -> None:
    # os.killpg(os.getpgid(handle.proc.pid), SIGKILL) guarded by hasattr+suppress(ProcessLookupError,PermissionError); shutil.rmtree(clone_dir, ignore_errors=True); idempotent
```
**Security test (mandatory):** boot a fixture with a `process_env` containing `DATABASE_URL`, `FLEET_CONSOLE_TOKEN`, `AUTH_SECRET` and assert NONE reach `handle.proc`'s env (inspect the built child_env) — `build_native_child_env` strips them.

- [ ] Steps: TDD against a **fixture "repo"** = a tiny script the test writes to a temp dir whose `start` is `["python3","-m","http.server","<port>"]` (a real bootable server) — assert: boot → `health_check` True → the port serves → `teardown` kills the group (pid gone) + removes the dir; health-fail case (a start command that never listens) → `BootError` + cleanup; the env-allowlist assertion above. `clone_pr_head` tested with an injected `runner`/subprocess fake (assert argv shape + token redaction), no network. → implement → `pytest agentrail/sandbox/tests/test_preview_boot.py` green → Commit — `feat(sandbox): preview boot lifecycle — clone/boot/health/teardown (B2b)`.

### Task 7: the preview worker (python) + entrypoint

**Files:** Create `agentrail/runner/preview_worker.py` + `agentrail/runner/tests/test_preview_worker.py`; add a CLI entry (mirror how `agentrail/scripts` or `agentrail/cli/commands` expose a worker — verify the pattern via `git grep -n "def main" origin/main -- agentrail/runner`; the Jace review worker precedent is out-of-process, so this is a standalone `python -m agentrail.runner.preview_worker`).

**Behavior:** a claim loop, seam-split for testability (inject `transport`, `sleep`, `now`, and the boot module):
- gate on `PREVIEW_WORKER_ENABLED == "1"`; config = console base (`AGENTRAIL_SERVER_BASE_URL`) + token (`JACE_CONSOLE_TOKEN`) + `PREVIEW_ADVERTISE_HOST`.
- loop: `POST /api/v1/runner/preview-boots/claim {workerId}`; 204 → sleep(idle=10s) → continue; 200 → a boot item.
- on a claim: `report booting` → `clone_pr_head` + `detect_recipe`; `None` recipe → `report failed{reason:"no recipe"}` + cleanup → continue; else `boot(...)` → on `BootError` → `report failed{reason}` + `teardown` → continue; on success → `report ready{url, port}`.
- **supervise** until TTL (`item.ttlSeconds`): every `LIVENESS_INTERVAL` (30s) re-`report ready` (idempotent — bumps `last_liveness_at` so the console stale-sweep never fails a healthy boot); early-release/claim-check is NOT needed in v1 (TTL-only; early-release is the follow-up). When `now() >= deadline`: `teardown` → `report torn_down` → continue.
- **crash-safety:** wrap the whole per-boot block in try/finally so `teardown` always runs; a worker/container death kills the child with its session (no cross-restart orphan); the console `expireStalePreviewBoots` sweep catches the abandoned row.

- [ ] Steps: TDD with an injected transport (scripted claim→204/200 sequences) + a fake boot module (returns a handle / raises BootError) + a fake clock: assert the exact report sequence for (a) happy path `booting→ready→torn_down`, (b) no-recipe `booting→failed`, (c) boot-error `booting→failed`, (d) TTL teardown fires at the deadline, (e) `finally` teardown on an unexpected exception. → implement → `pytest agentrail/runner/tests/test_preview_worker.py` green → Commit — `feat(runner): out-of-process preview worker — claim/boot/supervise/teardown (B2b)`.

### Task 8: reachability/config docs, sweeps, standalone boot smoke, PR

- [ ] **Step 1:** Env + docs: add `PREVIEW_BOOTS_ENABLED`, `PREVIEW_BOOTS_WORKSPACES`, `PREVIEW_BOOT_TTL_SECONDS`, `PREVIEW_WORKER_ENABLED`, `PREVIEW_ADVERTISE_HOST`, `JACE_CONSOLE_TOKEN` (worker side) to the relevant `.env.example`/`deploy/.env.production.example` with one-line comments; a short `deploy/` note: the preview worker is a new out-of-process service; the browser sidecars + worker share the Railway private network; the child binds `0.0.0.0`, advertised via `*.railway.internal`, never public.
- [ ] **Step 2:** Full suites: `DATABASE_URL=... pnpm --filter @agentrail/db-postgres test`; console suite; `pytest agentrail/sandbox/tests/test_preview_recipe.py agentrail/sandbox/tests/test_preview_boot.py agentrail/runner/tests/test_preview_worker.py`. All green.
- [ ] **Step 3 (coordinator-run live smoke):** with `PREVIEW_BOOTS_ENABLED=1` + a real console on :3001 + local Postgres, and a **fixture repo** (a tiny committed sample app whose recipe boots a real server): (a) mint a Jace session bound to an enrolled workspace; (b) `POST /preview-boots` → get `{id}`; (c) run `PREVIEW_WORKER_ENABLED=1 python -m agentrail.runner.preview_worker` → watch it claim → boot → `report ready`; (d) `GET /preview-boots/:id` returns `ready{url}`; (e) `curl` the url → 200 from the booted app (capture output as evidence); (f) confirm TTL teardown flips `torn_down` + the child process is gone + the clone dir removed. Record the smoke transcript.
- [ ] **Step 4:** Walk the AC checklist below → push → PR (coordinator runs the whole-branch adversarial final review before merge).

## Acceptance criteria (final walk)

1. Dedicated `preview_boots` queue exists; the boot plane touches NO `queue_entries`/`/result`/`WorkItem.kind`/`_make_execute` path (grep-proven).
2. All four routes: auth-before-flag, 503 when disabled, enrollment 403, session-resolved workspace (incl. identity-less) on Jace routes, cross-tenant hidden as 404, worker routes key off id+workerId; claim mints a fresh installation token and 204s when empty; report transitions are guarded + foreign-worker-safe.
3. Recipe detector: explicit flat `preview` config wins; package.json heuristics; undetectable → None; malformed config never raises.
4. Boot lifecycle: clones a PR head by SHA/ref (not `--branch`), boots a supervised child, TCP+path health-check with a real deadline loop, teardown kills the process GROUP + removes the dir idempotently; the child env is public-safe-allowlist-only (secret-leak test passes).
5. Worker: exact report sequence per outcome; TTL teardown; `finally` teardown on crash; out-of-process; gated by `PREVIEW_WORKER_ENABLED`.
6. All flags default off; every route degrades to 503 until `PREVIEW_BOOTS_ENABLED=1`; the worker no-ops until enabled.
7. Standalone live smoke: a real booted app served a real HTTP 200 over the plane end-to-end, then was torn down — transcript recorded.
8. Reviewer wiring is explicitly OUT of scope (follow-up plan) — nothing in `apps/jace` changed.
