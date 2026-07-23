# Hosted fleet — operations runbook (issue #1267 PR⑤)

Day-2 operations for `agentrail fleet` once it's deployed. Setup (Railway
config, dashboard steps, env vars) lives in [README.md](./README.md) — this
file assumes that's already done and covers what to do once it's running.

Every number/behavior below is cited against the merged code it comes from
(HTML comments, `file:line`) — re-verify there if this drifts.

## Kill switch — three levels, know which one before an incident

1. **Stop the Railway service. This is the primary kill switch: instant and
   safe.** Scale to 0 / stop the deployment. Claims stop immediately. Any run
   that was mid-execution dies with the container — it does not just vanish:
   the next claim attempt against that workspace (fleet or a self-hosted
   runner, whichever polls first) sweeps it back to `queued`/`failed` via
   `reconcileStaleRuns`, reconciled on every claim automatically<!-- packages/db-postgres/src/queries/runner.ts (claimQueueEntry calls reconcileStaleRuns before claiming) -->.
   How fast it reappears depends on whether the dead run was reporting
   execution **liveness** (#1388):

   - **Fleet runs (report liveness ~every 60s while executing):** reclaimed
     once no liveness ping has arrived for `LIVENESS_STALENESS_SECONDS` =
     **5 minutes**<!-- packages/db-postgres/src/queries/runner.ts LIVENESS_STALENESS_SECONDS; single-sourced from agentrail/runner/liveness_config.json -->.
     A container stop that kills the fleet mid-run therefore self-heals in
     ~5 minutes, not 90. A healthy long run is untouched as long as its pings
     keep arriving, however long it runs.
   - **Non-pinging runs (a self-hosted runner, or an older fleet build):**
     fall back to the wall-clock sweep on `started_at`/`updated_at` past
     `STALE_RUN_MINUTES` = **90 minutes**<!-- packages/db-postgres/src/queries/runner.ts STALE_RUN_MINUTES -->.
     Expect up to a 90-minute gap for these before the interrupted run
     reappears as requeued rather than "stuck running."

   These windows are single-sourced and their orderings are enforced by
   construction (see `agentrail/runner/liveness.py`): the 5-minute liveness
   window sits above the 60s ping interval (a few missed pings never falsely
   reap a live run), and the 90-minute wall-clock fallback sits above the 1h
   subprocess execution ceiling (a legitimately long non-pinging run is never
   reaped mid-flight).

2. **Unsetting `FLEET_CONSOLE_TOKEN` does NOT stop claims.** Get this wrong
   during an incident and you'll believe you've killed the fleet when you
   haven't. It only 404s the *next sync* call<!-- apps/console/app/api/v1/fleet/workspace-tokens/sync/route.ts:125-127 -->.
   The fleet process keeps every per-workspace token it already holds on disk
   and keeps claiming/executing with them — a periodic re-sync failure is
   logged as a warning only, never fatal, and never stops the claim
   loop<!-- agentrail/runner/fleet_sync.py:159-174; agentrail/cli/commands/fleet.py:51-55,139-146 -->.
   This lever freezes future provisioning. It is not a stop.

3. **Per-workspace stop.** Flip that workspace's `hosted_execution` to
   `false`. The *next* sync revokes its `kind: 'fleet'` key<!-- apps/console/app/api/v1/fleet/workspace-tokens/sync/route.ts:164-178 -->;
   its next `claim_next()` then 401s → `RunnerAuthError` → the daemon drops
   ONLY that workspace from rotation, loudly, and keeps serving everyone
   else<!-- agentrail/runner/fleet_worker.py:273-280,213-229 -->. Latency: up
   to `FLEET_SYNC_INTERVAL_SECONDS` (default 300s, floor
   30s)<!-- agentrail/cli/commands/fleet.py:33-37,80-86,215-217 -->. For an
   instant single-workspace cut, revoke that workspace's fleet `api_keys` row
   directly instead of waiting on a sync. Bulk stop = flip every workspace +
   wait one sync interval, or revoke every fleet key directly.

Also know, so you don't act needlessly: **a workspace's own live self-hosted
runner always outranks the fleet for that workspace's queue.** The fleet
backs off with a plain 204 whenever a non-revoked self-hosted key was used in
the last hour<!-- apps/console/app/api/v1/runner/claim/route.ts:51-64,89 -->.
If a customer is running their own runner, the fleet is already not touching
that workspace — you don't need to intervene there.

## Scale

- The knob is `FLEET_CONCURRENCY` (default 2) — concurrent claims across the
  WHOLE fleet, not per workspace<!-- agentrail/cli/commands/fleet.py:30-32,214 -->.
- Never `numReplicas`. The on-disk token store is last-writer-wins with no
  cross-replica coordination; see the README's own 1-replica constraint. Scale
  up via `FLEET_CONCURRENCY`, not out.
- Idle cadence: the fleet doesn't sleep per empty claim, it sweeps the whole
  rotation and sleeps once per **fully-empty pass** (every workspace polled
  empty in a row), default 10s<!-- agentrail/runner/fleet_worker.py:77-91,256-265; agentrail/cli/commands/fleet.py:78 -->.
  A busy fleet never idles mid-sweep; per-workspace poll latency when idle is
  roughly one sweep plus that 10s, regardless of how many workspaces the
  fleet serves.

## Restart

Safe by construction — a crash, redeploy, or manual bounce is a non-event:

- Claims use `FOR UPDATE SKIP LOCKED`<!-- packages/db-postgres/src/queries/runner.ts:463 -->:
  an old instance finishing shutdown and a new one starting can never
  double-claim the same row.
- The stale-run reconcile sweep (Kill switch #1) runs on every claim, so
  anything the old process left `running` self-heals — within ~5 minutes for a
  fleet run that was reporting execution liveness, or within 90 minutes for a
  non-pinging run (see Kill switch #1 for the split).
- The token store is a file on the mounted volume, written atomically (temp
  file + `os.replace`, `0600`)<!-- agentrail/runner/fleet_credentials.py:108-142 -->,
  so a restart reads back exactly what the last sync wrote — no
  re-provisioning storm.

Expect on boot: `Fleet active — N workspace(s) @ <base_url>. C concurrent
slot(s), re-sync every Ss.`<!-- agentrail/cli/commands/fleet.py:234-238 --> A
boot sync failure (bad/missing `FLEET_CONSOLE_TOKEN`, console unreachable) is
fatal by design — the process exits rather than start not knowing who to
serve<!-- agentrail/cli/commands/fleet.py:219-232 -->. If the boot sync
succeeds but reports drift or per-workspace failures, their warnings print
right after that "Fleet active" line — see Logs below.

## Logs — what to grep, what it means

| Grep for | Means | Do |
|---|---|---|
| `the console reports an active fleet key for workspace(s)` | Sync drift: console thinks a workspace has a valid fleet token, this instance holds none (lost, or minted for a different instance)<!-- agentrail/runner/fleet_sync.py:182-190 --> | Revoke that workspace's fleet key in the console; the next sync mints a fresh one this instance receives |
| `sync reported per-workspace failures` | A mint or revoke failed for specific workspace(s) (`mint_failed` / `revoke_failed`)<!-- agentrail/runner/fleet_sync.py:191-212 --> | Not urgent — retried automatically next sync cycle. Check the console service's own logs if the SAME workspace keeps failing |
| `dropped from rotation: its fleet token was rejected` | One workspace's token was rejected (401) — usually because it was revoked/disabled on purpose<!-- agentrail/runner/fleet_worker.py:213-229 --> | If this workspace should still be served, revoke the (now-dead) key in the console — the next sync mints a fresh one and it rejoins automatically |
| `claims paused (workspace-budget)` | This workspace hit its monthly `$` ceiling — empty claims here are on purpose, not an outage<!-- agentrail/runner/fleet_worker.py:298-303; agentrail/runner/client.py:67-68 --> | Check the workspace's Budget page (`/dashboard/<workspaceId>/budget`) |
| `hosted-refusal:` (inside a run's `gate_reason`/`park_reason`) | A run refused at startup — a static config gap (e.g. no Independent Reviewer configured, #1270), not a transient failure. Jumps straight to `escalated-to-human`, spends no retry budget<!-- agentrail/sandbox/native_runner.py:64-71,128-141; packages/db-postgres/src/queries/runner.ts:538-548,598-601 --> | Read the text after the prefix — it names the fix. Look at the run/queue record, not the fleet process |

## Incident playbooks

**Runaway spend.** Two independent `$` guardrails, different layers — know
which one you're looking at:
- *Workspace monthly ceiling* — checked at claim time, before a run even
  starts<!-- apps/console/app/api/v1/runner/claim/route.ts:93-131 -->. Once
  this month's spend crosses it, that workspace's claims return empty with
  `claims paused (workspace-budget)` in the fleet log (see Logs above). Look
  at the workspace's Budget page for spend vs. ceiling.
- *Per-issue $3 check-in* — a different, per-run backstop that only fires
  when a run had no cost estimate at all
  (`DEFAULT_PER_ISSUE_BUDGET_USD = 3.0`)<!-- agentrail/run/budget_leash.py:38-71 -->,
  applied inside `agentrail run issue` itself regardless of whether a
  self-hosted runner or the fleet claimed the work. It's a resumable
  check-in, not a hard kill: it stops that one run mid-phase and says so
  (`failure_type: budget_exceeded`, message carries resume
  guidance)<!-- agentrail/run/pipeline.py:745-773 -->.
- The ceiling is the wide gate that actually caps monthly damage; the $3
  check-in is a narrow per-run tripwire for un-estimated work and will not by
  itself stop a workspace from running up real spend across many small runs.
  If spend looks wrong, check the ceiling first.

**A workspace's runs are all refusing.** Grep for `hosted-refusal:` (see Logs
above). This is always a static config gap on that repo/workspace (missing
Independent Reviewer config is the current one, #1270) — no retry or
fleet-side action fixes it. The refusal message itself names the gap; fix the
config, not the fleet.

**Token-store volume lost** (wiped volume, wrong mount, fresh disk). Every
hosted workspace looks like drift on the next sync (`the console reports an
active fleet key ... but this instance holds no token`) — each one still has
its key server-side, this instance's copy is just gone. Recovery: revoke
every workspace's fleet key in the console, then let the next sync re-mint
all of them clean. There is no per-token recovery — the raw token is only
ever handed over once, at
mint<!-- apps/console/app/api/v1/fleet/workspace-tokens/sync/route.ts:44-50 -->.

## Isolation

See the README's own [Isolation](./README.md#isolation) section for the full,
unsoftened breakdown — not repeated in full here on purpose. One line,
deliberately not softened: the bare Railway shape shares one container's
process/filesystem/kernel across every concurrently-running task
(disposable-directory hygiene, not a security boundary); the VM+socket shape
(`AGENTRAIL_SANDBOX=docker`) gives genuine per-task containers and is
recommended for multi-tenant production, but isn't fully hardened until the
#1295 work lands on top of it.
