# Milestone 018: Tree-sitter Parsing Engine

## Source PRD

GitHub issue #577: https://github.com/Bensigo/agentrail/issues/577

## Required Context

- `CONTEXT.md`: Local Indexer owns source extraction; Source Custody Policy (denied sources must never appear in symbol output); Index Snapshot must record parser provenance (`ingestionHealth.parserVersions`); schemaVersion stays at 1 for this milestone — symbol table and call graph are Milestone B.
- `TASTE.md`: No console UI surface — all verification is CLI/JSON + benchmark tables. Evidence over claims: per-language fixture assertions and a build-time benchmark replace subjective claims.

## Outcome

`agentrail context index` extracts function/class/method/type/const symbols from Python, JS/TS, Go, Rust, Java, Kotlin, Ruby, PHP, C, C++, and Bash files using tree-sitter AST parsing instead of the current regex path in `index.py:533–571`. Unsupported languages and parse errors fall back to the existing regex path, marked `parsedBy: "regex_fallback"`. Symbol-aware chunking continues to work because the output schema is unchanged. Grammar version and hashes are recorded in the index snapshot.

## Users

- Coding agent (benefits from accurate cross-language symbol extraction under hard-mode enforcement)
- Developer adding a new language (one-line change in the language table)

## Vertical Scope

This milestone may touch:

- API/routes: none
- Domain logic: `index.py:533–571` (`extracted_symbols`), `symbol_aware_code_chunks`, `language_for`, incremental reuse (`index.py:1226–1252`), index snapshot writer
- Data/storage: `index.json` schema — add `ingestionHealth.parserVersions`; no schemaVersion bump yet (symbol table and call graph land in Milestone B)
- Integrations/jobs: `py-tree-sitter` + `tree-sitter-language-pack` added to `pyproject.toml` (pinned minor version)
- Tests: per-language fixture files + pytest assertions; build-time benchmark fixture
- Docs/config: language table in one place; `parsedBy` field documented in index schema notes

## Acceptance Criteria

- [ ] `extracted_symbols(path, source)` returns the same `{name, kind, line, citation, deterministic}` schema for all callers; no caller changes required
- [ ] Python, JS, TS/TSX, Go, Rust, Java, Kotlin, Ruby, PHP, C, C++, Bash fixtures each assert extracted symbol list matches expected (name, kind, line)
- [ ] Parse error or unsupported language produces regex fallback output with `parsedBy: "regex_fallback"` field; no exception propagates
- [ ] Adding a new language requires a change to exactly one language table entry
- [ ] `symbol_aware_code_chunks` output is unchanged on Python and TS fixture files after the swap
- [ ] `ingestionHealth.parserVersions` is present in the index snapshot with grammar name and version
- [ ] Incremental reuse (`mtime`+hash) still skips unchanged files after tree-sitter is added
- [ ] Index build time on this repo (`bensigo-ai-workflow`) is within 2× of the pre-tree-sitter baseline, measured by the existing `tests/context/test_benchmark.py` fixture
- [ ] Existing `agentrail context evaluate` retrieval quality gate fixture suite stays green (required-source inclusion 100%, stale/denied leakage 0)

## Test Plan

- `pytest tests/context/test_symbol_definition.py` — existing symbol ranking fixtures must stay green
- `pytest tests/context/test_context_modules.py` — index + retrieval roundtrip
- `pytest tests/context/test_incremental_index.py` — mtime reuse
- `pytest tests/context/test_benchmark.py` — build-time benchmark; PR body must include printed results table
- New: `pytest tests/context/test_tree_sitter_symbols.py` — per-language fixture assertions (one fixture file per language); fallback assertion on `.xyz` extension
- New: `pytest tests/context/test_chunking_compat.py` — chunking output identity before/after swap on Python + TS fixtures

## Likely Issue Slices

- Add `py-tree-sitter` + `tree-sitter-language-pack` to `pyproject.toml`; build language table mapping extensions → grammar names
- Replace `extracted_symbols` (index.py:533–571) with tree-sitter backend; keep regex fallback; add `parsedBy` field
- Add `language_for` helper and language table (one-entry-per-language, one-line extension)
- Write per-language fixture files + `test_tree_sitter_symbols.py` assertions for all 12 languages
- Record `ingestionHealth.parserVersions` in index snapshot writer
- Verify incremental reuse and `symbol_aware_code_chunks` compatibility; update `test_benchmark.py` with baseline comparison

## Blocked By

None.

## Notes

- `tree-sitter-language-pack` provides pre-built grammar wheels; no build-from-source step. Pin the minor version in `pyproject.toml` and record the pinned version in the index snapshot.
- Regex fallback must remain the correctness path for any language not in the table; tree-sitter is an improvement, not a hard dependency.
- schemaVersion bump (1 → 2) is deferred to Milestone B when symbol table + call graph are added.
