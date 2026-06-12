# Milestone 020: Warm Daemon and Fast Query Path

## Source PRD

GitHub issue #577: https://github.com/Bensigo/agentrail/issues/577

## Required Context

- `CONTEXT.md`: Run Events are append-only; `agentrail status` and `agentrail doctor` are existing operational health surfaces; daemon is an accelerator — correctness is never daemon-dependent; AFK runs multiple worktrees that must not corrupt each other's state (see memory: AFK mutates main working tree, AFK worktree base is origin).
- `TASTE.md`: Evidence over claims — latency benchmarks are executable pytest fixtures that print a results table for inclusion in PR bodies. No vanity metrics: every number in `agentrail status` daemon output must be actionable (PID, uptime, last-index timestamp, socket path).

## Outcome

`agentrail context daemon start|stop|status` manages a persistent local process that holds the parsed index, BM25 postings, symbol table, and call edges in memory. CLI commands transparently use the daemon socket when available and fall back to the cold path without error when absent. Cold query latency is under 1.5 s; warm query latency is under 150 ms — both asserted by benchmark fixtures with hard numbers in the PR body. AFK worktrees each get their own daemon keyed by resolved target path. `agentrail status` and `agentrail doctor` show daemon health.

## Users

- Coding agent running 50+ queries per session (warm latency benefit)
- Developer running AFK with multiple worktrees (per-target daemon isolation)
- Operator diagnosing cold-vs-warm performance issues (`agentrail status` / `agentrail doctor`)

## Vertical Scope

This milestone may touch:

- Domain logic: daemon process (`agentrail/context/daemon.py`) — Unix socket server, JSON-RPC-ish protocol, in-memory index, mtime staleness check + background re-index; CLI transparent detection (`_resolve_context_client`); auto-spawn config flag (`context.daemonAutoSpawn`); socket path keyed by resolved target path hash; precomputed BM25 postings written to `postings.json` at `agentrail context index` time; cold path loads `postings.json` instead of re-tokenizing corpus
- Data/storage: new `postings.json` alongside `index.json`; no schema changes to `index.json`
- Integrations/jobs: none
- Tests: daemon lifecycle (start/stop/status); auto-invalidation on mtime bump; cold latency < 1.5 s benchmark; warm latency < 150 ms benchmark; AFK concurrency (two targets, separate sockets); fallback when daemon absent
- Docs/config: `context.daemonAutoSpawn` config flag documented; `agentrail status` and `agentrail doctor` output updated

## Acceptance Criteria

- [ ] `agentrail context daemon start [--target DIR]` spawns daemon; `stop` terminates it; `status` returns PID, uptime, last-index timestamp, socket path in JSON
- [ ] All existing `agentrail context query/search/def/callers/callees/impact` commands transparently use daemon socket when available; no code change required by callers
- [ ] When daemon socket is absent or returns an error, CLI falls back to cold path; no exception propagates to the user
- [ ] Warm query latency < 150 ms asserted by pytest benchmark fixture on this repo; result table printed and included in PR body
- [ ] Cold query latency < 1.5 s asserted by pytest benchmark fixture on this repo; result table printed and included in PR body
- [ ] Daemon detects index staleness (mtime fingerprint per `index.py:1019–1044`); triggers background full re-index; serves previous index until re-index completes; never blocks a request
- [ ] Two worktrees with different `--target` paths get separate daemon sockets; assert no socket collision
- [ ] `agentrail status` and `agentrail doctor` show daemon running/stopped/stale for each active target
- [ ] `context.daemonAutoSpawn: true` (default false) causes first cold CLI query to spawn daemon in background
- [ ] BM25 postings written to `postings.json` at index time; cold path loads postings file; verified by `test_benchmark.py` cold latency fixture
- [ ] Existing `agentrail context evaluate` retrieval quality gate fixture suite stays green
- [ ] All prior test suites (`test_symbol_definition`, `test_context_modules`, `test_incremental_index`, `test_call_graph`, `test_global_symbol_table`) stay green

## Test Plan

- `pytest tests/context/test_benchmark.py` — extended with cold (< 1.5 s) and warm (< 150 ms) assertions; PR body must include printed results table
- New: `pytest tests/context/test_daemon_lifecycle.py` — start/stop/status; JSON output schema; PID/socket path fields
- New: `pytest tests/context/test_daemon_staleness.py` — mtime bump on fixture file triggers re-index; daemon serves old results during re-index; new results appear after re-index completes
- New: `pytest tests/context/test_daemon_concurrency.py` — two target directories; assert separate socket paths; assert no state corruption
- New: `pytest tests/context/test_daemon_fallback.py` — remove socket; assert CLI completes cold-path query without error

## Likely Issue Slices

- Implement `postings.json` precomputed BM25 postings at `agentrail context index` time; update cold path to load postings file
- Implement daemon process: Unix socket server, JSON-RPC-ish protocol, in-memory index load, mtime staleness check, background re-index
- Implement `_resolve_context_client` transparent daemon detection in CLI; fallback to cold path on socket absence or error
- Implement `agentrail context daemon start|stop|status` subcommands
- Key socket path by resolved target path hash; verify AFK worktree isolation
- Add `context.daemonAutoSpawn` config flag and auto-spawn on first cold query
- Update `agentrail status` and `agentrail doctor` with daemon health output
- Write `test_daemon_lifecycle.py`, `test_daemon_staleness.py`, `test_daemon_concurrency.py`, `test_daemon_fallback.py`
- Extend `test_benchmark.py` with cold < 1.5 s and warm < 150 ms hard-number assertions

## Blocked By

Milestone 019 (global symbol table and call graph must be in-memory structures the daemon holds).

## Notes

- The daemon is an accelerator, never a correctness dependency. Every command must work without it.
- Socket path encoding: `hash(os.path.realpath(target_dir))` ensures per-target isolation for AFK worktrees.
- Eventual consistency on staleness is intentional: blocking a request to re-index would defeat the purpose of the daemon.
- `postings.json` is a build-time artifact; it does not change the `index.json` schema or version.
