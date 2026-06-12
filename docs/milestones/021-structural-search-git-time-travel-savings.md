# Milestone 021: Structural Search, Git Time-Travel, and Savings Proof

## Source PRD

GitHub issue #577: https://github.com/Bensigo/agentrail/issues/577

## Required Context

- `CONTEXT.md`: Hard-mode enforcement hooks live in `templates/scripts/context-first.sh` and `.agentrail/hooks/context-first.sh`; `templates/AGENTS.md` is the canonical Context Retrieval reference agents read; denied sources must never appear in AST search output; all output follows the house result schema; `agentrail context savings` reads from existing `runMetadata` accounting in `retrieval.py:173–210`.
- `TASTE.md`: Evidence over claims — `agentrail context benchmark FIXTURE --compare-grep` must print a publishable table with both cost columns for PR bodies. No vanity metrics: `savings` must return an actionable non-negative integer; drill-through to per-session breakdown when available.

## Outcome

Coding agents blocked by hard mode see denial messages that name `agentrail context def`, `callers`, `impact`, and `ast` as alternatives. `agentrail context ast "<pattern>"` finds structural patterns using tree-sitter s-expression queries. `agentrail context blame`, `history`, and `changed` answer git time-travel questions in house JSON. `agentrail context savings` proves the token-savings case to operators. The benchmark fixture gains a `--compare-grep` column. All commands are additive; no existing contract changes.

## Users

- Coding agent blocked by hard mode (redirected to correct commands by updated denial message)
- Coding agent (AST pattern search, git authorship, commit history, changed-file scoping)
- Operator (savings proof, benchmark comparison table for justifying context-first policy)
- Developer extending hard-mode hooks or adding languages

## Vertical Scope

This milestone may touch:

- Domain logic: `agentrail context ast` — tree-sitter s-expression query runner over indexed file parse trees (or cold re-parse); house-schema output with citation; `agentrail context blame` — `git blame --porcelain` wrapper for line range; `agentrail context history` — `git log --follow` (optionally `-L` for symbol); `agentrail context changed` — `git diff --name-status REF` (default HEAD vs working tree); `agentrail context savings` — reads `runMetadata` from `retrieval.py:173–210` + context pack telemetry; per-session breakdown when available; benchmark extension: `--compare-grep` column (grep-and-read cost vs context-engine cost)
- Data/storage: no schema changes
- Integrations/jobs: none
- Tests: `ast` s-expression fixture; `blame` known-fixture + commit assertion; `history` commit count assertion; `changed` file-change list assertion; `savings` non-negative integer assertion; benchmark `--compare-grep` column assertion
- Docs/config: `templates/AGENTS.md` Context Retrieval section updated to list `def/callers/impact/ast`; `templates/scripts/context-first.sh` + `.agentrail/hooks/context-first.sh` denial messages updated to mention `context def`, `context callers`, `context impact`, `context ast`

## Acceptance Criteria

- [ ] `agentrail context ast "<s-expression>" [--target DIR] [--json] [--limit N]` returns house-schema items (path, lineStart, lineEnd, citation) for all matching AST nodes across indexed files; denied sources excluded
- [ ] `agentrail context blame PATH --lines A-B [--target DIR] [--json]` returns per-line `{line, author, sha, date, content}` array
- [ ] `agentrail context history PATH [--symbol NAME] [--target DIR] [--json]` returns commit list; `--symbol` filters via `git log -L :<NAME>:PATH`
- [ ] `agentrail context changed [--since REF] [--target DIR] [--json]` returns file-change list with status (added/modified/deleted); default REF is HEAD vs working tree
- [ ] `agentrail context savings [--target DIR] [--json]` returns non-negative integer cumulative `tokensSaved` from `retrieval.py:173–210` runMetadata; per-session breakdown shown when available
- [ ] `agentrail context benchmark FIXTURE --compare-grep` prints a table with both grep-and-read cost and context-engine cost columns; output is machine-parseable JSON or Markdown table
- [ ] Hard-mode denial messages in `templates/scripts/context-first.sh` and `.agentrail/hooks/context-first.sh` explicitly mention `context def`, `context callers`, `context impact`, `context ast`
- [ ] `templates/AGENTS.md` Context Retrieval section lists all commands including `def`, `callers`, `impact`, `ast`, `blame`, `history`, `changed`, `savings`
- [ ] All existing `agentrail context query/search/def/callers/callees/impact` CLI contracts are unchanged (additive only — new commands only)
- [ ] Existing `agentrail context evaluate` retrieval quality gate fixture suite stays green
- [ ] All prior test suites stay green

## Test Plan

- `pytest tests/context/test_benchmark.py` — extended with `--compare-grep` column assertion; PR body must include printed results table with both columns
- New: `pytest tests/context/test_ast_search.py` — known fixture file + s-expression pattern; assert matching node names, line numbers, citations; assert denied source exclusion
- New: `pytest tests/context/test_git_commands.py` — `blame` with known fixture commit (assert author/sha fields); `history` on fixture file (assert commit count ≥ 1); `changed --since HEAD` on clean tree (assert empty list); `changed` with unstaged file (assert file appears)
- New: `pytest tests/context/test_savings.py` — assert `savings` returns non-negative integer; assert JSON schema when `--json` passed
- Manual: run `agentrail context ast "(function_definition name: (identifier) @fn)"` on this repo; verify output is non-empty and citations are correct

## Likely Issue Slices

- Implement `agentrail context ast` s-expression query runner (re-use cached parse trees from Milestone A; cold re-parse when tree not cached); house-schema output; denied source filtering
- Implement `agentrail context blame` git blame wrapper with line-range and house JSON output
- Implement `agentrail context history` git log wrapper with optional `-L` symbol filter and house JSON output
- Implement `agentrail context changed` git diff wrapper with `--since REF` and house JSON output
- Implement `agentrail context savings` reading `retrieval.py:173–210` runMetadata; per-session breakdown; JSON output
- Extend `agentrail context benchmark` with `--compare-grep` cost column
- Update `templates/scripts/context-first.sh` and `.agentrail/hooks/context-first.sh` denial messages
- Update `templates/AGENTS.md` Context Retrieval section
- Write `test_ast_search.py`, `test_git_commands.py`, `test_savings.py`; extend `test_benchmark.py` with `--compare-grep` assertion

## Blocked By

Milestone 018 (tree-sitter parse trees required for `ast` s-expression queries).

## Notes

- `ast` command on cold path re-parses the file on demand; no daemon required for correctness.
- `blame`, `history`, `changed` are thin `git` wrappers — they do not touch the index and do not require the daemon.
- `savings` reads existing telemetry; it does not introduce a new accounting mechanism.
- Hard-mode denial message update is a one-line shell change in two files; it must land in this milestone so agents know which commands to use as soon as they are available.
- `--compare-grep` benchmark column counts tokens consumed by grep-matching then reading the full matched file, vs tokens in the context-engine result — making the savings claim auditable.
