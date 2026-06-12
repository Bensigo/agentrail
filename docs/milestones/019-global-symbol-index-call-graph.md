# Milestone 019: Global Symbol Index and Call Graph Queries

## Source PRD

GitHub issue #577: https://github.com/Bensigo/agentrail/issues/577

## Required Context

- `CONTEXT.md`: Code Graph is a deterministic relationship model; Graph Enrichment is lower authority than deterministic evidence; denied sources must never appear in symbol table or call-graph outputs (Source Custody Policy); Context Compiler uses the Code Graph for retrieval; MCP tools shell-out to CLI `--json` per existing pattern in `packages/mcp`; house result schema (`path, lineStart, lineEnd, content, citation, reason, score, tokenEstimate, deterministic`) must be followed.
- `TASTE.md`: Evidence over claims — call-chain fixtures with cross-file resolution replace subjective quality claims. Monospace for machine data applies to CLI JSON output.

## Outcome

`agentrail context def NAME`, `callers NAME`, `callees NAME`, and `impact NAME [--depth N]` are working CLI commands backed by a global symbol table and function-level call graph stored in `index.json`. MCP tools `context_def`, `context_callers`, `context_callees`, `context_impact` expose the same queries to any MCP client. Coding agents under hard mode can navigate cross-file definitions and assess blast radius without grep. Denied sources never appear in results. Index schemaVersion bumps to 2 with graceful migration.

## Users

- Coding agent under hard-mode enforcement (definition lookup, impact assessment)
- MCP client (structural retrieval without running CLI directly)
- Operator (auditable unresolved call edges with recorded reasons)

## Vertical Scope

This milestone may touch:

- API/routes: none
- Domain logic: `index.py` graph builder (new `calls` edge kind; call expression extraction from AST; import resolution against `extracted_imports`; `unresolved_import`-style recording); new symbol table builder; schemaVersion 1 → 2 migration; `retrieval.py:300` anchor resolution (symbol table O(1) lookup before graph scan); `exact_graph` BFS seeded from call-graph neighbors when query contains relational keywords
- Data/storage: `index.json` — new `symbolTable` top-level dict + new `calls` edge kind in graph edges; `schemaVersion: 2`; migration that treats missing structures as empty (no full cold re-index of unchanged files)
- Integrations/jobs: `packages/mcp/src/index.ts` — add `context_def`, `context_callers`, `context_callees`, `context_impact` tools following existing shell-out pattern
- Tests: call-chain fixture repos (Python + TS cross-file); MCP subprocess roundtrip tests; CLI output schema assertions; unresolved edge reason assertions
- Docs/config: none required

## Acceptance Criteria

- [ ] `agentrail context def NAME [--target DIR] [--json]` returns house-schema items from the global symbol table; multi-definition (overloads, same-name-different-file) returns all matches
- [ ] `agentrail context callers NAME [--target DIR] [--json]` returns inbound call-graph edges in house schema with `callerPath` and `callerLine`
- [ ] `agentrail context callees NAME [--target DIR] [--json]` returns outbound call-graph edges from NAME's symbol nodes in house schema
- [ ] `agentrail context impact NAME [--depth N] [--target DIR] [--json]` returns transitive callers (BFS to depth N, default 3) + tests linked via `tests_source` edges + files with `imports_file` edges to affected paths
- [ ] Denied sources (authority: "denied") never appear in any of the four commands' output
- [ ] Unresolved call edges are recorded with reason (`no_import`, `dynamic_call`, `external_module`) — not silently dropped
- [ ] `index.json` schemaVersion is 2; loading a schemaVersion 1 index treats `symbolTable` and `calls` edges as empty and proceeds without error
- [ ] `packages/mcp/src/index.ts` exposes `context_def`, `context_callers`, `context_callees`, `context_impact` MCP tools; MCP subprocess roundtrip test passes
- [ ] `retrieval.py:300` anchor resolution uses symbol table O(1) lookup before falling back to graph node scan
- [ ] Existing `agentrail context evaluate` retrieval quality gate fixture suite stays green
- [ ] `tests/context/test_symbol_definition.py`, `test_context_modules.py`, `test_incremental_index.py` stay green

## Test Plan

- `pytest tests/context/test_symbol_definition.py` — existing symbol ranking fixtures
- `pytest tests/context/test_context_modules.py` — index + retrieval roundtrip
- `pytest tests/context/test_incremental_index.py` — mtime reuse
- New: `pytest tests/context/test_call_graph.py` — cross-file Python + TS fixture repo; assert callers/callees schema; assert unresolved edge reasons; assert denied source exclusion
- New: `pytest tests/context/test_global_symbol_table.py` — same-named functions in multiple files; def lookup returns all matches; schema validated
- New: `pytest tests/context/test_mcp_structural.py` — subprocess roundtrip for `context_def` and `context_impact` MCP tools
- New: `pytest tests/context/test_schema_migration.py` — load schemaVersion 1 fixture index; assert no error and empty symbol table/call edges

## Likely Issue Slices

- Design and implement `symbolTable` structure in `index.json`; add schemaVersion 2 migration (index.py graph builder)
- Implement call expression extraction from AST (per-function body); import resolution against `extracted_imports`; record `calls` edges with unresolved reason when applicable
- Implement `agentrail context def` CLI command with house-schema output and source custody filtering
- Implement `agentrail context callers` and `context callees` CLI commands
- Implement `agentrail context impact` with BFS transitive traversal + test/import expansion
- Update `retrieval.py:300` anchor resolution to use symbol table O(1) lookup
- Update `exact_graph` BFS to seed from call-graph neighbors on relational queries
- Add `context_def`, `context_callers`, `context_callees`, `context_impact` to `packages/mcp/src/index.ts`
- Write `test_call_graph.py`, `test_global_symbol_table.py`, `test_mcp_structural.py`, `test_schema_migration.py`

## Blocked By

Milestone 018 (tree-sitter parsing engine — call expression extraction requires AST access).

## Notes

- Call graph is best-effort for dynamic dispatch, reflection, and higher-order functions; these must be recorded with reason, not omitted.
- The global symbol table is name-keyed and multi-definition aware; `def` must return all matches, not just the first.
- `exact_graph` BFS change is additive — existing `declares_symbol`/`imports_file`/`tests_source` traversal is untouched; call-graph neighbors are added as additional seeds.
- MCP tools follow the shell-out-to-CLI pattern already established in `packages/mcp/src/index.ts`; no new transport or protocol.
